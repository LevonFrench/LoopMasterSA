import os
import sys
import secrets
import uuid

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

import datetime
import time
import argparse
import re

# Explicitly force Windows to look into the active environment's PyTorch binary directory
venv_site_packages = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")
torch_dll_path = os.path.join(venv_site_packages, "torch", "lib")

if os.path.exists(torch_dll_path):
    os.add_dll_directory(torch_dll_path)

import torch
import torchaudio
from stable_audio_3 import StableAudioModel
from stable_audio_3.verbose import set_verbose

from asset_contract import (
    DEFAULT_LICENSE,
    build_asset_filename,
    build_sidecar_document,
    derive_descriptor,
    finalize_sidecar_for_wav,
    musical_grid,
    normalize_key,
    parse_chord_track,
    sidecar_path_for,
    slug_token,
    validate_sidecar,
    variation_slot,
    write_sidecar,
)
from wav_metadata import acidize_wav_file, enhance_prompt, is_drum_prompt


NEGATIVE_PROMPT = "poor quality, bad quality, low quality, noise, distortion, artifact"


def publish_variant_pair(
    file_path,
    waveform,
    sample_rate,
    *,
    bpm,
    is_loop,
    prompt,
    pack,
    descriptor,
    variation,
    key,
    chords,
    generation,
    provenance,
):
    """Atomically publish one canonical PCM16 WAV and adjacent v1 sidecar."""
    directory = os.path.dirname(file_path)
    temp_wav = os.path.join(
        directory, f".{os.path.basename(file_path)}.{uuid.uuid4().hex}.tmp.wav"
    )
    sidecar_path = sidecar_path_for(file_path)
    temp_sidecar = os.path.join(
        directory, f".{os.path.basename(sidecar_path)}.{uuid.uuid4().hex}.tmp"
    )
    published_wav = False
    try:
        torchaudio.save(
            temp_wav,
            waveform,
            sample_rate,
            encoding="PCM_S",
            bits_per_sample=16,
        )
        document = build_sidecar_document(
            file_name=os.path.basename(file_path),
            waveform=waveform,
            sample_rate=sample_rate,
            bpm=bpm,
            kind="loop" if is_loop else "oneshot",
            pack=pack,
            descriptor=descriptor,
            variation=variation,
            key=key,
            chords=chords,
            generation=generation,
            provenance=provenance,
        )
        acidize_wav_file(
            temp_wav,
            bpm,
            waveform.shape[-1] / sample_rate,
            is_loop,
            prompt,
            metadata_document=document,
        )
        document = finalize_sidecar_for_wav(document, temp_wav)
        write_sidecar(temp_sidecar, document)
        validate_sidecar(document)
        os.replace(temp_wav, file_path)
        published_wav = True
        os.replace(temp_sidecar, sidecar_path)
        return document
    except Exception:
        if published_wav:
            try:
                os.remove(file_path)
            except OSError:
                pass
        raise
    finally:
        for temp_path in (temp_wav, temp_sidecar):
            try:
                os.remove(temp_path)
            except FileNotFoundError:
                pass

def main():
    parser = argparse.ArgumentParser(
        prog="stable-audio-variants",
        description="Stable Audio 3 — Generate 8 variations of a prompt at a specific BPM & duration",
    )

    # Model
    parser.add_argument(
        "--model",
        default="small-music",
        choices=[
            "medium",
            "small-music",
            "small-sfx",
            "medium-base",
            "small-music-base",
            "small-sfx-base",
        ],
        help="Model to load (default: small-music)",
    )
    parser.add_argument("--pack", default="loopmaster", help="Canonical pack name")
    parser.add_argument(
        "--descriptor",
        default="",
        help="Filename descriptor (defaults to a prompt-derived token)",
    )
    parser.add_argument(
        "--key",
        default="",
        help="Optional musical key, for example 'F# minor'",
    )
    parser.add_argument(
        "--chord-track",
        default="",
        help="Optional timeline such as 'gb_min@1:1, d_maj@3:1'",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=-1,
        help="Base seed; -1 resolves to a recorded random seed",
    )
    parser.add_argument(
        "--device",
        default=None,
        help="Device: cuda / mps / cpu (auto-detected if omitted)",
    )
    parser.add_argument(
        "--no-half", action="store_true", help="Disable half-precision (fp16) on CUDA"
    )

    # Generation
    parser.add_argument(
        "-p",
        "--prompt",
        required=True,
        help="Text prompt for the audio generation",
    )
    parser.add_argument(
        "--bpm",
        type=int,
        default=None,
        help="Optional BPM to append to prompt",
    )
    parser.add_argument(
        "-d",
        "--duration",
        type=float,
        default=10.0,
        help="Duration in seconds (default: 10.0)",
    )
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Append looping tags to guide loopable generation",
    )
    parser.add_argument(
        "--steps", type=int, default=8, help="Diffusion steps (default: 8)"
    )
    parser.add_argument(
        "--cfg-scale",
        type=float,
        default=1.0,
        help="CFG scale (default: 1.0; try 7.0 for base models)",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        default="outputs",
        help="Base output directory (default: outputs)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=False,
        help="Print detailed generation progress",
    )

    args = parser.parse_args()
    set_verbose(args.verbose)

    if args.seed < -1:
        parser.error("--seed must be -1 or a non-negative integer")

    # --- Prompt Engineering ---
    bpm_val = args.bpm or 120
    if args.loop:
        exact_beats = args.duration * bpm_val / 60.0
        beat_count = int(round(exact_beats))
        if abs(exact_beats - beat_count) > 0.03 or beat_count <= 0 or beat_count % 4:
            parser.error("loop duration must land on a whole 4/4 bar grid within 0.03 beats")
        requested_bars = beat_count // 4
    else:
        requested_bars = None
    key_info = normalize_key(args.key) if args.key else None
    if args.key and key_info is None:
        parser.error("--key must name a major or minor key")
    chords = parse_chord_track(args.chord_track, requested_bars)
    if not args.loop and any((event["bar"], event["beat"]) != (1, 1) for event in chords):
        parser.error("one-shot chord metadata can only start at bar 1 beat 1")
    pack = slug_token(args.pack, "loopmaster")
    descriptor = derive_descriptor(args.descriptor, prompt=args.prompt)
    requested_seed = args.seed
    resolved_seed = secrets.randbelow(100_000) if requested_seed == -1 else requested_seed
    final_prompt = enhance_prompt(args.prompt, bpm_val, args.duration, args.loop)

    # Build prompts list for batch size 8: make the 4th variant (index 3) a fill if it's a drum prompt
    prompts_list = []
    is_drum = is_drum_prompt(args.prompt)
    for i in range(8):
        if i == 3 and is_drum:
            fill_prompt = enhance_prompt(args.prompt, bpm_val, args.duration, loop=False)
            fill_prompt = re.sub(r'\bseamless loop\b', 'drum fill, drum roll', fill_prompt, flags=re.IGNORECASE)
            fill_prompt = re.sub(r'\blooping\b', 'transition', fill_prompt, flags=re.IGNORECASE)
            fill_prompt = re.sub(r'\bloop\b', 'fill', fill_prompt, flags=re.IGNORECASE)
            fill_prompt = re.sub(r'\bbreakbeats?\b', 'drum fill', fill_prompt, flags=re.IGNORECASE)
            fill_prompt = re.sub(r'\bbeats?\b', 'fill', fill_prompt, flags=re.IGNORECASE)
            if "fill" not in fill_prompt.lower():
                fill_prompt += ", drum fill, transition fill"
            prompts_list.append(fill_prompt)
        else:
            prompts_list.append(final_prompt)

    print(f"Original Prompt: \"{args.prompt}\"")
    for i, p_str in enumerate(prompts_list):
        print(f"Variant {i+1} Prompt: \"{p_str}\"")
    print(f"Duration: {args.duration}s")
    print(f"BPM: {bpm_val}")
    print(f"Looping: {args.loop}")

    # --- Load model ---
    print(f"Loading model '{args.model}'...")
    start_load = time.time()
    model = StableAudioModel.from_pretrained(
        args.model, device=args.device, model_half=not args.no_half
    )
    print(f"Model loaded in {time.time() - start_load:.2f}s")

    # --- Generate variants ---
    print("Generating 8 variants in parallel...")
    start_gen = time.time()
    with torch.inference_mode():
        audio = model.generate(
            prompt=prompts_list,
            negative_prompt=NEGATIVE_PROMPT,
            duration=args.duration,
            steps=args.steps,
            cfg_scale=args.cfg_scale,
            batch_size=8,
            seed=resolved_seed,
            seed_offsets=list(range(8)),
        )
    print(f"Generation completed in {time.time() - start_gen:.2f}s")

    # --- Save output wav files ---
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(args.output_dir, f"generation_{timestamp}")
    os.makedirs(out_dir, exist_ok=True)

    sample_rate = model.model.sample_rate
    print(f"Saving variants to {out_dir}...")
    for i in range(8):
        is_drum_fill = args.loop and i == 3 and is_drum
        is_var_loop = args.loop and not is_drum_fill
        asset_key = None if is_drum_fill else key_info
        asset_chords = [] if is_drum_fill else chords
        grid = musical_grid(int(audio[i].shape[-1]), sample_rate, bpm_val, is_var_loop)
        variation = f"{variation_slot(i)}1"
        filename = build_asset_filename(
            pack=pack,
            descriptor=descriptor,
            bpm=bpm_val,
            key=asset_key,
            bars=grid["bars"],
            variation=variation,
            kind="loop" if is_var_loop else "oneshot",
        )
        file_path = os.path.join(out_dir, filename)
        publish_variant_pair(
            file_path,
            audio[i].to(device="cpu", dtype=torch.float32),
            sample_rate,
            bpm=bpm_val,
            is_loop=is_var_loop,
            prompt=args.prompt,
            pack=pack,
            descriptor=descriptor,
            variation=variation,
            key=asset_key,
            chords=asset_chords,
            generation={
                "model": args.model,
                "requestedSeed": requested_seed,
                "seed": resolved_seed,
                "seedOffset": i,
                "variantSeed": resolved_seed + i,
                "steps": args.steps,
                "cfgScale": args.cfg_scale,
                "requestedDurationSeconds": args.duration,
                "prompt": {
                    "composed": args.prompt,
                    "enhanced": prompts_list[i],
                    "negative": NEGATIVE_PROMPT,
                    "userNegative": "",
                    "sections": {"freePrompt": args.prompt},
                },
            },
            provenance={
                "generator": "LoopMaster SA3 CLI",
                "license": DEFAULT_LICENSE,
                "session": os.path.basename(out_dir),
            },
        )
        print(f"  Saved: {file_path}")

    abs_out_dir = os.path.abspath(out_dir)
    print("\nVariants generation completed successfully!")
    print(f"Output folder: {abs_out_dir}")
    print(f"To inspect these variants, load this folder into your grid player tool using:")
    print(f"  display_audio_grid(directory: \"{abs_out_dir}\")")

if __name__ == "__main__":
    main()
