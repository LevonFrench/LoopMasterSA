"""Stable Audio generation pipeline, isolated from HTTP and queue concerns."""

from dataclasses import dataclass
import os
import re
import time
import traceback

import torch
import torchaudio

from kit_executor import KitTask, execute_kit_task


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
    final_prompt = runtime.enhance_prompt(task.prompt, task.bpm, task.duration, task.loop)
    is_drum = runtime.is_drum_prompt(task.prompt)
    prompts = []
    for target_idx in target_indices:
        if target_idx == 3 and is_drum:
            fill_prompt = runtime.enhance_prompt(
                task.prompt, task.bpm, task.duration, loop=False
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

        if runtime.model.model_half:
            waveform = waveform.half()
        waveform = waveform.to(runtime.model.device)
        print(
            f"[Seed Audio] Loaded {full_path} successfully on device "
            f"{runtime.model.device} for mode '{task.remix_mode}'."
        )
        return (sample_rate, waveform), waveform, sample_rate
    except Exception as error:
        raise RuntimeError(
            f"Could not load seed audio '{task.init_audio_path}': {error}"
        ) from error


def _generate_audio(task, runtime, prompts, seed_audio, padding_sec, target_indices=None):
    def progress_callback(info):
        if "stage" in info:
            stage_messages = {
                "vae_start": "Decoding audio latents using VAE (30-40s)…",
                "vae_end": "VAE decoding completed…",
            }
            message = stage_messages.get(info["stage"], f"Stage: {info['stage']}…")
        else:
            step = info.get("i", 0)
            percent = int((step + 1) / task.steps * 100)
            message = (
                f"Generating diffusion model (step {step + 1}/{task.steps} "
                f"- {percent}%)…"
            )
        _update_job(runtime, task.job_id, progress=message)

    kwargs = {
        "prompt": prompts,
        "negative_prompt": (
            "poor quality, bad quality, low quality, noise, distortion, artifact"
        ),
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
            audio = runtime.model.generate(**kwargs)
            runtime.mark_warm()
    return audio.clone()


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
            ).to(audio.device)
            original = resampler(waveform.to(audio.device))
        else:
            original = waveform.to(audio.device)

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


def _publish_variants(task, runtime, audio, target_indices, is_drum):
    track_dir_name = f"track_{task.track_num}"
    output_dir = os.path.join(runtime.session_dir, track_dir_name)
    os.makedirs(output_dir, exist_ok=True)
    prompt_slug = runtime.slugify_prompt(task.prompt, 16)
    timestamp = time.strftime("%Y%m%d_%H%M%S")

    # Anchor on the filename tail: prompt slugs may themselves contain
    # "_var_N_", so a loose substring match can bind the wrong variant.
    variant_pattern = re.compile(r"_var_(\d+)_\d{8}_\d{6}\.wav$")
    existing_files = {}
    for filename in os.listdir(output_dir):
        match = variant_pattern.search(filename)
        if match is None:
            continue
        variant_index = int(match.group(1))
        if 1 <= variant_index <= task.num_variants:
            existing_files[variant_index - 1] = filename

    sample_rate = runtime.model.model.sample_rate
    for generated_index, target_index in enumerate(target_indices):
        old_filename = existing_files.get(target_index)
        old_path = (
            os.path.join(output_dir, old_filename) if old_filename else None
        )
        slug_segment = f"_{prompt_slug}" if prompt_slug else ""
        filename = (
            f"track_{task.track_num}_{task.bpm}bpm{slug_segment}_"
            f"var_{target_index + 1}_{timestamp}.wav"
        )
        runtime.save_variant_atomically(
            os.path.join(output_dir, filename),
            audio[generated_index].cpu(),
            sample_rate,
            task.bpm,
            task.duration,
            task.loop and not (target_index == 3 and is_drum),
            task.prompt,
            old_file_path=old_path,
        )
        existing_files[target_index] = filename

    return [
        (
            f"{runtime.session_dir_name}/{track_dir_name}/{existing_files[index]}"
            if index in existing_files
            else ""
        )
        for index in range(task.num_variants)
    ]


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
        files = _publish_variants(
            task, runtime, audio, target_indices, is_drum
        )
        if task.sliceable and runtime.sliceable_registry is not None:
            for file_path in files:
                if not file_path:
                    continue
                runtime.sliceable_registry.record(
                    file=file_path,
                    kind="loop",
                    prompt=task.prompt,
                    bpm=task.bpm,
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
            prompt=final_prompt,
            track_num=task.track_num,
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
