"""Stable Audio generation pipeline, isolated from HTTP and queue concerns."""

from dataclasses import dataclass
import os
import re
import time
import traceback

import torch
import torchaudio

from asset_contract import (
    build_asset_filename,
    musical_grid,
    sidecar_path_for,
    variation_slot,
)
from kit_executor import KitTask, execute_kit_task
from fanout import run_parallel_fanout


DEFAULT_NEGATIVE_PROMPT = (
    "poor quality, bad quality, low quality, noise, distortion, artifact"
)


def effective_negative_prompt(user_prompt=""):
    """Return the exact negative prompt sent to the model and stored in metadata."""
    return ", ".join(filter(None, (
        DEFAULT_NEGATIVE_PROMPT,
        str(user_prompt or "").strip(),
    )))


@dataclass(frozen=True)
class ProgressionProvenance:
    """Immutable server resolution carried from admission through publishing."""

    catalog_id: str
    catalog_version: int
    key: str
    mode: str
    mood: str
    formula: str
    selection: str
    cycle_bars: int
    cycle: tuple
    events: tuple

    @classmethod
    def from_resolution(cls, resolution):
        cycle = tuple(
            (
                int(event["slot"]),
                str(event["roman"]),
                str(event["chord"]),
                str(event["symbol"]),
                tuple(int(offset) for offset in event.get("formulaOffsets", ())),
                event.get("bass"),
                event.get("bassOffset"),
            )
            for event in resolution.get("cycle", ())
        )
        events = tuple(
            (
                int(event["bar"]),
                int(event["beat"]),
                str(event["roman"]),
                str(event["chord"]),
                str(event["symbol"]),
                tuple(int(offset) for offset in event.get("formulaOffsets", ())),
                event.get("bass"),
                event.get("bassOffset"),
            )
            for event in resolution.get("events", ())
        )
        if len(cycle) != 4 or not events:
            raise ValueError("Progression provenance requires a four-chord cycle")
        return cls(
            catalog_id=str(resolution["catalogId"]),
            catalog_version=int(resolution["catalogVersion"]),
            key=str(resolution["key"]),
            mode=str(resolution["mode"]),
            mood=str(resolution["mood"]),
            formula=str(resolution["formula"]),
            selection=str(resolution["selection"]),
            cycle_bars=int(resolution["cycleBars"]),
            cycle=cycle,
            events=events,
        )

    def as_dict(self):
        return {
            "catalogId": self.catalog_id,
            "catalogVersion": self.catalog_version,
            "key": self.key,
            "mode": self.mode,
            "mood": self.mood,
            "formula": self.formula,
            "selection": self.selection,
            "cycleBars": self.cycle_bars,
            "cycle": [
                {
                    "slot": slot,
                    "roman": roman,
                    "chord": chord,
                    "symbol": symbol,
                    "bass": bass,
                    "bassOffset": bass_offset,
                    "formulaOffsets": list(formula_offsets),
                }
                for (
                    slot, roman, chord, symbol, formula_offsets, bass,
                    bass_offset,
                ) in self.cycle
            ],
            "events": [
                {
                    "bar": bar,
                    "beat": beat,
                    "roman": roman,
                    "chord": chord,
                    "symbol": symbol,
                    "formulaOffsets": list(formula_offsets),
                    "bass": bass,
                    "bassOffset": bass_offset,
                }
                for (
                    bar, beat, roman, chord, symbol, formula_offsets, bass,
                    bass_offset,
                )
                in self.events
            ],
        }


@dataclass(frozen=True)
class GenerationTask:
    job_id: str
    prompt: str
    bpm: int
    duration: float
    loop: bool
    steps: int
    cfg_scale: float
    track_num: int
    num_variants: int = 4
    unlocked_indices: tuple | None = None
    duration_padding_sec: float = 0.0
    init_audio_path: str | None = None
    init_noise_level: float = 0.6
    seed: int = -1
    remix_mode: str = "variation"
    inpaint_start: float = 0.0
    inpaint_end: float = 0.0
    continue_start: float = 0.0
    invert_timing: bool = False
    sliceable: bool = False
    negative_prompt: str = ""
    prompt_sections: dict | None = None
    pack_name: str = "loopmaster"
    descriptor: str = "loop"
    key: str | None = None
    chords: tuple = ()
    chord_source: str | None = None
    conditioned_prompt: str | None = None
    progression: ProgressionProvenance | None = None
    quality_tier: str = "final"
    requested_seed: int = -1
    model_name: str = "unknown"


@dataclass(frozen=True)
class GenerationRuntime:
    model: object
    jobs: dict
    jobs_lock: object
    model_lock: object
    session_dir: str
    session_dir_name: str
    resolve_output_path: object
    normalize_blend_indices: object
    save_variant_atomically: object
    slugify_prompt: object
    enhance_prompt: object
    is_drum_prompt: object
    is_warm: object
    mark_warm: object
    update_job: object
    prune_terminal_jobs: object
    sliceable_registry: object = None


class GenerationExecutor:
    """Small queue-facing interface around the generation pipeline."""

    def __init__(self, runtime_factory):
        self._runtime_factory = runtime_factory

    def execute(self, task):
        if isinstance(task, KitTask):
            execute_kit_task(task, self._runtime_factory())
        else:
            execute_generation_task(task, self._runtime_factory())


def _update_job(runtime, job_id, **changes):
    runtime.update_job(job_id, **changes)


def _prune_completed_jobs(runtime, retain=50):
    runtime.prune_terminal_jobs(retain=retain)


def _prepare_prompts(task, runtime):
    target_indices = (
        list(task.unlocked_indices)
        if task.unlocked_indices is not None
        else list(range(task.num_variants))
    )
    model_prompt = task.conditioned_prompt or task.prompt
    final_prompt = runtime.enhance_prompt(
        model_prompt, task.bpm, task.duration, task.loop
    )
    is_drum = runtime.is_drum_prompt(task.prompt)
    prompts = []
    for target_idx in target_indices:
        if target_idx == 3 and is_drum and task.progression is None:
            fill_prompt = runtime.enhance_prompt(
                model_prompt, task.bpm, task.duration, loop=False
            )
            replacements = (
                (r"\bseamless loop\b", "drum fill, drum roll"),
                (r"\blooping\b", "transition"),
                (r"\bloop\b", "fill"),
                (r"\bbreakbeats?\b", "drum fill"),
                (r"\bbeats?\b", "fill"),
            )
            for pattern, replacement in replacements:
                fill_prompt = re.sub(
                    pattern, replacement, fill_prompt, flags=re.IGNORECASE
                )
            if "fill" not in fill_prompt.lower():
                fill_prompt += ", drum fill, transition fill"
            prompts.append(fill_prompt)
        else:
            prompts.append(final_prompt)

    print(f"\n[Prompt Enhancement] Original: '{task.prompt}'")
    if model_prompt != task.prompt:
        print(f"[Prompt Enhancement] Conditioned: '{model_prompt}'")
    for index, target_idx in enumerate(target_indices):
        print(
            f"[Prompt Enhancement] Variant {target_idx + 1} "
            f"Enhanced: '{prompts[index]}'"
        )
    print()
    return target_indices, final_prompt, is_drum, prompts


def _load_seed_audio(task, runtime, generation_duration):
    if not task.init_audio_path:
        return None, None, None

    full_path = runtime.resolve_output_path(task.init_audio_path, "init_audio_path")
    if not os.path.isfile(full_path):
        raise FileNotFoundError(
            f"Seed audio file was not found: {task.init_audio_path}"
        )
    try:
        waveform, sample_rate = torchaudio.load(full_path)
        if task.invert_timing:
            waveform = torch.flip(waveform, dims=[-1])
            print(
                "[Seed Audio] Inverted timing/progression "
                f"(reversed waveform along time dimension) for {full_path}."
            )

        if task.remix_mode in {"inpaint", "response", "continuation"}:
            current_samples = waveform.shape[1]
            target_samples = int(generation_duration * sample_rate)
            if current_samples < target_samples:
                padding = torch.zeros(
                    (waveform.shape[0], target_samples - current_samples),
                    dtype=waveform.dtype,
                )
                waveform = torch.cat([waveform, padding], dim=-1)
                print(
                    f"[Seed Audio] Padded seed audio from {current_samples} "
                    f"to {target_samples} samples ({generation_duration}s) "
                    f"for mode '{task.remix_mode}'."
                )

        # Keep a normal float32 CPU copy for post-generation blending.  The
        # model input may be FP16/CUDA, but torchaudio's CPU resampler and the
        # decoded waveform should share float32 dtype.
        blend_waveform = waveform.to(device="cpu", dtype=torch.float32)
        model_waveform = waveform
        if runtime.model.model_half:
            model_waveform = model_waveform.half()
        model_waveform = model_waveform.to(runtime.model.device)
        print(
            f"[Seed Audio] Loaded {full_path} successfully on device "
            f"{runtime.model.device} for mode '{task.remix_mode}'."
        )
        return (sample_rate, model_waveform), blend_waveform, sample_rate
    except Exception as error:
        raise RuntimeError(
            f"Could not load seed audio '{task.init_audio_path}': {error}"
        ) from error


def _generate_audio(task, runtime, prompts, seed_audio, padding_sec, target_indices=None):
    def progress_callback(info):
        if "stage" in info:
            stage_messages = {
                "vae_start": "Decoding audio latents using VAE…",
                "vae_end": "VAE decoding completed…",
            }
            if info["stage"] == "vae_variant":
                message = (
                    "Decoding VAE variant "
                    f"{info.get('completed', 0)}/{info.get('total', 0)}…"
                )
            else:
                message = stage_messages.get(
                    info["stage"], f"Stage: {info['stage']}…"
                )
        else:
            step = info.get("i", 0)
            percent = int((step + 1) / task.steps * 100)
            message = (
                f"Generating diffusion model (step {step + 1}/{task.steps} "
                f"- {percent}%)…"
            )
        _update_job(
            runtime,
            task.job_id,
            progress=message,
            # Diffusion step updates stay memory-only; coarse VAE checkpoints
            # survive a native CUDA/driver process crash for diagnosis.
            _persist="stage" in info,
        )

    kwargs = {
        "prompt": prompts,
        # Local quality-guard convention — NOT from the SA3 prompting guide
        # (which gives no negative-prompt guidance at all).
        "negative_prompt": effective_negative_prompt(task.negative_prompt),
        "duration": task.duration,
        "steps": task.steps,
        "cfg_scale": task.cfg_scale,
        "batch_size": len(prompts),
        "seed": task.seed,
        # Per-variant seed streams: variant N re-rolled alone reproduces the
        # variant N that was generated in the original batch.
        "seed_offsets": list(target_indices) if target_indices is not None else None,
        "duration_padding_sec": padding_sec,
        "truncate_output_to_duration": False,
        "callback": progress_callback,
        "chunked_decode": True,
    }

    if seed_audio is not None:
        if task.remix_mode == "variation":
            kwargs["init_audio"] = seed_audio
            kwargs["init_noise_level"] = task.init_noise_level
            print(
                f"[Generation] Running variation with noise level "
                f"{task.init_noise_level}."
            )
        elif task.remix_mode in {"inpaint", "response"}:
            kwargs["inpaint_audio"] = seed_audio
            overlap_sec = 0.3
            if task.remix_mode == "response":
                mask_start = max(0.0, (task.duration / 2.0) - overlap_sec)
                mask_end = task.duration + 10.0
                print(
                    f"[Generation] Running Call & Response. Masking "
                    f"{mask_start}s to {mask_end}s (overlap: {overlap_sec}s)."
                )
            else:
                mask_start = max(0.0, task.inpaint_start - overlap_sec)
                mask_end = min(task.duration, task.inpaint_end + overlap_sec)
                print(
                    f"[Generation] Running inpaint with range {mask_start}s "
                    f"to {mask_end}s (overlap: {overlap_sec}s)."
                )
            kwargs["inpaint_mask_start_seconds"] = mask_start
            kwargs["inpaint_mask_end_seconds"] = mask_end
        elif task.remix_mode == "continuation":
            kwargs["inpaint_audio"] = seed_audio
            overlap_sec = 0.3
            mask_start = max(0.0, task.continue_start - overlap_sec)
            kwargs["inpaint_mask_start_seconds"] = mask_start
            kwargs["inpaint_mask_end_seconds"] = (
                max(task.duration, task.duration + padding_sec) + 10.0
            )
            print(
                f"[Generation] Running continuation keeping first {mask_start}s "
                f"(overlap: {overlap_sec}s)."
            )

    with runtime.model_lock:
        with torch.inference_mode():
            decoded_audio = runtime.model.generate(**kwargs)
            # Keep the large post-VAE materialization off the GPU.  The
            # returned tensor is still an inference tensor, so clone it after
            # leaving InferenceMode before the loop/remix code mutates it.
            inference_audio_cpu = decoded_audio.to(
                device="cpu", dtype=torch.float32
            )
            del decoded_audio
            runtime.mark_warm()
    return inference_audio_cpu.clone()


def _fit_audio_duration(audio, duration, sample_rate, loop):
    exact_samples = int(duration * sample_rate)
    if loop and audio.shape[-1] > exact_samples:
        tail = audio[..., exact_samples:]
        mix_len = min(tail.shape[-1], exact_samples)
        audio[..., :mix_len] += tail[..., :mix_len]

    if audio.shape[-1] > exact_samples:
        return audio[..., :exact_samples]
    if audio.shape[-1] < exact_samples:
        padding = torch.zeros(
            (*audio.shape[:-1], exact_samples - audio.shape[-1]),
            device=audio.device,
            dtype=audio.dtype,
        )
        return torch.cat([audio, padding], dim=-1)
    return audio


def _blend_seed_boundaries(task, runtime, audio, waveform, seed_sample_rate):
    if not task.init_audio_path or task.remix_mode not in {
        "continuation",
        "response",
        "inpaint",
    }:
        return

    try:
        import torchaudio.transforms as transforms

        output_sample_rate = runtime.model.model.sample_rate
        if seed_sample_rate != output_sample_rate:
            resampler = transforms.Resample(
                seed_sample_rate, output_sample_rate
            ).to(device=audio.device, dtype=audio.dtype)
            original = resampler(
                waveform.to(device=audio.device, dtype=audio.dtype)
            )
        else:
            original = waveform.to(device=audio.device, dtype=audio.dtype)

        if original.ndim == 2:
            if original.shape[0] == 1 and audio.shape[1] == 2:
                original = original.repeat(2, 1)
            elif original.shape[0] > 2:
                original = original[:2, :]

        overlap_sec = 0.3
        original_length = original.shape[1]
        generated_length = audio.shape[2]
        normalize = runtime.normalize_blend_indices

        if task.remix_mode in {"continuation", "response"}:
            boundary_sec = (
                task.continue_start
                if task.remix_mode == "continuation"
                else task.duration / 2.0
            )
            mask_start_sec = max(0.0, boundary_sec - overlap_sec)
            _, (boundary, mask_start) = normalize(
                generated_length,
                original_length,
                int(boundary_sec * output_sample_rate),
                int(mask_start_sec * output_sample_rate),
            )
            overlap_samples = boundary - mask_start
            if overlap_samples > 0:
                weight = torch.linspace(
                    0.0,
                    1.0,
                    steps=overlap_samples,
                    device=audio.device,
                    dtype=audio.dtype,
                ).unsqueeze(0)
                for index in range(audio.shape[0]):
                    audio[index, :, :mask_start] = original[:, :mask_start]
                    original_segment = original[:, mask_start:boundary]
                    generated_segment = audio[index, :, mask_start:boundary]
                    audio[index, :, mask_start:boundary] = (
                        (1.0 - weight) * original_segment
                        + weight * generated_segment
                    )
            return

        mask_start_sec = max(0.0, task.inpaint_start - overlap_sec)
        mask_end_sec = min(task.duration, task.inpaint_end + overlap_sec)
        blend_length, indices = normalize(
            generated_length,
            original_length,
            int(task.inpaint_start * output_sample_rate),
            int(mask_start_sec * output_sample_rate),
            int(task.inpaint_end * output_sample_rate),
            int(mask_end_sec * output_sample_rate),
        )
        boundary1, mask_start, boundary2, mask_end = indices
        overlap1 = boundary1 - mask_start
        overlap2 = mask_end - boundary2
        for index in range(audio.shape[0]):
            audio[index, :, :mask_start] = original[:, :mask_start]
            if overlap1 > 0:
                weight1 = torch.linspace(
                    0.0, 1.0, steps=overlap1, device=audio.device,
                    dtype=audio.dtype,
                ).unsqueeze(0)
                audio[index, :, mask_start:boundary1] = (
                    (1.0 - weight1) * original[:, mask_start:boundary1]
                    + weight1 * audio[index, :, mask_start:boundary1]
                )
            if overlap2 > 0:
                weight2 = torch.linspace(
                    0.0, 1.0, steps=overlap2, device=audio.device,
                    dtype=audio.dtype,
                ).unsqueeze(0)
                audio[index, :, boundary2:mask_end] = (
                    (1.0 - weight2) * audio[index, :, boundary2:mask_end]
                    + weight2 * original[:, boundary2:mask_end]
                )
            if mask_end < blend_length:
                audio[index, :, mask_end:blend_length] = original[
                    :, mask_end:blend_length
                ]
    except Exception as error:
        raise RuntimeError(
            f"Could not blend seeded audio boundaries: {error}"
        ) from error


def _canonical_existing_variants(output_dir, num_variants):
    """Return the newest take for every UI slot, with legacy-name tolerance."""
    canonical_pattern = re.compile(r"_([a-z])(\d+)\.wav$")
    legacy_pattern = re.compile(r"_var_(\d+)_\d{8}_\d{6}\.wav$")
    existing = {}
    take_numbers = {}
    for filename in os.listdir(output_dir):
        canonical = canonical_pattern.search(filename)
        if canonical:
            index = ord(canonical.group(1)) - ord("a")
            take = int(canonical.group(2))
            if 0 <= index < num_variants and take >= take_numbers.get(index, -1):
                existing[index] = filename
                take_numbers[index] = take
            continue
        legacy = legacy_pattern.search(filename)
        if legacy:
            index = int(legacy.group(1)) - 1
            if 0 <= index < num_variants and index not in existing:
                existing[index] = filename
                take_numbers[index] = 0
    return existing


def _next_variation(runtime, filename_for_take_one, slot):
    """Allocate a session-wide take so flattened pack exports cannot collide."""
    prefix = filename_for_take_one.rsplit("_", 1)[0]
    pattern = re.compile(rf"^{re.escape(prefix)}_{re.escape(slot)}(\d+)\.wav$")
    highest = 0
    for _root, _directories, filenames in os.walk(runtime.session_dir):
        for filename in filenames:
            match = pattern.fullmatch(filename)
            if match:
                highest = max(highest, int(match.group(1)))
    return f"{slot}{highest + 1}"


def _publish_variants(task, runtime, audio, target_indices, is_drum, prompts):
    track_dir_name = f"track_{task.track_num}"
    output_dir = os.path.join(runtime.session_dir, track_dir_name)
    os.makedirs(output_dir, exist_ok=True)
    existing_files = _canonical_existing_variants(output_dir, task.num_variants)

    sample_rate = runtime.model.model.sample_rate
    publish_requests = []
    for generated_index, target_index in enumerate(target_indices):
        old_filename = existing_files.get(target_index)
        old_path = os.path.join(output_dir, old_filename) if old_filename else None
        # A server-resolved progression is a loop contract.  Never turn its
        # fourth variant into the legacy chordless drum-fill one-shot.
        is_drum_fill = (
            task.loop
            and target_index == 3
            and is_drum
            and task.progression is None
        )
        is_loop = task.loop and not is_drum_fill
        asset_key = None if is_drum_fill else task.key
        asset_chords = [] if is_drum_fill else list(task.chords)
        grid = musical_grid(
            int(audio[generated_index].shape[-1]), sample_rate, task.bpm, is_loop
        )
        slot = variation_slot(target_index)
        take_one_filename = build_asset_filename(
            pack=task.pack_name,
            descriptor=task.descriptor,
            bpm=task.bpm,
            key=asset_key,
            bars=grid["bars"],
            variation=f"{slot}1",
            kind="loop" if is_loop else "oneshot",
        )
        variation = _next_variation(runtime, take_one_filename, slot)
        filename = build_asset_filename(
            pack=task.pack_name,
            descriptor=task.descriptor,
            bpm=task.bpm,
            key=asset_key,
            bars=grid["bars"],
            variation=variation,
            kind="loop" if is_loop else "oneshot",
        )
        prompt_metadata = {
            "composed": task.prompt,
            "enhanced": prompts[generated_index],
            "negative": effective_negative_prompt(task.negative_prompt),
            "userNegative": task.negative_prompt,
            "sections": dict(task.prompt_sections or {}),
        }
        if task.conditioned_prompt and task.conditioned_prompt != task.prompt:
            prompt_metadata["conditioned"] = task.conditioned_prompt
        generation_metadata = {
            "jobId": task.job_id,
            "resultId": f"{task.job_id}:{variation}",
            "trackNumber": task.track_num,
            "variantIndex": target_index,
            "model": task.model_name,
            "qualityTier": task.quality_tier,
            "requestedSeed": task.requested_seed,
            "seed": task.seed,
            "seedOffset": target_index,
            "variantSeed": task.seed + target_index,
            "steps": task.steps,
            "cfgScale": task.cfg_scale,
            "requestedDurationSeconds": task.duration,
            "durationPaddingSeconds": task.duration_padding_sec,
            "sliceable": task.sliceable,
            "prompt": prompt_metadata,
            "remix": {
                "mode": task.remix_mode if task.init_audio_path else None,
                "source": task.init_audio_path,
                "noiseLevel": task.init_noise_level if task.init_audio_path else None,
                "inpaintStart": task.inpaint_start if task.remix_mode == "inpaint" else None,
                "inpaintEnd": task.inpaint_end if task.remix_mode == "inpaint" else None,
                "continueStart": task.continue_start if task.remix_mode == "continuation" else None,
                "invertTiming": task.invert_timing,
            },
        }
        if task.progression is not None:
            generation_metadata["progression"] = task.progression.as_dict()
        publish_requests.append({
            "target_index": target_index,
            "filename": filename,
            "old_path": old_path,
            "waveform": audio[generated_index].cpu(),
            "is_loop": is_loop,
            "variation": variation,
            "key": asset_key,
            "chords": asset_chords,
            "chord_source": None if is_drum_fill else task.chord_source,
            "generation": generation_metadata,
        })

    def publish_one(publish_request, _timeout_seconds):
        runtime.save_variant_atomically(
            os.path.join(output_dir, publish_request["filename"]),
            publish_request["waveform"],
            sample_rate,
            task.bpm,
            task.duration,
            publish_request["is_loop"],
            task.prompt,
            old_file_path=publish_request["old_path"],
            asset_metadata={
                "pack": task.pack_name,
                "descriptor": task.descriptor,
                "variation": publish_request["variation"],
                "key": publish_request["key"],
                "chords": publish_request["chords"],
                "chord_source": publish_request["chord_source"],
                "generation": publish_request["generation"],
                "provenance": {"session": runtime.session_dir_name},
            },
        )
        return publish_request["target_index"], publish_request["filename"]

    results = run_parallel_fanout(
        publish_requests,
        publish_one,
        # Local file publication must never run with a timeout: a timed-out
        # attempt keeps running in an abandoned daemon thread and can overlap
        # a retry on the same final paths, deleting the other attempt's
        # freshly published WAV. With no deadline there is no abandoned
        # attempt, so retries only ever follow a fully failed attempt.
        timeout_seconds=None,
        retries=2,
        backoff_seconds=0.15,
        max_workers=min(4, len(publish_requests) or 1),
    )
    partial_errors = []
    for result in results:
        if result.ok:
            target_index, filename = result.value
            existing_files[target_index] = filename
        else:
            partial_errors.append({
                "variant": result.item["target_index"] + 1,
                "error": result.error,
                "attempts": result.attempts,
            })

    files = [
        (
            f"{runtime.session_dir_name}/{track_dir_name}/{existing_files[index]}"
            if index in existing_files
            else ""
        )
        for index in range(task.num_variants)
    ]
    metadata_files = []
    for index, file_path in enumerate(files):
        metadata_name = sidecar_path_for(existing_files[index]) if file_path else ""
        if metadata_name and os.path.isfile(os.path.join(output_dir, metadata_name)):
            metadata_files.append(sidecar_path_for(file_path).replace("\\", "/"))
        else:
            metadata_files.append("")
    return files, metadata_files, partial_errors


def execute_generation_task(task, runtime):
    """Execute one validated task; all failures are recorded on its job."""
    audio = waveform = seed_audio = None
    try:
        _update_job(
            runtime,
            task.job_id,
            status="generating",
            progress="Preparing prompt…",
            queue_position=0,
        )
        target_indices, final_prompt, is_drum, prompts = _prepare_prompts(
            task, runtime
        )
        _update_job(
            runtime,
            task.job_id,
            progress=(
                "Running diffusion model (0% done)…"
                if runtime.is_warm()
                else "Warming up diffusion model (first run)…"
            ),
        )

        started_at = time.time()
        padding_sec = task.duration_padding_sec if task.loop else 0.0
        seed_audio, waveform, seed_sample_rate = _load_seed_audio(
            task, runtime, task.duration + padding_sec
        )
        audio = _generate_audio(task, runtime, prompts, seed_audio, padding_sec, target_indices=target_indices)
        _update_job(
            runtime,
            task.job_id,
            progress="Processing audio & blending loop transitions…",
        )
        elapsed = time.time() - started_at
        audio = _fit_audio_duration(
            audio, task.duration, runtime.model.model.sample_rate, task.loop
        )
        _blend_seed_boundaries(
            task, runtime, audio, waveform, seed_sample_rate
        )
        _update_job(
            runtime,
            task.job_id,
            progress="Saving and metadata tagging WAV files…",
        )
        files, metadata_files, partial_errors = _publish_variants(
            task, runtime, audio, target_indices, is_drum, prompts
        )
        if not any(files):
            raise RuntimeError("All generated variants failed during publishing")
        if task.sliceable and runtime.sliceable_registry is not None:
            for file_path, metadata_file in zip(files, metadata_files):
                if not file_path or not metadata_file:
                    continue
                kind = "oneshot" if "_oneshot_" in os.path.basename(file_path) else "loop"
                runtime.sliceable_registry.record(
                    file=file_path,
                    metadata_file=metadata_file or None,
                    kind=kind,
                    prompt=task.prompt,
                    bpm=task.bpm if kind == "loop" else None,
                    duration=task.duration,
                    session=runtime.session_dir_name,
                )
        _update_job(
            runtime,
            task.job_id,
            status="done",
            progress=None,
            elapsed=elapsed,
            files=files,
            metadata_files=metadata_files,
            partial_errors=partial_errors,
            prompt=final_prompt,
            track_num=task.track_num,
            seed=task.seed,
            requested_seed=task.requested_seed,
            queue_position=None,
        )
    except Exception as error:
        traceback.print_exc()
        _update_job(
            runtime,
            task.job_id,
            status="error",
            progress=None,
            error=str(error),
            queue_position=None,
        )
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    finally:
        _prune_completed_jobs(runtime)
        del audio, waveform, seed_audio
