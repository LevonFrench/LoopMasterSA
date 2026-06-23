import os
import sys

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
import struct
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

from wav_metadata import (
    is_drum_prompt, parse_root_note, create_labl_chunk, create_adtl_list,
    pack_cue_chunk, find_data_chunk_offset, acidize_wav_file, enhance_prompt
)

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

    # --- Prompt Engineering ---
    bpm_val = args.bpm or 120
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
            negative_prompt="poor quality, bad quality, low quality, noise, distortion, artifact",
            duration=args.duration,
            steps=args.steps,
            cfg_scale=args.cfg_scale,
            batch_size=8,
            seed=-1,  # random seed so all variants differ
        )
    print(f"Generation completed in {time.time() - start_gen:.2f}s")

    # --- Save output wav files ---
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(args.output_dir, f"generation_{timestamp}")
    os.makedirs(out_dir, exist_ok=True)

    sample_rate = model.model.sample_rate
    print(f"Saving variants to {out_dir}...")
    for i in range(8):
        file_path = os.path.join(out_dir, f"variant_{i+1}.wav")
        torchaudio.save(file_path, audio[i].cpu(), sample_rate)
        # Embed ACIDized loop and beat grid metadata
        is_var_loop = args.loop
        if i == 3 and is_drum:
            is_var_loop = False
        acidize_wav_file(file_path, bpm_val, args.duration, is_var_loop, args.prompt)
        print(f"  Saved: {file_path}")

    abs_out_dir = os.path.abspath(out_dir)
    print("\nVariants generation completed successfully!")
    print(f"Output folder: {abs_out_dir}")
    print(f"To inspect these variants, load this folder into your grid player tool using:")
    print(f"  display_audio_grid(directory: \"{abs_out_dir}\")")

if __name__ == "__main__":
    main()
