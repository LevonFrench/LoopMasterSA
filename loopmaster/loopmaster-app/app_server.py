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

# Fix DLL path for PyTorch on Windows
venv_site_packages = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")
torch_dll_path = os.path.join(venv_site_packages, "torch", "lib")
if os.path.exists(torch_dll_path):
    os.add_dll_directory(torch_dll_path)

import torch
import torchaudio
from flask import Flask, request, jsonify, send_from_directory, send_file, after_this_request

from stable_audio_3 import StableAudioModel
from stable_audio_3.verbose import set_verbose
from generation_executor import GenerationExecutor, GenerationRuntime, GenerationTask
from generation_queue import (
    GenerationCancelResult,
    GenerationQueue,
    GenerationQueueFull,
)
from job_history import JobHistory

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

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------

model = None
model_lock = threading.Lock()

job_history = JobHistory(OUTPUT_DIR, max_terminal=50)
jobs = job_history.recover()
jobs_lock = threading.Lock()

first_generation_completed = False

MAX_DURATION_SECONDS = 60.0
MAX_STEPS = 100
MAX_CFG_SCALE = 15.0
MAX_PADDING_SECONDS = 10.0
VALID_REMIX_MODES = {"variation", "inpaint", "response", "continuation"}
try:
    GENERATION_QUEUE_CAPACITY = max(
        1, int(os.environ.get("GENERATION_QUEUE_CAPACITY", "4"))
    )
except ValueError:
    GENERATION_QUEUE_CAPACITY = 4

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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


def parse_loop(value):
    """Accept JSON booleans and common form encodings without truthy-string bugs."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in {"true", "false"}:
        return value.lower() == "true"
    raise ValueError("loop must be a boolean")


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


def _save_variant_atomically(file_path, waveform, sample_rate, bpm, duration, is_loop, prompt, old_file_path=None):
    """Fully write and tag a same-directory temp WAV before publishing it."""
    temp_path = os.path.join(
        os.path.dirname(file_path),
        f".{os.path.basename(file_path)}.{uuid.uuid4().hex}.tmp.wav",
    )
    try:
        torchaudio.save(temp_path, waveform, sample_rate)
        acidize_wav_file(temp_path, bpm, duration, is_loop, prompt)
        os.replace(temp_path, file_path)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass

    if old_file_path and os.path.normcase(os.path.abspath(old_file_path)) != os.path.normcase(os.path.abspath(file_path)):
        try:
            os.remove(old_file_path)
        except FileNotFoundError:
            pass
        except OSError as error:
            print(f"[Generation] Error deleting replaced file {old_file_path}: {error}")

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
    )


def _register_job(job_id, job, allocate_track=False):
    """Create a job and durably publish its queued state through one seam."""
    with jobs_lock:
        if allocate_track:
            track_num = get_next_track_index()
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
    """Mutate in-memory state and persist only meaningful status transitions."""
    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return None
        previous_status = job.get("status")
        job.update(changes)
        current_status = job.get("status")
        snapshot = dict(job)
    if previous_status != current_status:
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
    global model
    print(f"Loading model '{model_name}'…")
    start = time.time()
    model = StableAudioModel.from_pretrained(
        model_name, device=device, model_half=not no_half
    )
    print(f"Model loaded in {time.time() - start:.2f}s")

def warmup_model():
    """Run a single dummy generation to trigger torch.compile graph compilation
    and CUDA kernel autotuning before any user request hits the server."""
    global model, first_generation_completed
    if model is None or str(model.device) != "cuda":
        print("Skipping warmup (no CUDA device).")
        return
    print("Running warmup generation to compile DiT graph…")
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
        print(f"Warmup completed in {time.time() - start:.1f}s. DiT graph compiled.")
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

    try:
        bpm = bounded_number(data, "bpm", 120, int, 40, 300)
        num_variants = bounded_number(data, "num_variants", 4, int, 1, 8)
        loop = parse_loop(data.get("loop", True))
        steps = bounded_number(data, "steps", 8, int, 1, MAX_STEPS)
        cfg_scale = bounded_number(data, "cfg_scale", 1.0, float, 0.0, MAX_CFG_SCALE)
        seed = bounded_number(data, "seed", -1, int, -1, 2_147_483_647)
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
        if remix_mode == "inpaint" and init_audio_path and inpaint_start >= inpaint_end:
            raise ValueError("inpaint_start must be before inpaint_end")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    job_id = uuid.uuid4().hex[:12]
    track_num = _register_job(job_id, {
        "status": "queued",
        "progress": "Waiting for the generation worker…",
        "error": None,
        "elapsed": None,
        "files": None,
        "prompt": prompt,
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
        track_num = bounded_number(data, "track_num", None, int, 1, 1_000_000)
        bpm = bounded_number(data, "bpm", 120, int, 40, 300)
        loop = parse_loop(data.get("loop", True))
        steps = bounded_number(data, "steps", 8, int, 1, MAX_STEPS)
        cfg_scale = bounded_number(data, "cfg_scale", 1.0, float, 0.0, MAX_CFG_SCALE)
        seed = bounded_number(data, "seed", -1, int, -1, 2_147_483_647)
        duration_padding_sec = bounded_number(data, "duration_padding_sec", 2.0 if loop else 0.0, float, 0.0, MAX_PADDING_SECONDS)
        duration = bounded_number(data, "duration", 960.0 / bpm, float, 1.0, MAX_DURATION_SECONDS)
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

    job_id = uuid.uuid4().hex[:12]
    _register_job(job_id, {
        "status": "queued",
        "progress": "Waiting for the generation worker…",
        "error": None,
        "elapsed": None,
        "files": None,
        "prompt": prompt,
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
            
        decoded_image = base64.b64decode(image_data)
        
        # Project root screenshots folder: j:/projects/sa3/screenshots
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

            @after_this_request
            def remove_file(response):
                try:
                    os.remove(output_path)
                except Exception as e:
                    print(f"Error removing temp file {output_path}: {e}")
                return response

            try:
                subprocess.run(["ffmpeg", "-y", "-i", input_path, "-q:a", quality_arg, output_path], check=True, timeout=120)
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
                err_msg = str(e)
                if isinstance(e, FileNotFoundError):
                    err_msg = "ffmpeg not found on PATH"
                return jsonify({"error": f"FFmpeg conversion failed: {err_msg}"}), 500
                
            return send_file(output_path, as_attachment=True, download_name=out_filename)

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
            @after_this_request
            def clean_temp_in(response):
                try:
                    os.remove(temp_in)
                except Exception as e:
                    print(f"Error removing temp file {temp_in}: {e}")
                return response
            return send_file(temp_in, as_attachment=True, download_name=uploaded_file.filename)

        out_name = os.path.splitext(uploaded_file.filename)[0] + f".{target_format}"
        temp_out = os.path.join(OUTPUT_DIR, f"temp_{uuid.uuid4().hex}.{target_format}")

        import subprocess
        # Use -q:a 2 for lame mp3, or -q:a 4 for vorbis ogg to ensure high quality
        quality_arg = "4" if target_format == "ogg" else "2"

        @after_this_request
        def clean_all(response):
            try:
                if os.path.exists(temp_in): os.remove(temp_in)
                if os.path.exists(temp_out): os.remove(temp_out)
            except Exception as e:
                print(f"Error cleaning temp files: {e}")
            return response

        try:
            subprocess.run(["ffmpeg", "-y", "-i", temp_in, "-q:a", quality_arg, temp_out], check=True, timeout=120)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as e:
            err_msg = str(e)
            if isinstance(e, FileNotFoundError):
                err_msg = "ffmpeg not found on PATH"
            return jsonify({"error": f"FFmpeg conversion failed: {err_msg}"}), 500

        return send_file(temp_out, as_attachment=True, download_name=out_name)

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

    args = parser.parse_args()
    set_verbose(args.verbose)

    load_model(args.model, args.device, args.no_half)
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
