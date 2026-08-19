"""Drum-kit one-shot generation pipeline (Kit Builder).

One KitTask occupies one queue slot and generates the whole kit:
piece x velocity x variation one-shot hits, plus optional multi-hit
"hit sheets" tagged sliceable for the upcoming slicer.

Prompts here deliberately bypass wav_metadata.enhance_prompt — one-shots
must never receive loop/BPM tags.
"""

from dataclasses import dataclass
import json
import os
import time
import traceback

import torch

# piece key -> (prompt noun, generation seconds). Cymbals and open hats need
# room for their decay; everything else is short.
KIT_PIECES = {
    "kick": ("kick drum", 1.5),
    "snare": ("snare drum", 1.5),
    "rimshot": ("snare rimshot", 1.5),
    "clap": ("hand clap", 1.5),
    "closed_hat": ("closed hi-hat", 1.5),
    "open_hat": ("open hi-hat", 4.0),
    "tom_low": ("low floor tom", 2.0),
    "tom_mid": ("mid tom", 2.0),
    "tom_high": ("high rack tom", 2.0),
    "ride": ("ride cymbal", 4.0),
    "crash": ("crash cymbal", 4.0),
    "shaker": ("shaker", 1.5),
    "cowbell": ("cowbell", 1.5),
    "perc": ("percussion hit", 1.5),
}

# velocity key -> (prompt descriptor, peak-normalization target)
VELOCITIES = {
    "soft": ("played very softly, light touch, quiet", 0.45),
    "medium": ("played at medium strength", 0.70),
    "hard": ("hit hard, forceful, loud", 0.98),
}

MAX_BATCH = 8
SHEET_DURATION_SEC = 8.0

ONE_SHOT_NEGATIVE_PROMPT = (
    "loop, music, melody, sustained notes, long reverb tail, room echo, "
    "poor quality, bad quality, low quality, noise, distortion, artifact"
)


@dataclass(frozen=True)
class KitTask:
    job_id: str
    kit_name: str
    style: str
    pieces: tuple
    velocities: tuple
    variations: int = 1
    steps: int = 8
    cfg_scale: float = 1.0
    seed: int = -1
    include_sheets: bool = False
    sheet_hits: int = 6


def build_one_shot_prompt(style, noun, velocity_descriptor):
    style_part = f"{style.strip()} " if style and style.strip() else ""
    return (
        f"{style_part}{noun}, single hit, one-shot drum sample, "
        f"{velocity_descriptor}, dry, tight, clean studio recording"
    )


def build_sheet_prompt(style, noun, hits):
    style_part = f"{style.strip()} " if style and style.strip() else ""
    return (
        f"{style_part}{noun} one-shot samples, {hits} isolated single hits "
        f"separated by silence, increasing intensity from soft to hard, dry, "
        f"clean studio recording"
    )


def trim_and_normalize(waveform, sample_rate, peak_target):
    """Trim leading/trailing silence, fade the tail, peak-normalize.

    waveform: float32 CPU tensor (channels, samples).
    """
    mono = waveform.abs().amax(dim=0)
    peak = float(mono.max())
    if peak <= 0.0:
        return waveform

    above_start = (mono > peak * 0.01).nonzero()
    above_end = (mono > peak * 0.005).nonzero()
    if above_start.numel() == 0 or above_end.numel() == 0:
        return waveform

    first = int(above_start[0])
    last = int(above_end[-1])
    start = max(0, first - int(0.003 * sample_rate))
    end = min(waveform.shape[-1], last + int(0.05 * sample_rate))
    trimmed = waveform[:, start:end].clone()

    fade_len = min(int(0.01 * sample_rate), trimmed.shape[-1])
    if fade_len > 1:
        fade = torch.linspace(1.0, 0.0, steps=fade_len, dtype=trimmed.dtype)
        trimmed[:, -fade_len:] *= fade

    return (trimmed * (peak_target / peak)).clamp(-1.0, 1.0)


def _generate_batch(runtime, prompts, duration, task):
    with runtime.model_lock:
        with torch.inference_mode():
            audio = runtime.model.generate(
                prompt=prompts,
                negative_prompt=ONE_SHOT_NEGATIVE_PROMPT,
                duration=duration,
                steps=task.steps,
                cfg_scale=task.cfg_scale,
                batch_size=len(prompts),
                seed=task.seed,
                duration_padding_sec=0.0,
                truncate_output_to_duration=True,
            )
            runtime.mark_warm()
    return audio.clone()


def execute_kit_task(task, runtime):
    """Generate a full kit under one job; failures are recorded on the job."""
    try:
        pieces = [p for p in task.pieces if p in KIT_PIECES]
        velocities = [v for v in task.velocities if v in VELOCITIES]
        if not pieces or not velocities:
            raise ValueError("Kit request contains no valid pieces or velocities")

        kit_slug = runtime.slugify_prompt(task.kit_name or task.style or "kit", 24) or "kit"
        kit_dir_name = f"kit_{time.strftime('%Y%m%d_%H%M%S')}_{kit_slug}"
        kit_dir = os.path.join(runtime.session_dir, "kits", kit_dir_name)
        os.makedirs(kit_dir, exist_ok=True)
        kit_rel_dir = f"{runtime.session_dir_name}/kits/{kit_dir_name}"

        sample_rate = runtime.model.model.sample_rate
        manifest_entries = []
        files = []
        started_at = time.time()
        total_stages = len(pieces) * (2 if task.include_sheets else 1)
        stage = 0

        for piece in pieces:
            noun, gen_duration = KIT_PIECES[piece]
            stage += 1
            runtime.update_job(
                task.job_id,
                status="generating",
                progress=f"Kit: generating {noun} one-shots ({stage}/{total_stages})…",
                queue_position=0,
            )

            prompts = []
            layer_meta = []
            for velocity in velocities:
                descriptor, peak_target = VELOCITIES[velocity]
                for variation in range(1, task.variations + 1):
                    prompts.append(build_one_shot_prompt(task.style, noun, descriptor))
                    layer_meta.append((velocity, peak_target, variation))

            for chunk_start in range(0, len(prompts), MAX_BATCH):
                chunk_prompts = prompts[chunk_start:chunk_start + MAX_BATCH]
                chunk_meta = layer_meta[chunk_start:chunk_start + MAX_BATCH]
                audio = _generate_batch(runtime, chunk_prompts, gen_duration, task)

                for index, (velocity, peak_target, variation) in enumerate(chunk_meta):
                    hit = trim_and_normalize(
                        audio[index].cpu().to(torch.float32), sample_rate, peak_target
                    )
                    filename = f"{piece}_{velocity}_{variation:02d}.wav"
                    runtime.save_variant_atomically(
                        os.path.join(kit_dir, filename),
                        hit,
                        sample_rate,
                        120,
                        hit.shape[-1] / sample_rate,
                        False,
                        chunk_prompts[index],
                    )
                    rel_path = f"{kit_rel_dir}/{filename}"
                    files.append(rel_path)
                    manifest_entries.append({
                        "piece": piece,
                        "velocity": velocity,
                        "variation": variation,
                        "file": filename,
                        "tags": ["kit", "one-shot"],
                    })
                del audio

        if task.include_sheets:
            for piece in pieces:
                noun, _ = KIT_PIECES[piece]
                stage += 1
                runtime.update_job(
                    task.job_id,
                    progress=f"Kit: generating {noun} hit sheet ({stage}/{total_stages})…",
                )
                sheet_prompt = build_sheet_prompt(task.style, noun, task.sheet_hits)
                audio = _generate_batch(runtime, [sheet_prompt], SHEET_DURATION_SEC, task)
                filename = f"{piece}_sheet_01.wav"
                runtime.save_variant_atomically(
                    os.path.join(kit_dir, filename),
                    audio[0].cpu().to(torch.float32).clamp(-1.0, 1.0),
                    sample_rate,
                    120,
                    SHEET_DURATION_SEC,
                    False,
                    sheet_prompt,
                )
                rel_path = f"{kit_rel_dir}/{filename}"
                files.append(rel_path)
                manifest_entries.append({
                    "piece": piece,
                    "velocity": None,
                    "variation": 1,
                    "file": filename,
                    "tags": ["sliceable", "hit_sheet"],
                })
                if runtime.sliceable_registry is not None:
                    runtime.sliceable_registry.record(
                        file=rel_path,
                        kind="hit_sheet",
                        prompt=sheet_prompt,
                        duration=SHEET_DURATION_SEC,
                        session=runtime.session_dir_name,
                    )
                del audio

        manifest = {
            "name": task.kit_name or kit_slug,
            "style": task.style,
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            "sample_rate": sample_rate,
            "entries": manifest_entries,
        }
        with open(os.path.join(kit_dir, "kit.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)

        runtime.update_job(
            task.job_id,
            status="done",
            progress=None,
            elapsed=time.time() - started_at,
            files=files,
            kit={"dir": kit_rel_dir, "manifest": manifest},
            queue_position=None,
        )
    except Exception as error:
        traceback.print_exc()
        runtime.update_job(
            task.job_id,
            status="error",
            progress=None,
            error=str(error),
            queue_position=None,
        )
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    finally:
        runtime.prune_terminal_jobs(retain=50)
