"""
Stable Audio 3 — Grid Generator Backend (Pure Flask Server)
Ripped out Gradio dependencies to focus on custom web interface.
"""

import os
import sys
import re
import ntpath

os.environ["HF_HOME"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "huggingface"))
os.environ["TORCH_HOME"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "torch"))

# Overriding HF_HOME hides the user's login token (kept under
# ~/.cache/huggingface/token), which makes gated-repo lookups fail with 401
# even when the files are already in the project cache. Surface it explicitly.
if "HF_TOKEN" not in os.environ:
    _default_token_path = os.path.join(
        os.path.expanduser("~"), ".cache", "huggingface", "token"
    )
    if os.path.isfile(_default_token_path):
        try:
            with open(_default_token_path, encoding="utf-8") as _token_file:
                _token = _token_file.read().strip()
            if _token:
                os.environ["HF_TOKEN"] = _token
        except OSError:
            pass

# Add stable-audio-3 directory to system path to import stable_audio_3 module
current_dir = os.path.dirname(os.path.abspath(__file__))
sa3_dir = None
for _ in range(4):
    check_dir = os.path.join(current_dir, "stable-audio-3")
    if os.path.exists(check_dir) and os.path.isdir(check_dir):
        sa3_dir = check_dir
        break
    current_dir = os.path.dirname(current_dir)

if sa3_dir is None:
    # fallback to peer/parent structure
    parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    sa3_dir = os.path.join(parent_dir, "stable-audio-3")

if sa3_dir not in sys.path:
    sys.path.append(sa3_dir)

import uuid
import time
import threading
import argparse
import secrets

# Fix DLL path for PyTorch on Windows
venv_site_packages = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")
torch_dll_path = os.path.join(venv_site_packages, "torch", "lib")
if os.path.exists(torch_dll_path):
    os.add_dll_directory(torch_dll_path)

import torch
import torchaudio
from flask import Flask, request, jsonify, send_from_directory, send_file

from stable_audio_3 import StableAudioModel
from stable_audio_3.verbose import set_verbose
from generation_executor import (
    GenerationExecutor,
    GenerationRuntime,
    GenerationTask,
    ProgressionProvenance,
)
from generation_queue import (
    GenerationCancelResult,
    GenerationQueue,
    GenerationQueueFull,
)
from job_history import JobHistory
from kit_executor import KIT_PIECES, VELOCITIES, KitTask
from sliceable_registry import SliceableRegistry
from rate_limit import SlidingWindowRateLimiter
from asset_contract import (
    DEFAULT_DESCRIPTOR,
    DEFAULT_PACK,
    build_sidecar_document,
    derive_descriptor,
    finalize_sidecar_for_wav,
    normalize_key,
    parse_chord_track,
    sidecar_path_for,
    slug_token,
    validate_sidecar,
    write_sidecar,
)
from chord_progressions import (
    canonical_chord_events,
    condition_prompt,
    resolve_progression,
)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(SCRIPT_DIR, "static")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

SESSION_TIMESTAMP = time.strftime("%Y%m%d_%H%M%S")
SESSION_DIR_NAME = f"session_{SESSION_TIMESTAMP}"
SESSION_DIR = os.path.join(OUTPUT_DIR, SESSION_DIR_NAME)
os.makedirs(SESSION_DIR, exist_ok=True)


def _sweep_stale_temp_files():
    """Remove conversion temp files left behind by crashes or open-handle deletes."""
    for name in os.listdir(OUTPUT_DIR):
        if not (name.startswith(("conv_", "temp_")) or name.endswith(".tmp.wav")):
            continue
        path = os.path.join(OUTPUT_DIR, name)
        if os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass


_sweep_stale_temp_files()

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

model = None
loaded_model_name = "unknown"
model_lock = threading.Lock()

job_history = JobHistory(OUTPUT_DIR, max_terminal=50)
jobs = job_history.recover()
jobs_lock = threading.Lock()

sliceable_registry = SliceableRegistry(OUTPUT_DIR)

first_generation_completed = False

MAX_DURATION_SECONDS = 60.0
MAX_STEPS = 100
MAX_CFG_SCALE = 15.0
MAX_PADDING_SECONDS = 10.0
VALID_REMIX_MODES = {"variation", "inpaint", "response", "continuation"}
PROMPT_SECTION_KEYS = {
    "promptMode", "freePrompt", "acoustic", "electric", "drums", "genre", "harmony",
    "style", "mood", "negativePrompt", "modifiers", "sourceChoice",
    "characterChoice", "progressionKey", "progressionId", "progression",
    "chordTrack", "instrument", "production",
}
PROMPT_SOURCE_KEYS = ("acoustic", "electric", "drums")
PROMPT_LEGACY_SOURCE_KEYS = ("instrument",)
CHORD_PROGRESSOR_VALUE = "Use Chord Progressor"
try:
    GENERATION_QUEUE_CAPACITY = max(
        1, int(os.environ.get("GENERATION_QUEUE_CAPACITY", "4"))
    )
except ValueError:
    GENERATION_QUEUE_CAPACITY = 4
try:
    GENERATION_RATE_LIMIT = max(
        1, int(os.environ.get("GENERATION_RATE_LIMIT", "30"))
    )
except ValueError:
    GENERATION_RATE_LIMIT = 30
generation_rate_limiter = SlidingWindowRateLimiter(
    GENERATION_RATE_LIMIT,
    window_seconds=60,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def validate_prompt_sections(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("prompt_sections must be an object")
    unknown = set(value) - PROMPT_SECTION_KEYS
    if unknown:
        raise ValueError(f"Unknown prompt section: {sorted(unknown)[0]}")
    normalized = {}
    for key, section_value in value.items():
        if not isinstance(section_value, str):
            raise ValueError(f"prompt_sections.{key} must be text")
        max_length = 2000 if key == "freePrompt" else (
            4000 if key == "chordTrack" else 500
        )
        if len(section_value) > max_length:
            raise ValueError(
                f"prompt_sections.{key} must be {max_length} characters or fewer"
            )
        normalized[key] = section_value.strip()
    prompt_mode = normalized.get("promptMode", "")
    if prompt_mode and prompt_mode not in {"assembled", "manual"}:
        raise ValueError("prompt_sections.promptMode must be assembled or manual")
    return normalized


def compose_prompt_sections(sections):
    """Server-side mirror of PromptCore.composePrompt for payload validation."""
    values = validate_prompt_sections(sections)

    def clean(key):
        return " ".join(values.get(key, "").split())

    def free_prompt():
        return values.get("freePrompt", "").strip()

    prompt_mode = clean("promptMode")
    if prompt_mode == "manual":
        return free_prompt()

    source_choice = clean("sourceChoice")
    source = clean(source_choice) if source_choice in PROMPT_SOURCE_KEYS else ""
    if not source and source_choice not in PROMPT_SOURCE_KEYS:
        populated_sources = [
            clean(key) for key in PROMPT_SOURCE_KEYS if clean(key)
        ]
        if len(populated_sources) == 1:
            source = populated_sources[0]
    if not source:
        source = next(
            (clean(key) for key in PROMPT_LEGACY_SOURCE_KEYS if clean(key)),
            "",
        )
    character_choice = clean("characterChoice")
    mood = clean("mood") if (
        character_choice == "mood" or not character_choice
    ) else ""
    modifiers = clean("modifiers") if (
        character_choice == "modifiers" or not character_choice
    ) else ""
    head = " ".join(filter(None, (
        mood, clean("genre"), source, clean("style")
    )))
    harmony_value = clean("harmony")
    progressor_active = (
        harmony_value.lower() == CHORD_PROGRESSOR_VALUE.lower()
    )
    key_value = clean("progressionKey") if progressor_active else harmony_value
    harmony = f"in {key_value}" if key_value else ""
    lead = " ".join(filter(None, (head, harmony)))
    progression = ""
    if progressor_active:
        selection = clean("progression")
        if selection:
            separator = selection.rfind(":")
            if separator < 0:
                progression = f"four-chord {selection} progression"
            else:
                formula = " ".join(selection[:separator].split())
                mood_text = " ".join(selection[separator + 1:].split())
                progression = " ".join(filter(None, (
                    mood_text.lower(), "four-chord", formula, "progression"
                )))
    assembled = ", ".join(filter(None, (
        lead,
        progression,
        clean("production"),
        modifiers,
    )))
    if prompt_mode == "assembled":
        return assembled
    return ", ".join(filter(None, (clean("freePrompt"), assembled)))


def rate_limit_generation_request():
    allowed, retry_after = generation_rate_limiter.allow(request.remote_addr or "local")
    if allowed:
        return None
    response = jsonify({
        "error": "Generation rate limit reached. Try again shortly.",
        "retry_after": retry_after,
    })
    response.status_code = 429
    response.headers["Retry-After"] = str(retry_after)
    return response

def slugify_prompt(prompt, limit=16):
    """Sanitizes prompt and truncates it to limit characters for safe filenames."""
    cleaned = re.sub(r'[^a-zA-Z0-9\s_-]', '', prompt)
    cleaned = re.sub(r'[\s_-]+', '_', cleaned).strip('_')
    return cleaned[:limit]

def get_next_track_index():
    """Scans the current session outputs directory and returns the next sequential track index."""
    if not os.path.exists(SESSION_DIR):
        return 1
    max_idx = 0
    for name in os.listdir(SESSION_DIR):
        if name.startswith("track_") and os.path.isdir(os.path.join(SESSION_DIR, name)):
            try:
                idx = int(name.split("_")[1])
                if idx > max_idx:
                    max_idx = idx
            except (ValueError, IndexError):
                pass
    return max_idx + 1


def bounded_number(data, key, default, converter, minimum, maximum):
    """Parse a JSON number and keep it within the limits supported by the UI."""
    raw_value = data.get(key, default)
    if isinstance(raw_value, bool):
        raise ValueError(f"{key} must be a number")
    try:
        value = converter(raw_value)
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number") from None
    return max(minimum, min(maximum, value))


def _resolved_seed(requested_seed):
    """Resolve random requests here so every sidecar records a reproducible seed."""
    return secrets.randbelow(100_000) if requested_seed == -1 else requested_seed


def _parse_asset_request(data, prompt_sections, prompt, bpm, duration, loop):
    """Resolve filename metadata and any catalog-owned chord progression."""
    raw_pack = data.get("pack_name", DEFAULT_PACK)
    raw_descriptor = data.get("descriptor", "")
    raw_chords = data.get("chord_track", "")
    for field, value, maximum in (
        ("pack_name", raw_pack, 120),
        ("descriptor", raw_descriptor, 240),
        ("chord_track", raw_chords, 4000),
    ):
        if not isinstance(value, (str, list, tuple)) or (
            field != "chord_track" and not isinstance(value, str)
        ):
            raise ValueError(f"{field} has an invalid type")
        if isinstance(value, str) and len(value) > maximum:
            raise ValueError(f"{field} must be {maximum} characters or fewer")

    pack_name = slug_token(raw_pack, DEFAULT_PACK)
    descriptor = derive_descriptor(raw_descriptor, prompt_sections, prompt)
    bars = None
    if loop:
        exact_beats = float(duration) * float(bpm) / 60.0
        beats = int(round(exact_beats))
        if abs(exact_beats - beats) > 0.03:
            raise ValueError("duration must land within 0.03 beats of the BPM grid")
        if beats <= 0 or beats % 4:
            raise ValueError("loop duration must be a whole number of 4/4 bars")
        bars = beats // 4

    harmony = " ".join(str(prompt_sections.get("harmony", "")).split())
    progression_active = harmony.lower() == CHORD_PROGRESSOR_VALUE.lower()
    progression = None
    conditioned_prompt = None
    chord_source = None
    if progression_active:
        progression_id = prompt_sections.get("progressionId", "").strip()
        progression_key = prompt_sections.get("progressionKey", "").strip()
        if not progression_id:
            raise ValueError("Choose a chord progression preset")
        if not progression_key:
            raise ValueError("Choose a major or minor key for the chord progressor")
        if not loop:
            raise ValueError("Chord progressions require loop generation")

        progression = resolve_progression(progression_id, progression_key, bars)
        key_info = normalize_key(progression["key"])
        supplied_key = data.get("key")
        if supplied_key is not None and supplied_key != "":
            supplied_key_info = normalize_key(supplied_key)
            if supplied_key_info is None:
                raise ValueError("key must be a major or minor key")
            if supplied_key_info["token"] != key_info["token"]:
                raise ValueError("key conflicts with progressionKey")

        supplied_selection = " ".join(
            prompt_sections.get("progression", "").split()
        )
        if supplied_selection and supplied_selection != progression["selection"]:
            raise ValueError("progression conflicts with progressionId")

        full_chords = list(canonical_chord_events(progression))
        full_chord_echo = [
            {
                "bar": event["bar"],
                "beat": event["beat"],
                "chord": event["chord"],
            }
            for event in full_chords
        ]
        cycle_chords = [
            {"bar": index + 1, "beat": 1, "chord": event["chord"]}
            for index, event in enumerate(progression["cycle"])
        ]
        for field_name, chord_echo in (
            ("prompt_sections.chordTrack", prompt_sections.get("chordTrack", "")),
            ("chord_track", raw_chords),
        ):
            if (
                chord_echo is None
                or chord_echo == ""
                or chord_echo == []
                or chord_echo == ()
            ):
                continue
            echo = parse_chord_track(chord_echo, max(4, bars))
            if echo not in (cycle_chords, full_chord_echo):
                raise ValueError(f"{field_name} conflicts with progressionId")

        chords = full_chords
        chord_source = "prompt"
        conditioned_prompt = condition_prompt(prompt, progression)
    else:
        key_source = data.get("key")
        if key_source is None and isinstance(prompt_sections, dict):
            key_source = prompt_sections.get("harmony")
        key_info = normalize_key(key_source)
        chords = parse_chord_track(raw_chords, bars)

    if not loop and any(
        (entry["bar"], entry["beat"]) != (1, 1) for entry in chords
    ):
        raise ValueError("one-shot chord metadata can only start at bar 1 beat 1")
    return {
        "pack_name": pack_name,
        "descriptor": descriptor,
        "key": key_info["display"] if key_info else None,
        "chords": tuple(chords),
        "chord_source": chord_source,
        "conditioned_prompt": conditioned_prompt,
        "progression": progression,
        "bars": bars,
    }


def parse_loop(value):
    """Accept JSON booleans and common form encodings without truthy-string bugs."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    raise ValueError("loop must be a boolean")


def route_local_inference_steps(requested_steps, quality_tier="final", bulk=False):
    """Use compute tiers in this single-local-model app.

    There is no paid provider/model fan-out to route between. Draft and bulk
    work use the cheaper eight-step path; final work preserves the explicit
    user setting.
    """
    if quality_tier == "draft" or bulk:
        return min(requested_steps, 8)
    return requested_steps


def resolve_output_path(value, field_name="file path"):
    """Resolve a client-supplied relative path and keep it inside OUTPUT_DIR."""
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError(f"{field_name} must be a non-empty relative path")

    # Treat both slash styles as separators even when the server runs on POSIX.
    # ntpath also recognizes Windows drive-relative paths and UNC shares.
    portable_path = value.replace("\\", "/")
    drive, _ = ntpath.splitdrive(portable_path)
    parts = portable_path.split("/")
    if drive or portable_path.startswith("/") or any(part == ".." for part in parts):
        raise ValueError(f"Invalid {field_name}")

    output_root = os.path.realpath(os.path.abspath(OUTPUT_DIR))
    candidate = os.path.realpath(os.path.join(output_root, *parts))
    try:
        contained = os.path.normcase(os.path.commonpath([output_root, candidate])) == os.path.normcase(output_root)
    except ValueError:
        contained = False
    if not contained or candidate == output_root:
        raise ValueError(f"Invalid {field_name}")
    return candidate


def validate_init_audio_path(value):
    if value is None:
        return None
    full_path = resolve_output_path(value, "init_audio_path")
    output_root = os.path.realpath(os.path.abspath(OUTPUT_DIR))
    return os.path.relpath(full_path, output_root)


def _normalize_blend_indices(generated_length, seed_length, *indices):
    """Clamp blend extents to the samples shared by generated and seed audio."""
    shared_length = max(0, min(generated_length, seed_length))
    return shared_length, tuple(max(0, min(shared_length, index)) for index in indices)


def _remove_file_quietly(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _send_file_then_delete(path, download_name):
    """Send a temp file and delete it only after the response body is closed.

    ``after_this_request`` runs before the body streams; on Windows the open
    handle makes the delete fail silently, leaking the temp file. call_on_close
    fires after werkzeug closes the wrapped file, so the delete succeeds.
    """
    response = send_file(path, as_attachment=True, download_name=download_name)
    response.call_on_close(lambda: _remove_file_quietly(path))
    return response


def _save_variant_atomically(
    file_path,
    waveform,
    sample_rate,
    bpm,
    duration,
    is_loop,
    prompt,
    old_file_path=None,
    asset_metadata=None,
):
    """Publish one PCM16 WAV and its validated adjacent metadata sidecar."""
    temp_path = os.path.join(
        os.path.dirname(file_path),
        f".{os.path.basename(file_path)}.{uuid.uuid4().hex}.tmp.wav",
    )
    sidecar_path = sidecar_path_for(file_path)
    temp_sidecar_path = os.path.join(
        os.path.dirname(file_path),
        f".{os.path.basename(sidecar_path)}.{uuid.uuid4().hex}.tmp",
    )
    published_wav = False
    published_sidecar = False
    try:
        torchaudio.save(
            temp_path,
            waveform,
            sample_rate,
            encoding="PCM_S",
            bits_per_sample=16,
        )
        metadata = dict(asset_metadata or {})
        kind = "loop" if is_loop else "oneshot"
        document = build_sidecar_document(
            file_name=os.path.basename(file_path),
            waveform=waveform,
            sample_rate=sample_rate,
            bpm=bpm,
            kind=kind,
            pack=metadata.get("pack", DEFAULT_PACK),
            descriptor=metadata.get("descriptor", DEFAULT_DESCRIPTOR),
            variation=metadata.get("variation", "a1"),
            key=metadata.get("key"),
            chords=metadata.get("chords"),
            chord_source=metadata.get("chord_source"),
            generation=metadata.get("generation"),
            provenance=metadata.get("provenance"),
            created_at=metadata.get("created_at"),
        )
        acidize_wav_file(
            temp_path,
            bpm,
            duration,
            is_loop,
            prompt,
            metadata_document=document,
        )
        document = finalize_sidecar_for_wav(document, temp_path)
        write_sidecar(temp_sidecar_path, document)
        validate_sidecar(document)
        for attempt in range(5):
            try:
                os.replace(temp_path, file_path)
                published_wav = True
                break
            except PermissionError:
                # Windows: the destination may be held open by a reader
                # (e.g. the browser mid-download). Retry briefly.
                if attempt == 4:
                    raise
                time.sleep(0.3)
        os.replace(temp_sidecar_path, sidecar_path)
        published_sidecar = True
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
        if os.path.exists(temp_sidecar_path):
            try:
                os.remove(temp_sidecar_path)
            except OSError:
                pass
        if published_wav and not published_sidecar:
            # A half-published asset is worse than no asset: consumers treat
            # the sidecar as the complete source of truth.
            try:
                os.remove(file_path)
            except OSError:
                pass

    if old_file_path and os.path.normcase(os.path.abspath(old_file_path)) != os.path.normcase(os.path.abspath(file_path)):
        for old_path in (old_file_path, sidecar_path_for(old_file_path)):
            try:
                os.remove(old_path)
            except FileNotFoundError:
                pass
            except OSError as error:
                print(f"[Generation] Error deleting replaced file {old_path}: {error}")
    return document

# ---------------------------------------------------------------------------
# WAV Loop Metadata & Beat Grid Generation
# ---------------------------------------------------------------------------

from wav_metadata import (
    is_drum_prompt, parse_root_note, create_labl_chunk, create_adtl_list,
    pack_cue_chunk, find_data_chunk_offset, acidize_wav_file, enhance_prompt
)

def _is_generation_warm():
    return first_generation_completed


def _mark_generation_warm():
    global first_generation_completed
    first_generation_completed = True


def _make_generation_runtime():
    return GenerationRuntime(
        model=model,
        jobs=jobs,
        jobs_lock=jobs_lock,
        model_lock=model_lock,
        session_dir=SESSION_DIR,
        session_dir_name=SESSION_DIR_NAME,
        resolve_output_path=resolve_output_path,
        normalize_blend_indices=_normalize_blend_indices,
        save_variant_atomically=_save_variant_atomically,
        slugify_prompt=slugify_prompt,
        enhance_prompt=enhance_prompt,
        is_drum_prompt=is_drum_prompt,
        is_warm=_is_generation_warm,
        mark_warm=_mark_generation_warm,
        update_job=_mutate_job,
        prune_terminal_jobs=_prune_terminal_jobs,
        sliceable_registry=sliceable_registry,
    )


def _register_job(job_id, job, allocate_track=False):
    """Create a job and durably publish its queued state through one seam."""
    # Scan the session directory before taking the lock; the collision loop
    # below re-checks against in-flight jobs while the lock is held.
    next_track = get_next_track_index() if allocate_track else None
    with jobs_lock:
        if allocate_track:
            track_num = next_track
            active_tracks = [
                existing.get("track_num")
                for existing in jobs.values()
                if existing.get("status") in {"queued", "generating"}
            ]
            while track_num in active_tracks:
                track_num += 1
            job["track_num"] = track_num
        jobs[job_id] = job
        snapshot = dict(job)
    job_history.record(job_id, snapshot)
    return snapshot.get("track_num")


def _mutate_job(job_id, **changes):
    """Mutate a job, checkpointing transitions and explicit coarse stages."""
    force_persist = bool(changes.pop("_persist", False))
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return None
        previous_status = job.get("status")
        job.update(changes)
        current_status = job.get("status")
        snapshot = dict(job)
    if previous_status != current_status or force_persist:
        job_history.record(job_id, snapshot)
    return snapshot


def _remove_job(job_id):
    """Remove work rejected before queue admission from memory and history."""
    with jobs_lock:
        removed = jobs.pop(job_id, None)
    if removed is not None:
        job_history.remove(job_id)
    return removed


def _record_queue_worker_error(job_id, error):
    _mutate_job(
        job_id,
        status="error",
        progress=None,
        error=str(error),
        queue_position=None,
    )


def _prune_terminal_jobs_locked(retain=50):
    """Retain recent terminal records, including cancelled jobs.

    The caller must hold ``jobs_lock``. Cancellation records stay queryable in
    exactly the same bounded in-memory history as successful and failed jobs.
    """
    terminal_job_ids = [
        job_id
        for job_id, job in jobs.items()
        if job.get("status") in {"done", "error", "cancelled"}
    ]
    for terminal_job_id in terminal_job_ids[:-retain]:
        jobs.pop(terminal_job_id, None)


def _prune_terminal_jobs(retain=50):
    with jobs_lock:
        _prune_terminal_jobs_locked(retain=retain)


generation_executor = GenerationExecutor(_make_generation_runtime)
generation_queue = GenerationQueue(
    generation_executor.execute,
    capacity=GENERATION_QUEUE_CAPACITY,
    on_error=_record_queue_worker_error,
)
generation_queue.start()


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model(model_name, device=None, no_half=False):
    global model, loaded_model_name
    print(f"Loading model '{model_name}'…")
    start = time.time()
    model = StableAudioModel.from_pretrained(
        model_name, device=device, model_half=not no_half
    )
    loaded_model_name = model_name
    print(f"Model loaded in {time.time() - start:.2f}s")

def warmup_model():
    """Optionally prime CUDA kernels before serving the first user request."""
    global model, first_generation_completed
    if model is None or not str(model.device).startswith("cuda"):
        print("Skipping warmup (no CUDA device).")
        return
    print("Running optional CUDA warmup generation…")
    start = time.time()
    try:
        with torch.inference_mode():
            _ = model.generate(
                prompt="warmup test tone",
                duration=2.0,
                steps=2,
                cfg_scale=1.0,
                batch_size=1,
                seed=42,
                duration_padding_sec=0.0,
                truncate_output_to_duration=True,
            )
        first_generation_completed = True
        print(f"Warmup completed in {time.time() - start:.1f}s.")
    except Exception as e:
        print(f"Warmup failed (non-fatal): {e}")


# ---------------------------------------------------------------------------
# Flask App Setup & Routes
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024

@app.route("/")
@app.route("/grid")
def index_page():
    return send_from_directory(STATIC_DIR, "index.html")

@app.route("/static/<path:filename>")
def serve_static(filename):
    return send_from_directory(STATIC_DIR, filename)

@app.route("/outputs/<path:filename>")
def serve_output(filename):
    return send_from_directory(OUTPUT_DIR, filename)

@app.post("/api/generate")
def api_generate():
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400
    prompt_value = data.get("prompt", "")
    if not isinstance(prompt_value, str):
        return jsonify({"error": "Prompt must be text"}), 400
    prompt = prompt_value.strip()
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400
    if len(prompt) > 2000:
        return jsonify({"error": "Prompt must be 2000 characters or fewer"}), 400

    try:
        prompt_sections = validate_prompt_sections(data.get("prompt_sections"))
        if prompt_sections:
            expected_prompt = compose_prompt_sections(prompt_sections)
            if " ".join(prompt.split()) != " ".join(expected_prompt.split()):
                raise ValueError(
                    "prompt does not match the supplied structured sections"
                )
        negative_prompt = data.get("negative_prompt", "")
        if not isinstance(negative_prompt, str):
            raise ValueError("negative_prompt must be text")
        if len(negative_prompt) > 1000:
            raise ValueError("negative_prompt must be 1000 characters or fewer")
        negative_prompt = negative_prompt.strip()
        quality_tier = data.get("quality_tier", "final")
        if quality_tier not in {"draft", "final"}:
            raise ValueError("quality_tier must be draft or final")
        bpm = bounded_number(data, "bpm", 120, int, 40, 300)
        num_variants = bounded_number(data, "num_variants", 4, int, 1, 8)
        loop = parse_loop(data.get("loop", True))
        steps = bounded_number(data, "steps", 8, int, 1, MAX_STEPS)
        cfg_scale = bounded_number(data, "cfg_scale", 1.0, float, 0.0, MAX_CFG_SCALE)
        requested_seed = bounded_number(data, "seed", -1, int, -1, 2_147_483_647)
        seed = _resolved_seed(requested_seed)
        duration_padding_sec = bounded_number(data, "duration_padding_sec", 2.0 if loop else 0.0, float, 0.0, MAX_PADDING_SECONDS)
        duration = bounded_number(data, "duration", 960.0 / bpm, float, 1.0, MAX_DURATION_SECONDS)
        init_audio_path = validate_init_audio_path(data.get("init_audio_path"))
        init_noise_level = bounded_number(data, "init_noise_level", 0.6, float, 0.0, 1.0)
        remix_mode = data.get("remix_mode", "variation")
        if remix_mode not in VALID_REMIX_MODES:
            raise ValueError("remix_mode is invalid")
        inpaint_start = bounded_number(data, "inpaint_start", 0.0, float, 0.0, duration)
        inpaint_end = bounded_number(data, "inpaint_end", duration, float, 0.0, duration)
        continue_start = bounded_number(data, "continue_start", 0.0, float, 0.0, duration)
        invert_timing = parse_loop(data.get("invert_timing", False))
        sliceable = parse_loop(data.get("sliceable", False))
        if prompt_sections.get("negativePrompt") and not negative_prompt:
            negative_prompt = prompt_sections["negativePrompt"]
        steps = route_local_inference_steps(steps, quality_tier)
        asset = _parse_asset_request(
            data, prompt_sections, prompt, bpm, duration, loop
        )
        if remix_mode == "inpaint" and init_audio_path and inpaint_start >= inpaint_end:
            raise ValueError("inpaint_start must be before inpaint_end")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    limited_response = rate_limit_generation_request()
    if limited_response is not None:
        return limited_response

    job_id = uuid.uuid4().hex[:12]
    track_num = _register_job(job_id, {
        "status": "queued",
        "progress": "Waiting for the generation worker…",
        "error": None,
        "elapsed": None,
        "files": None,
        "prompt": prompt,
        "prompt_sections": prompt_sections,
        "quality_tier": quality_tier,
        "steps": steps,
        "seed": seed,
        "requested_seed": requested_seed,
        "asset": asset,
        "track_num": None,
        "queue_position": None,
    }, allocate_track=True)

    task = GenerationTask(
        job_id=job_id,
        prompt=prompt,
        bpm=bpm,
        duration=duration,
        loop=loop,
        steps=steps,
        cfg_scale=cfg_scale,
        track_num=track_num,
        num_variants=num_variants,
        duration_padding_sec=duration_padding_sec,
        init_audio_path=init_audio_path,
        init_noise_level=init_noise_level,
        seed=seed,
        remix_mode=remix_mode,
        inpaint_start=inpaint_start,
        inpaint_end=inpaint_end,
        continue_start=continue_start,
        invert_timing=invert_timing,
        sliceable=sliceable,
        negative_prompt=negative_prompt,
        prompt_sections=dict(prompt_sections),
        pack_name=asset["pack_name"],
        descriptor=asset["descriptor"],
        key=asset["key"],
        chords=asset["chords"],
        chord_source=asset["chord_source"],
        conditioned_prompt=asset["conditioned_prompt"],
        progression=(
            ProgressionProvenance.from_resolution(asset["progression"])
            if asset["progression"] is not None
            else None
        ),
        quality_tier=quality_tier,
        requested_seed=requested_seed,
        model_name=loaded_model_name,
    )
    try:
        generation_queue.submit(job_id, task)
    except GenerationQueueFull:
        _remove_job(job_id)
        return jsonify({
            "error": "Generation queue is full. Try again after a job finishes.",
            "queue_capacity": generation_queue.capacity,
        }), 429

    return jsonify({
        "job_id": job_id,
        "status": "queued",
        "queue_position": generation_queue.position(job_id),
    }), 202

@app.get("/api/kit_options")
def api_kit_options():
    """Piece and velocity vocabularies for the Kit Builder menu."""
    return jsonify({
        "pieces": [
            {"key": key, "label": noun, "duration": duration}
            for key, (noun, duration) in KIT_PIECES.items()
        ],
        "velocities": [
            {"key": key, "label": key.capitalize()}
            for key in VELOCITIES
        ],
    })


@app.get("/api/sliceable")
def api_sliceable():
    """Everything the future slicer can consume, one registry."""
    return jsonify(sliceable_registry.snapshot())


@app.post("/api/generate_kit")
def api_generate_kit():
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    style = data.get("style", "acoustic drum kit")
    kit_name = data.get("kit_name", "")
    if not isinstance(style, str) or not isinstance(kit_name, str):
        return jsonify({"error": "style and kit_name must be text"}), 400
    style = style.strip()[:200]
    kit_name = kit_name.strip()[:60]

    pieces_value = data.get("pieces", list(KIT_PIECES.keys()))
    if not isinstance(pieces_value, list):
        return jsonify({"error": "pieces must be a list"}), 400
    pieces = [p for p in pieces_value if isinstance(p, str) and p in KIT_PIECES]
    if not pieces:
        return jsonify({"error": "No valid kit pieces selected"}), 400

    velocities_value = data.get("velocities", list(VELOCITIES.keys()))
    if not isinstance(velocities_value, list):
        return jsonify({"error": "velocities must be a list"}), 400
    velocities = [v for v in velocities_value if isinstance(v, str) and v in VELOCITIES]
    if not velocities:
        return jsonify({"error": "No valid velocity layers selected"}), 400

    try:
        variations = bounded_number(data, "variations", 1, int, 1, 3)
        steps = route_local_inference_steps(
            bounded_number(data, "steps", 8, int, 1, MAX_STEPS),
            bulk=True,
        )
        cfg_scale = bounded_number(data, "cfg_scale", 1.0, float, 0.0, MAX_CFG_SCALE)
        requested_seed = bounded_number(data, "seed", -1, int, -1, 2_147_483_647)
        seed = _resolved_seed(requested_seed)
        sheet_hits = bounded_number(data, "sheet_hits", 6, int, 3, 12)
        include_sheets = parse_loop(data.get("include_sheets", False))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    limited_response = rate_limit_generation_request()
    if limited_response is not None:
        return limited_response

    job_id = uuid.uuid4().hex[:12]
    _register_job(job_id, {
        "status": "queued",
        "progress": "Waiting for the generation worker…",
        "error": None,
        "elapsed": None,
        "files": None,
        "kit": None,
        "prompt": f"[kit] {kit_name or style}",
        "track_num": None,
        "queue_position": None,
    })

    task = KitTask(
        job_id=job_id,
        kit_name=kit_name,
        style=style,
        pieces=tuple(pieces),
        velocities=tuple(velocities),
        variations=variations,
        steps=steps,
        cfg_scale=cfg_scale,
        seed=seed,
        include_sheets=include_sheets,
        sheet_hits=sheet_hits,
        requested_seed=requested_seed,
        model_name=loaded_model_name,
    )
    try:
        generation_queue.submit(job_id, task)
    except GenerationQueueFull:
        _remove_job(job_id)
        return jsonify({
            "error": "Generation queue is full. Try again after a job finishes.",
            "queue_capacity": generation_queue.capacity,
        }), 429

    return jsonify({
        "job_id": job_id,
        "status": "queued",
        "queue_position": generation_queue.position(job_id),
    }), 202


@app.post("/api/regenerate")
def api_regenerate():
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400
    prompt_value = data.get("prompt", "")
    if not isinstance(prompt_value, str):
        return jsonify({"error": "Prompt must be text"}), 400
    prompt = prompt_value.strip()
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400

    try:
        prompt_sections = validate_prompt_sections(data.get("prompt_sections"))
        if prompt_sections:
            expected_prompt = compose_prompt_sections(prompt_sections)
            if " ".join(prompt.split()) != " ".join(expected_prompt.split()):
                raise ValueError(
                    "prompt does not match the supplied structured sections"
                )
        track_num = bounded_number(data, "track_num", None, int, 1, 1_000_000)
        bpm = bounded_number(data, "bpm", 120, int, 40, 300)
        loop = parse_loop(data.get("loop", True))
        steps = bounded_number(data, "steps", 8, int, 1, MAX_STEPS)
        cfg_scale = bounded_number(data, "cfg_scale", 1.0, float, 0.0, MAX_CFG_SCALE)
        requested_seed = bounded_number(data, "seed", -1, int, -1, 2_147_483_647)
        seed = _resolved_seed(requested_seed)
        duration_padding_sec = bounded_number(data, "duration_padding_sec", 2.0 if loop else 0.0, float, 0.0, MAX_PADDING_SECONDS)
        duration = bounded_number(data, "duration", 960.0 / bpm, float, 1.0, MAX_DURATION_SECONDS)
        negative_prompt = data.get("negative_prompt", "")
        if not isinstance(negative_prompt, str) or len(negative_prompt) > 1000:
            raise ValueError("negative_prompt must be text up to 1000 characters")
        quality_tier = data.get("quality_tier", "final")
        if quality_tier not in {"draft", "final"}:
            raise ValueError("quality_tier must be draft or final")
        steps = route_local_inference_steps(steps, quality_tier)
        asset = _parse_asset_request(
            data, prompt_sections, prompt, bpm, duration, loop
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    
    unlocked_indices = data.get("unlocked_indices", [])
    if not isinstance(unlocked_indices, list) or not unlocked_indices:
        return jsonify({"error": "No unlocked indices provided"}), 400
    try:
        unlocked_indices = sorted({int(index) for index in unlocked_indices})
    except (TypeError, ValueError):
        return jsonify({"error": "unlocked_indices must contain integers"}), 400
    if any(index < 0 or index >= 4 for index in unlocked_indices):
        return jsonify({"error": "unlocked_indices must be between 0 and 3"}), 400

    limited_response = rate_limit_generation_request()
    if limited_response is not None:
        return limited_response

    job_id = uuid.uuid4().hex[:12]
    _register_job(job_id, {
        "status": "queued",
        "progress": "Waiting for the generation worker…",
        "error": None,
        "elapsed": None,
        "files": None,
        "prompt": prompt,
        "prompt_sections": prompt_sections,
        "quality_tier": quality_tier,
        "steps": steps,
        "seed": seed,
        "requested_seed": requested_seed,
        "asset": asset,
        "track_num": track_num,
        "queue_position": None,
    })

    task = GenerationTask(
        job_id=job_id,
        prompt=prompt,
        bpm=bpm,
        duration=duration,
        loop=loop,
        steps=steps,
        cfg_scale=cfg_scale,
        track_num=track_num,
        unlocked_indices=tuple(unlocked_indices),
        duration_padding_sec=duration_padding_sec,
        seed=seed,
        negative_prompt=negative_prompt.strip(),
        prompt_sections=dict(prompt_sections),
        pack_name=asset["pack_name"],
        descriptor=asset["descriptor"],
        key=asset["key"],
        chords=asset["chords"],
        chord_source=asset["chord_source"],
        conditioned_prompt=asset["conditioned_prompt"],
        progression=(
            ProgressionProvenance.from_resolution(asset["progression"])
            if asset["progression"] is not None
            else None
        ),
        quality_tier=quality_tier,
        requested_seed=requested_seed,
        model_name=loaded_model_name,
    )
    try:
        generation_queue.submit(job_id, task)
    except GenerationQueueFull:
        _remove_job(job_id)
        return jsonify({
            "error": "Generation queue is full. Try again after a job finishes.",
            "queue_capacity": generation_queue.capacity,
        }), 429

    return jsonify({
        "job_id": job_id,
        "status": "queued",
        "queue_position": generation_queue.position(job_id),
    }), 202

@app.route("/status")
def server_status():
    return "OK", 200

@app.route("/api/status/<job_id>")
def api_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
        response = dict(job) if job is not None else None
    if response is None:
        return jsonify({"error": "Unknown job"}), 404
    queue_state = generation_queue.snapshot()
    response["queue_position"] = generation_queue.position(job_id)
    response["queue_depth"] = queue_state["queue_depth"]
    response["queue_capacity"] = queue_state["capacity"]
    response["active_job_id"] = queue_state["active_job_id"]
    return jsonify(response)


@app.post("/api/cancel/<job_id>")
def api_cancel(job_id):
    """Cancel only work that is still waiting in the generation queue."""
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return jsonify({
                "error": "Unknown job",
                "job_id": job_id,
                "cancelled": False,
            }), 404
        status = job.get("status", "unknown")

    result = generation_queue.cancel(job_id)
    if result is GenerationCancelResult.CANCELLED:
        _mutate_job(
            job_id,
            status="cancelled",
            progress=None,
            error=None,
            queue_position=None,
        )
        _prune_terminal_jobs()
        return jsonify({
            "job_id": job_id,
            "status": "cancelled",
            "cancelled": True,
        }), 200

    with jobs_lock:
        current_job = jobs.get(job_id)
        status = current_job.get("status", status) if current_job else status

    if status == "cancelled":
        return jsonify({
            "job_id": job_id,
            "status": "cancelled",
            "cancelled": False,
            "reason": "already_cancelled",
        }), 200

    if result is GenerationCancelResult.RUNNING:
        return jsonify({
            "error": "Job is already running and cannot be cancelled",
            "job_id": job_id,
            "status": "generating",
            "cancelled": False,
        }), 409

    return jsonify({
        "error": "Job is no longer pending and cannot be cancelled",
        "job_id": job_id,
        "status": status,
        "cancelled": False,
    }), 409

@app.route("/api/delete_track/<int:track_num>", methods=["POST"])
def api_delete_track(track_num):
    track_dir = os.path.join(SESSION_DIR, f"track_{track_num}")
    if os.path.exists(track_dir) and os.path.isdir(track_dir):
        try:
            import shutil
            shutil.rmtree(track_dir)
            sliceable_registry.remove_prefix(f"{SESSION_DIR_NAME}/track_{track_num}")
            print(f"Deleted track directory: {track_dir}")
            return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Track not found"}), 404

@app.post("/api/delete_variant")
def api_delete_variant():
    data = request.json or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400
    file_path = data.get("file_path")
    if not file_path:
        return jsonify({"error": "File path is required"}), 400

    try:
        full_path = resolve_output_path(file_path)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    if os.path.exists(full_path) and os.path.isfile(full_path):
        try:
            os.remove(full_path)
            metadata_path = sidecar_path_for(full_path)
            try:
                os.remove(metadata_path)
            except FileNotFoundError:
                pass
            sliceable_registry.remove(file_path.replace("\\", "/"))
            print(f"Deleted variant file: {full_path}")
            return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "File not found"}), 404

@app.post("/api/screenshot")
def api_screenshot():
    import base64
    try:
        data = request.json or {}
        image_data = data.get("image")
        if not image_data:
            return jsonify({"error": "Image data is required"}), 400
        
        if "," in image_data:
            image_data = image_data.split(",", 1)[1]

        if len(image_data) > 32 * 1024 * 1024:
            return jsonify({"error": "Screenshot payload too large"}), 413

        decoded_image = base64.b64decode(image_data)

        # Project root screenshots folder: <repo>/screenshots
        project_root = os.path.dirname(os.path.dirname(SCRIPT_DIR))
        screenshots_dir = os.path.join(project_root, "screenshots")
        os.makedirs(screenshots_dir, exist_ok=True)
        
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"screenshot_{timestamp}.png"
        filepath = os.path.join(screenshots_dir, filename)
        
        with open(filepath, "wb") as f:
            f.write(decoded_image)
            
        print(f"Saved screenshot: {filepath}")
        return jsonify({"status": "success", "filename": filename, "path": filepath})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.post("/api/convert")
def api_convert():
    try:
        target_format = request.form.get("format", "wav").lower()
        if target_format not in ["mp3", "ogg", "wav"]:
            return jsonify({"error": f"Unsupported format: {target_format}"}), 400

        # Case A: Local file path on the server
        file_path = request.form.get("file_path")
        if file_path:
            try:
                input_path = resolve_output_path(file_path)
            except ValueError as error:
                return jsonify({"error": str(error)}), 400

            if not os.path.isfile(input_path):
                return jsonify({"error": "File not found"}), 404

            if target_format == "wav":
                return send_file(input_path, as_attachment=True, download_name=os.path.basename(input_path))
                
            out_filename = os.path.splitext(os.path.basename(input_path))[0] + f".{target_format}"
            output_path = os.path.join(OUTPUT_DIR, f"conv_{uuid.uuid4().hex}.{target_format}")

            # Run ffmpeg
            import subprocess
            quality_arg = "4" if target_format == "ogg" else "2"

            try:
                subprocess.run(["ffmpeg", "-y", "-i", input_path, "-q:a", quality_arg, output_path], check=True, timeout=120)
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
                _remove_file_quietly(output_path)
                err_msg = str(e)
                if isinstance(e, FileNotFoundError):
                    err_msg = "ffmpeg not found on PATH"
                return jsonify({"error": f"FFmpeg conversion failed: {err_msg}"}), 500

            return _send_file_then_delete(output_path, out_filename)

        # Case B: Uploaded file
        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
            
        uploaded_file = request.files["file"]
        if uploaded_file.filename == "":
            return jsonify({"error": "No selected file"}), 400

        # Save to temp WAV file
        temp_in = os.path.join(OUTPUT_DIR, f"temp_{uuid.uuid4().hex}.wav")
        uploaded_file.save(temp_in)

        if target_format == "wav":
            return _send_file_then_delete(temp_in, uploaded_file.filename)

        out_name = os.path.splitext(uploaded_file.filename)[0] + f".{target_format}"
        temp_out = os.path.join(OUTPUT_DIR, f"temp_{uuid.uuid4().hex}.{target_format}")

        import subprocess
        # Use -q:a 2 for lame mp3, or -q:a 4 for vorbis ogg to ensure high quality
        quality_arg = "4" if target_format == "ogg" else "2"

        try:
            subprocess.run(["ffmpeg", "-y", "-i", temp_in, "-q:a", quality_arg, temp_out], check=True, timeout=120)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
            _remove_file_quietly(temp_in)
            _remove_file_quietly(temp_out)
            err_msg = str(e)
            if isinstance(e, FileNotFoundError):
                err_msg = "ffmpeg not found on PATH"
            return jsonify({"error": f"FFmpeg conversion failed: {err_msg}"}), 500

        _remove_file_quietly(temp_in)
        return _send_file_then_delete(temp_out, out_name)

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stable Audio 3 Grid Generator Server")
    parser.add_argument(
        "--model", default="small-music",
        choices=["medium", "medium-bf16", "small-music", "small-sfx", "medium-base", "small-music-base", "small-sfx-base"],
    )
    parser.add_argument("--device", default=None)
    parser.add_argument("--no-half", action="store_true")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="Run a dummy generation before opening the HTTP server",
    )

    args = parser.parse_args()
    set_verbose(args.verbose)

    load_model(args.model, args.device, args.no_half)
    if args.warmup:
        warmup_model()

    try:
        print(f"\n  [OK] Grid Generator running at http://127.0.0.1:{args.port}\n")
        app.run(host=args.host, port=args.port, debug=False, threaded=True)
    except OSError as e:
        if 'EADDRINUSE' in str(e) or 'WinError 10048' in str(e) or 'address already in use' in str(e).lower():
            print(f"\n[ERROR] Port {args.port} is already in use. Is LoopMaster Optimized already running? Close it first.\n")
            import sys
            sys.exit(1)
        raise
