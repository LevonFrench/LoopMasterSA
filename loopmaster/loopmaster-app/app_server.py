"""
Stable Audio 3 — Grid Generator Backend (Pure Flask Server)
Ripped out Gradio dependencies to focus on custom web interface.
"""

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

jobs = {}
jobs_lock = threading.Lock()

first_generation_completed = False

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

# ---------------------------------------------------------------------------
# WAV Loop Metadata & Beat Grid Generation
# ---------------------------------------------------------------------------

import struct
import re

def is_drum_prompt(prompt):
    """
    Checks if the prompt describes a drum, percussion, or beat loop.
    Uses regex patterns to match standalone words to avoid substring false positives.
    """
    prompt_lower = prompt.lower()
    drum_patterns = [
        r'\bdrums?\b', r'\bperc(ussion)?s?\b', r'\bpercussive\b', 
        r'\bkick(s)?\b', r'\bsnare(s)?\b', r'\bhi-?hat(s)?\b', 
        r'\btom(s)?\b', r'\bclap(s)?\b', r'\bshaker(s)?\b', 
        r'\bbeats?\b', r'\bbreaks?\b', r'\bbreakbeats?\b', 
        r'\brhythms?\b', r'\bride(s)?\b', r'\bcrash(es)?\b', 
        r'\bcymbals?\b', r'\bbongos?\b', r'\bcongas?\b', 
        r'\btimbales?\b', r'\bcowbells?\b', r'\btambourines?\b', 
        r'\brimshots?\b', r'\bwoodblocks?\b', r'\bcabasa\b', 
        r'\bmaracas?\b', r'\bguiro\b', r'\bclaves?\b', 
        r'\btimpani\b', r'\bhats\b', r'\bdrumkit\b'
    ]
    return any(re.search(pattern, prompt_lower) for pattern in drum_patterns)

def parse_root_note(prompt):
    """
    Parses prompt string to extract musical key and map to MIDI root note.
    Returns 0xFFFF (Don't Transpose / Ignore) if no key matches.
    """
    prompt_lower = prompt.lower()
    
    # 1. Look for patterns like "key of C", "key: A#", "in F minor", "in Bb major"
    match = re.search(r'\b(?:key of|key:|in)\s+([a-g])\s*(#|b|sharp|flat)?', prompt_lower)
    if not match:
        # 2. Check for stand-alone keys like "C minor" or "A maj" at word boundaries
        match = re.search(r'\b([a-g])\s*(#|b|sharp|flat)?\s*(?:major|minor|maj|min|m)\b', prompt_lower)
        
    if match:
        note_name = match.group(1).upper()
        accidental = match.group(2)
        
        # Base midi notes (C = 0, D = 2, E = 4, F = 5, G = 7, A = 9, B = 11)
        notes_map = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
        midi_base = notes_map.get(note_name, 0)
        
        if accidental:
            accidental = accidental.lower()
            if accidental in ['#', 'sharp']:
                midi_base += 1
            elif accidental in ['b', 'flat']:
                midi_base -= 1
                
        # Return note in octave 5 (60 is middle C)
        midi_note = 60 + midi_base
        # Wrap around to keep within [60, 71] octave range
        return (midi_note - 60) % 12 + 60
        
    return 0xFFFF  # Ignore / Don't Transpose

def create_labl_chunk(cue_id, label_text):
    """Packs a 'labl' sub-chunk for the LIST adtl chunk."""
    label_bytes = label_text.encode('utf-8') + b'\x00' # Null-terminated
    # Align to even length
    if len(label_bytes) % 2 != 0:
        label_bytes += b'\x00'
    # Size is 4 bytes for Cue ID + label data size
    chunk_header = struct.pack('<4sII', b'labl', 4 + len(label_bytes), cue_id)
    return chunk_header + label_bytes

def create_adtl_list(labels):
    """Packs a LIST chunk of type adtl containing labl sub-chunks."""
    sub_chunks = b''
    for cue_id, text in labels:
        sub_chunks += create_labl_chunk(cue_id, text)
    # LIST size is 4 bytes list type ID + sub_chunks size
    list_header = struct.pack('<4sI4s', b'LIST', 4 + len(sub_chunks), b'adtl')
    return list_header + sub_chunks

def pack_cue_chunk(cue_points):
    """Packs a 'cue ' chunk containing a list of cue points."""
    packed_points = b''
    for point in cue_points:
        # ID, Position, DataChunkID, ChunkStart, BlockStart, SampleOffset
        packed_points += struct.pack('<II4sIII', *point)
    num_cue_points = len(cue_points)
    chunk_size = 4 + (24 * num_cue_points)
    header = struct.pack('<4sII', b'cue ', chunk_size, num_cue_points)
    return header + packed_points

def find_data_chunk_offset(content):
    """Parses RIFF chunks to find the exact byte offset of the 'data' chunk."""
    offset = 12
    limit = len(content)
    while offset + 8 <= limit:
        chunk_id = content[offset:offset+4]
        chunk_size = struct.unpack('<I', content[offset+4:offset+8])[0]
        if chunk_id == b'data':
            return offset
        offset += 8 + chunk_size
        # Handle padding byte if size is odd
        if chunk_size % 2 != 0:
            offset += 1
    return None

def acidize_wav_file(file_path, bpm, duration, loop=True, prompt=""):
    """
    Inserts 'acid', 'cue ', and 'LIST' chunks BEFORE the 'data' chunk in a WAV file
    to set tempo, key, looping behavior, and beat transient markers without causing
    audio decoding noise at the end of the file.
    """
    try:
        # Read the entire WAV file content
        with open(file_path, 'rb') as f:
            content = f.read()
            
        if content[:4] != b'RIFF' or content[8:12] != b'WAVE':
            print("[WAV Metadata] Invalid RIFF WAVE header")
            return
            
        # Parse sample rate from fmt chunk
        fmt_offset = None
        offset = 12
        limit = len(content)
        while offset + 8 <= limit:
            chunk_id = content[offset:offset+4]
            chunk_size = struct.unpack('<I', content[offset+4:offset+8])[0]
            if chunk_id == b'fmt ':
                fmt_offset = offset
                break
            offset += 8 + chunk_size
            if chunk_size % 2 != 0:
                offset += 1
                
        if fmt_offset is None:
            # Fallback to standard offset
            sample_rate = struct.unpack('<I', content[24:28])[0]
        else:
            # Sample rate is 12 bytes after the chunk ID in the 'fmt ' chunk
            sample_rate = struct.unpack('<I', content[fmt_offset+12:fmt_offset+16])[0]

        # Find the 'data' chunk offset
        data_offset = find_data_chunk_offset(content)
        if data_offset is None:
            print("[WAV Metadata] Could not locate 'data' chunk")
            return

        # 1. Build 'acid' chunk
        acid_id = b"acid"
        acid_size = 24
        acid_type = 1 if loop else 0  # 1 = Loop, 0 = One-shot
        root_note = parse_root_note(prompt)
        reserved = 0
        num_beats = 16 if loop else 0
        meter_num = 4.0
        meter_den = 4.0
        tempo = float(bpm)
        
        acid_payload = struct.pack("<IHHifff", acid_type, root_note, reserved, num_beats, meter_num, meter_den, tempo)
        acid_chunk = acid_id + struct.pack("<I", acid_size) + acid_payload

        # 2. Build 'cue ' and 'LIST' (adtl) chunks for the beat grid
        cue_points = []
        labels = []
        
        if loop and bpm > 0:
            samples_per_beat = (60.0 / bpm) * sample_rate
            # 16 beats + 1 end marker
            for i in range(17):
                pos = int(round(i * samples_per_beat))
                cue_id = i + 1
                label_name = f"Beat {cue_id}" if i < 16 else "End"
                cue_points.append((cue_id, pos, b'data', 0, 0, pos))
                labels.append((cue_id, label_name))
                
            cue_chunk = pack_cue_chunk(cue_points)
            list_chunk = create_adtl_list(labels)
            metadata_block = acid_chunk + cue_chunk + list_chunk
        else:
            metadata_block = acid_chunk

        # Ensure metadata_block size is even
        if len(metadata_block) % 2 != 0:
            metadata_block += b'\x00'

        # 3. Assemble new WAV file content inserting metadata chunks BEFORE the 'data' chunk
        header = content[:data_offset]
        data_chunk = content[data_offset:]
        
        new_content = header + metadata_block + data_chunk
        
        # Update RIFF size at offset 4
        new_riff_size = len(new_content) - 8
        new_content = new_content[:4] + struct.pack("<I", new_riff_size) + new_content[8:]

        # Write back to file
        with open(file_path, 'wb') as f:
            f.write(new_content)
            
        print(f"[WAV Metadata] Successfully ACIDized WAV file '{os.path.basename(file_path)}' (inserted before data chunk):")
        print(f"               Tempo={bpm} BPM, RootNote={root_note if root_note != 0xFFFF else 'Ignore'}, Beats={num_beats}")
    except Exception as e:
        print(f"[WAV Metadata] Error writing metadata: {e}")

# ---------------------------------------------------------------------------
# Generation logic
# ---------------------------------------------------------------------------
def enhance_prompt(prompt, bpm, duration, loop=True):
    """
    Enhances a prompt based on official Stability AI Stable Audio 3 guidelines:
    1. Prepend TrackType prefix based on keyword matching.
    2. Ensure loop/looping/seamless loop tags are present when loop is checked.
    3. Append high-quality acoustic/production tags.
    4. Append standard BPM and Length tags.
    """
    # Remove any existing informal BPM descriptions like "120 bpm", "120bpm", "at 120 bpm" to avoid conflicting with structured metadata
    prompt = re.sub(r'\b(?:at\s+)?\d+\s*bpm\b', '', prompt, flags=re.IGNORECASE)
    # Clean up trailing "at" if it got orphaned (e.g. "slow loop at")
    prompt = re.sub(r'\bat\s*$', '', prompt, flags=re.IGNORECASE)
    # Clean up spacing around commas and duplicate commas
    prompt = re.sub(r'\s*,\s*', ', ', prompt)
    prompt = re.sub(r',\s*,', ',', prompt)
    prompt = prompt.strip().strip(",")
    prompt_lower = prompt.lower()
    
    # If the user has already manually tagged TrackType, bypass auto-classification
    if "tracktype:" in prompt_lower:
        final_prompt = prompt
    else:
        # 1. Classify TrackType
        sfx_keywords = [
            "sfx", "sound effect", "impact", "foley", "hit", "shatter", "glass break", 
            "explosion", "gunshot", "creak", "clatter", "thud", "whoosh", "swoosh", "zap",
            "ambient drone", "ambience", "drone", "environment", "noise",
            "thunder", "rain", "wind", "storm", "waves", "ocean", "river", "birds", "cricket"
        ]
        instrument_keywords = [
            "solo", "stem", "riff", "pluck", "lead", "bassline", "chords", "strum", 
            "drum loop", "perc loop", "percussion loop", "arpeggio", "groove loop",
            "synth", "guitar", "piano", "flute", "bass", "drum", "percussion", "brass",
            "trumpet", "violin", "cello", "saxophone", "rhodes", "organ", "clavinet"
        ]
        
        if any(re.search(rf'\b{re.escape(k)}\b', prompt_lower) for k in sfx_keywords):
            final_prompt = f"TrackType: SFX, {prompt}"
        elif any(re.search(rf'\b{re.escape(k)}\b', prompt_lower) for k in instrument_keywords) or (loop and "loop" in prompt_lower):
            final_prompt = f"TrackType: Instrument, {prompt}"
        else:
            final_prompt = f"TrackType: Music, VocalType: Instrumental, {prompt}"
            
    # 1.5 Default to SOLO instrumentation for instrument tracks unless otherwise specified
    if "tracktype: instrument" in final_prompt.lower():
        non_solo_keywords = [
            "solo", "duo", "trio", "quartet", "quintet", "ensemble", "band", 
            "orchestra", "symphony", "group", "session", "duet", "split", 
            "accompaniment", "backing", "chorus", "tutti", "multi"
        ]
        match = re.match(r'^(tracktype:\s*instrument,\s*)(.*)$', final_prompt, re.IGNORECASE)
        if match:
            prefix = match.group(1)
            prompt_content = match.group(2)
            content_lower = prompt_content.lower()
            if not any(k in content_lower for k in non_solo_keywords):
                final_prompt = f"{prefix}solo {prompt_content}"
        else:
            if not any(k in final_prompt.lower() for k in non_solo_keywords):
                final_prompt = "solo " + final_prompt
 
    # 2. Integrate Looping keywords
    if loop:
        if "loop" not in final_prompt.lower():
            final_prompt += " loop"
            
    # 3. Add High Quality Acoustic & Spatial Descriptors
    quality_keywords = ["high fidelity", "studio", "clean", "mix", "stereo", "warmth", "analog"]
    if not any(q in final_prompt.lower() for q in quality_keywords):
        if "TrackType: SFX" in final_prompt:
            final_prompt += ", detailed texture, clean recording, high fidelity"
        elif "TrackType: Instrument" in final_prompt:
            final_prompt += ", clean studio recording, high fidelity, detailed texture"
        else:
            final_prompt += ", analog warmth, high fidelity, 44.1 kHz, stereo, well-mixed"
 
    # 4. Standardized BPM & Length formatting suffix using periods (dots) for Stability AI 3 guidelines
    duration_int = int(round(duration))
    if not final_prompt.endswith('.'):
        final_prompt += '.'
    final_prompt += f" BPM: {bpm}."
    if "length:" not in final_prompt.lower():
        final_prompt += f" Length: {duration_int} seconds."
        
    if loop:
        final_prompt += " seamless loop, looping"
        
    return final_prompt

def _run_generation(job_id, prompt, bpm, duration, num_variants, loop, steps, cfg_scale, track_num, duration_padding_sec=0.0, init_audio_path=None, init_noise_level=0.6, seed=-1, remix_mode="variation", inpaint_start=0.0, inpaint_end=0.0, continue_start=0.0, invert_timing=False):
    global model
    try:
        with jobs_lock:
            jobs[job_id]["status"] = "generating"
            jobs[job_id]["progress"] = "Preparing prompt…"

        final_prompt = enhance_prompt(prompt, bpm, duration, loop)
        
        # Build prompt list: make the 4th variant (index 3) a fill if it's a drum prompt
        prompts_list = []
        is_drum = is_drum_prompt(prompt)
        for i in range(num_variants):
            if i == 3 and is_drum:
                fill_prompt = enhance_prompt(prompt, bpm, duration, loop=False)
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

        print(f"\n[Prompt Enhancement] Original: '{prompt}'")
        for i, p_str in enumerate(prompts_list):
            print(f"[Prompt Enhancement] Variant {i+1} Enhanced: '{p_str}'")
        print()

        global first_generation_completed
        with jobs_lock:
            if not first_generation_completed:
                jobs[job_id]["progress"] = "Compiling Diffusion Transformer (45-60s on first run)…"
            else:
                jobs[job_id]["progress"] = "Running diffusion model (0% done)…"

        def progress_callback(info):
            if "stage" in info:
                stage = info["stage"]
                if stage == "vae_start":
                    progress_msg = "Decoding audio latents using VAE (30-40s)…"
                elif stage == "vae_end":
                    progress_msg = "VAE decoding completed…"
                else:
                    progress_msg = f"Stage: {stage}…"
                with jobs_lock:
                    jobs[job_id]["progress"] = progress_msg
                return
            step = info.get('i', 0)
            pct = int((step + 1) / steps * 100)
            with jobs_lock:
                jobs[job_id]["progress"] = f"Generating diffusion model (step {step + 1}/{steps} - {pct}%)…"

        start_gen = time.time()

        # Generate with 2.0s headroom to capture tail decay if loop is active
        gen_duration = duration + 2.0 if loop else duration

        # Load seed audio if provided (used for variation, inpaint, or continuation)
        seed_audio = None
        if init_audio_path:
            sanitized_path = os.path.normpath(init_audio_path).replace("..", "")
            full_init_path = os.path.join(OUTPUT_DIR, sanitized_path)
            if os.path.exists(full_init_path) and os.path.isfile(full_init_path):
                try:
                    init_waveform, init_sr = torchaudio.load(full_init_path)
                    
                    # Reverse audio waveform if invert_timing is requested
                    if invert_timing:
                        init_waveform = torch.flip(init_waveform, dims=[-1])
                        print(f"[Seed Audio] Inverted timing/progression (reversed waveform along time dimension) for {full_init_path}.")

                    # Pad seed audio to target gen_duration for inpainting/continuation modes to prevent gaps
                    if remix_mode in ["inpaint", "response", "continuation"]:
                        current_samples = init_waveform.shape[1]
                        target_samples = int(gen_duration * init_sr)
                        if current_samples < target_samples:
                            padding_samples = target_samples - current_samples
                            padding = torch.zeros((init_waveform.shape[0], padding_samples), dtype=init_waveform.dtype)
                            init_waveform = torch.cat([init_waveform, padding], dim=-1)
                            print(f"[Seed Audio] Padded seed audio from {current_samples} to {target_samples} samples ({gen_duration}s) for mode '{remix_mode}'.")
                        
                    if model.model_half:
                        init_waveform = init_waveform.half()
                    init_waveform = init_waveform.to(model.device)
                    seed_audio = (init_sr, init_waveform)
                    print(f"[Seed Audio] Loaded {full_init_path} successfully on device {model.device} for mode '{remix_mode}'.")
                except Exception as load_err:
                    print(f"[Seed Audio] Error loading {full_init_path}: {load_err}")

        with model_lock:
            with torch.inference_mode():
                
                # Configure generation parameters based on remix mode
                pad_sec = 2.0 if loop else 0.0
                gen_kwargs = {
                    "prompt": prompts_list,
                    "negative_prompt": "poor quality, bad quality, low quality, noise, distortion, artifact",
                    "duration": duration,
                    "steps": steps,
                    "cfg_scale": cfg_scale,
                    "batch_size": num_variants,
                    "seed": seed,
                    "duration_padding_sec": pad_sec,
                    "truncate_output_to_duration": False,
                    "callback": progress_callback,
                }
                
                if seed_audio is not None:
                    if remix_mode == "variation":
                        gen_kwargs["init_audio"] = seed_audio
                        gen_kwargs["init_noise_level"] = init_noise_level
                        print(f"[Generation] Running variation with noise level {init_noise_level}.")
                    elif remix_mode == "inpaint" or remix_mode == "response":
                        gen_kwargs["inpaint_audio"] = seed_audio
                        overlap_sec = 0.3
                        if remix_mode == "response":
                            # Call & Response: keep first half (call), regenerate second half (response)
                            mask_start = max(0.0, (duration / 2.0) - overlap_sec)
                            gen_kwargs["inpaint_mask_start_seconds"] = mask_start
                            gen_kwargs["inpaint_mask_end_seconds"] = duration + 10.0
                            print(f"[Generation] Running Call & Response. Masking {mask_start}s to {duration + 10.0}s (overlap: {overlap_sec}s).")
                        else:
                            mask_start = max(0.0, inpaint_start - overlap_sec)
                            mask_end = min(duration, inpaint_end + overlap_sec)
                            gen_kwargs["inpaint_mask_start_seconds"] = mask_start
                            gen_kwargs["inpaint_mask_end_seconds"] = mask_end
                            print(f"[Generation] Running inpaint with range {mask_start}s to {mask_end}s (overlap: {overlap_sec}s).")
                    elif remix_mode == "continuation":
                        gen_kwargs["inpaint_audio"] = seed_audio
                        # Overlap the mask start by 0.3s to allow Stable Audio 3 to blend the boundary smoothly
                        overlap_sec = 0.3
                        mask_start = max(0.0, continue_start - overlap_sec)
                        gen_kwargs["inpaint_mask_start_seconds"] = mask_start
                        # Mask all the way to the end of the generated sequence to extend it
                        gen_kwargs["inpaint_mask_end_seconds"] = max(duration, gen_duration) + 10.0
                        print(f"[Generation] Running continuation keeping first {mask_start}s (overlap: {overlap_sec}s).")
                
                audio = model.generate(**gen_kwargs)
                first_generation_completed = True

        audio = audio.clone()
        with jobs_lock:
            jobs[job_id]["progress"] = "Processing audio & blending loop transitions…"
        elapsed = time.time() - start_gen

        # Apply loop tail headroom preservation and fade-out feathering
        sample_rate = model.model.sample_rate
        exact_samples = int(duration * sample_rate)
        
        if loop:
            padded_samples = int((duration + 2.0) * sample_rate)
            if audio.shape[-1] < padded_samples:
                padding = torch.zeros((*audio.shape[:-1], padded_samples - audio.shape[-1]), device=audio.device, dtype=audio.dtype)
                audio = torch.cat([audio, padding], dim=-1)
            elif audio.shape[-1] > padded_samples:
                audio = audio[..., :padded_samples]
                
            eighth_note_duration = 60.0 / bpm / 2.0
            fade_samples = int(eighth_note_duration * sample_rate)
            max_fade_samples = padded_samples - exact_samples
            if fade_samples > max_fade_samples:
                fade_samples = max_fade_samples
                
            if fade_samples > 0:
                w = torch.linspace(1.0, 0.0, steps=fade_samples, device=audio.device, dtype=audio.dtype).unsqueeze(0).unsqueeze(0)
                audio[:, :, exact_samples:exact_samples + fade_samples] *= w
                
            if exact_samples + fade_samples < padded_samples:
                audio[:, :, exact_samples + fade_samples:] = 0.0
        else:
            if audio.shape[-1] > exact_samples:
                audio = audio[..., :exact_samples]
            elif audio.shape[-1] < exact_samples:
                padding = torch.zeros((*audio.shape[:-1], exact_samples - audio.shape[-1]), device=audio.device, dtype=audio.dtype)
                audio = torch.cat([audio, padding], dim=-1)

        # Apply smooth crossfade blending at boundaries for continuation, response, and inpainting modes
        if init_audio_path and remix_mode in ["continuation", "response", "inpaint"]:
            try:
                import torchaudio.transforms as T
                # Resample init_waveform to target sample_rate if needed
                if init_sr != sample_rate:
                    resampler = T.Resample(init_sr, sample_rate).to(audio.device)
                    init_waveform_resampled = resampler(init_waveform.to(audio.device))
                else:
                    init_waveform_resampled = init_waveform.to(audio.device)
                
                # Align channels
                if init_waveform_resampled.ndim == 2:
                    if init_waveform_resampled.shape[0] == 1 and audio.shape[1] == 2:
                        init_waveform_resampled = init_waveform_resampled.repeat(2, 1)
                    elif init_waveform_resampled.shape[0] > 2:
                        init_waveform_resampled = init_waveform_resampled[:2, :]
                
                overlap_sec = 0.3
                orig_len = init_waveform_resampled.shape[1]
                gen_len = audio.shape[2]
                
                if remix_mode in ["continuation", "response"]:
                    boundary_sec = continue_start if remix_mode == "continuation" else (duration / 2.0)
                    mask_start_sec = max(0.0, boundary_sec - overlap_sec)
                    
                    boundary_idx = min(gen_len, int(boundary_sec * sample_rate))
                    mask_start_idx = min(gen_len, int(mask_start_sec * sample_rate))
                    
                    boundary_idx = min(boundary_idx, orig_len)
                    mask_start_idx = min(mask_start_idx, orig_len)
                    
                    overlap_samples = boundary_idx - mask_start_idx
                    if overlap_samples > 0:
                        w = torch.linspace(0.0, 1.0, steps=overlap_samples, device=audio.device, dtype=audio.dtype).unsqueeze(0)
                        for i in range(num_variants):
                            audio[i, :, :mask_start_idx] = init_waveform_resampled[:, :mask_start_idx]
                            orig_seg = init_waveform_resampled[:, mask_start_idx:boundary_idx]
                            gen_seg = audio[i, :, mask_start_idx:boundary_idx]
                            audio[i, :, mask_start_idx:boundary_idx] = (1.0 - w) * orig_seg + w * gen_seg
                            
                elif remix_mode == "inpaint":
                    boundary1_sec = inpaint_start
                    mask_start_sec = max(0.0, inpaint_start - overlap_sec)
                    boundary2_sec = inpaint_end
                    mask_end_sec = min(duration, inpaint_end + overlap_sec)
                    
                    boundary1_idx = min(gen_len, int(boundary1_sec * sample_rate))
                    mask_start_idx = min(gen_len, int(mask_start_sec * sample_rate))
                    boundary2_idx = min(gen_len, int(boundary2_sec * sample_rate))
                    mask_end_idx = min(gen_len, int(mask_end_sec * sample_rate))
                    
                    boundary1_idx = min(boundary1_idx, orig_len)
                    mask_start_idx = min(mask_start_idx, orig_len)
                    boundary2_idx = min(boundary2_idx, orig_len)
                    mask_end_idx = min(mask_end_idx, orig_len)
                    
                    overlap1_samples = boundary1_idx - mask_start_idx
                    overlap2_samples = mask_end_idx - boundary2_idx
                    
                    for i in range(num_variants):
                        audio[i, :, :mask_start_idx] = init_waveform_resampled[:, :mask_start_idx]
                        
                        if overlap1_samples > 0:
                            w1 = torch.linspace(0.0, 1.0, steps=overlap1_samples, device=audio.device, dtype=audio.dtype).unsqueeze(0)
                            orig_seg1 = init_waveform_resampled[:, mask_start_idx:boundary1_idx]
                            gen_seg1 = audio[i, :, mask_start_idx:boundary1_idx]
                            audio[i, :, mask_start_idx:boundary1_idx] = (1.0 - w1) * orig_seg1 + w1 * gen_seg1
                            
                        if overlap2_samples > 0:
                            w2 = torch.linspace(0.0, 1.0, steps=overlap2_samples, device=audio.device, dtype=audio.dtype).unsqueeze(0)
                            orig_seg2 = init_waveform_resampled[:, boundary2_idx:mask_end_idx]
                            gen_seg2 = audio[i, :, boundary2_idx:mask_end_idx]
                            audio[i, :, boundary2_idx:mask_end_idx] = (1.0 - w2) * gen_seg2 + w2 * orig_seg2
                            
                        if mask_end_idx < orig_len:
                            audio[i, :, mask_end_idx:orig_len] = init_waveform_resampled[:, mask_end_idx:orig_len]
            except Exception as blend_err:
                print(f"[Blending] Error crossfading audio boundaries: {blend_err}")

        # Save to track_X folder inside the session directory
        with jobs_lock:
            jobs[job_id]["progress"] = "Saving and metadata tagging WAV files…"
        track_dir_name = f"track_{track_num}"
        out_dir = os.path.join(SESSION_DIR, track_dir_name)
        os.makedirs(out_dir, exist_ok=True)

        prompt_slug = slugify_prompt(prompt, 16)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        files = []
        for i in range(num_variants):
            if prompt_slug:
                filename = f"track_{track_num}_{prompt_slug}_var_{i + 1}_{timestamp}.wav"
            else:
                filename = f"track_{track_num}_var_{i + 1}_{timestamp}.wav"
            file_path = os.path.join(out_dir, filename)
            torchaudio.save(file_path, audio[i].cpu(), sample_rate)
            
            # Embed ACIDized loop and beat grid metadata
            is_var_loop = loop
            if i == 3 and is_drum:
                is_var_loop = False
            acidize_wav_file(file_path, bpm, duration, is_var_loop, prompt)
            
            # Retain relative path format for API response: session_YYYYMMDD_HHMMSS/track_X/filename.wav
            files.append(f"{SESSION_DIR_NAME}/{track_dir_name}/{filename}")

        with jobs_lock:
            jobs[job_id].update({
                "status": "done",
                "progress": None,
                "elapsed": elapsed,
                "files": files,
                "prompt": final_prompt,
                "track_num": track_num,
            })

    except Exception as e:
        import traceback
        traceback.print_exc()
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(e)

def _run_regeneration(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num, unlocked_indices, duration_padding_sec=0.0, seed=-1):
    global model
    try:
        with jobs_lock:
            jobs[job_id]["status"] = "generating"
            jobs[job_id]["progress"] = "Preparing prompt…"

        final_prompt = enhance_prompt(prompt, bpm, duration, loop)
        num_variants = len(unlocked_indices)
        
        # Build prompt list for target indices: make index 3 a fill if it's a drum prompt
        prompts_list = []
        is_drum = is_drum_prompt(prompt)
        for target_idx in unlocked_indices:
            if target_idx == 3 and is_drum:
                fill_prompt = enhance_prompt(prompt, bpm, duration, loop=False)
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

        print(f"\n[Prompt Enhancement] Original (Regen): '{prompt}'")
        for gen_i, target_idx in enumerate(unlocked_indices):
            print(f"[Prompt Enhancement] Regenerating Variant {target_idx+1} with Enhanced: '{prompts_list[gen_i]}'")
        print()

        global first_generation_completed
        with jobs_lock:
            if not first_generation_completed:
                jobs[job_id]["progress"] = "Compiling Diffusion Transformer (45-60s on first run)…"
            else:
                jobs[job_id]["progress"] = "Running diffusion model (0% done)…"

        def progress_callback(info):
            if "stage" in info:
                stage = info["stage"]
                if stage == "vae_start":
                    progress_msg = "Decoding audio latents using VAE (30-40s)…"
                elif stage == "vae_end":
                    progress_msg = "VAE decoding completed…"
                else:
                    progress_msg = f"Stage: {stage}…"
                with jobs_lock:
                    jobs[job_id]["progress"] = progress_msg
                return
            step = info.get('i', 0)
            pct = int((step + 1) / steps * 100)
            with jobs_lock:
                jobs[job_id]["progress"] = f"Generating diffusion model (step {step + 1}/{steps} - {pct}%)…"

        start_gen = time.time()

        pad_sec = 2.0 if loop else 0.0
        gen_duration = duration + pad_sec
        with model_lock:
            with torch.inference_mode():
                gen_kwargs = {
                    "prompt": prompts_list,
                    "negative_prompt": "poor quality, bad quality, low quality, noise, distortion, artifact",
                    "duration": duration,
                    "steps": steps,
                    "cfg_scale": cfg_scale,
                    "batch_size": num_variants,
                    "seed": seed,
                    "duration_padding_sec": pad_sec,
                    "truncate_output_to_duration": False,
                    "callback": progress_callback,
                }
                
                audio = model.generate(**gen_kwargs)
                first_generation_completed = True

        audio = audio.clone()
        with jobs_lock:
            jobs[job_id]["progress"] = "Processing audio & blending loop transitions…"
        elapsed = time.time() - start_gen

        # Apply loop tail headroom preservation and fade-out feathering
        sample_rate = model.model.sample_rate
        exact_samples = int(duration * sample_rate)
        
        if loop:
            padded_samples = int((duration + 2.0) * sample_rate)
            if audio.shape[-1] < padded_samples:
                padding = torch.zeros((*audio.shape[:-1], padded_samples - audio.shape[-1]), device=audio.device, dtype=audio.dtype)
                audio = torch.cat([audio, padding], dim=-1)
            elif audio.shape[-1] > padded_samples:
                audio = audio[..., :padded_samples]
                
            eighth_note_duration = 60.0 / bpm / 2.0
            fade_samples = int(eighth_note_duration * sample_rate)
            max_fade_samples = padded_samples - exact_samples
            if fade_samples > max_fade_samples:
                fade_samples = max_fade_samples
                
            if fade_samples > 0:
                w = torch.linspace(1.0, 0.0, steps=fade_samples, device=audio.device, dtype=audio.dtype).unsqueeze(0).unsqueeze(0)
                audio[:, :, exact_samples:exact_samples + fade_samples] *= w
                
            if exact_samples + fade_samples < padded_samples:
                audio[:, :, exact_samples + fade_samples:] = 0.0
        else:
            if audio.shape[-1] > exact_samples:
                audio = audio[..., :exact_samples]
            elif audio.shape[-1] < exact_samples:
                padding = torch.zeros((*audio.shape[:-1], exact_samples - audio.shape[-1]), device=audio.device, dtype=audio.dtype)
                audio = torch.cat([audio, padding], dim=-1)

        # Target directory inside session
        track_dir_name = f"track_{track_num}"
        out_dir = os.path.join(SESSION_DIR, track_dir_name)
        os.makedirs(out_dir, exist_ok=True)

        prompt_slug = slugify_prompt(prompt, 16)
        timestamp = time.strftime("%Y%m%d_%H%M%S")

        # Scan out_dir for all files matching this track
        existing_files = {}
        for f in os.listdir(out_dir):
            if f.endswith(".wav"):
                for var_idx in range(1, 5):
                    if f"_var_{var_idx}_" in f:
                        existing_files[var_idx - 1] = f
                        break

        # Generate and save new files for unlocked_indices
        with jobs_lock:
            jobs[job_id]["progress"] = "Saving and metadata tagging WAV files…"
        for gen_i, target_idx in enumerate(unlocked_indices):
            # Delete old file if exists
            old_f = existing_files.get(target_idx)
            if old_f:
                old_f_path = os.path.join(out_dir, old_f)
                if os.path.exists(old_f_path):
                    try:
                        os.remove(old_f_path)
                    except Exception as del_err:
                        print(f"[Regen] Error deleting old file {old_f_path}: {del_err}")

            # Save new file
            if prompt_slug:
                new_filename = f"track_{track_num}_{prompt_slug}_var_{target_idx + 1}_{timestamp}.wav"
            else:
                new_filename = f"track_{track_num}_var_{target_idx + 1}_{timestamp}.wav"
            
            file_path = os.path.join(out_dir, new_filename)
            torchaudio.save(file_path, audio[gen_i].cpu(), sample_rate)
            
            # Embed ACIDized loop and beat grid metadata
            is_var_loop = loop
            if target_idx == 3 and is_drum:
                is_var_loop = False
            acidize_wav_file(file_path, bpm, duration, is_var_loop, prompt)
            
            # Update existing_files map with new filename
            existing_files[target_idx] = new_filename

        # Compile final files list in sorted order of variant index (0 to 3)
        files = []
        for i in range(4):
            f_name = existing_files.get(i)
            if f_name:
                files.append(f"{SESSION_DIR_NAME}/{track_dir_name}/{f_name}")
            else:
                files.append("")

        with jobs_lock:
            jobs[job_id].update({
                "status": "done",
                "progress": None,
                "elapsed": elapsed,
                "files": files,
                "prompt": final_prompt,
                "track_num": track_num,
            })

    except Exception as e:
        import traceback
        traceback.print_exc()
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(e)

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

# ---------------------------------------------------------------------------
# Flask App Setup & Routes
# ---------------------------------------------------------------------------

app = Flask(__name__)

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
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400

    bpm = max(40, min(300, int(data.get("bpm", 120))))
    num_variants = max(1, min(32, int(data.get("num_variants", 4))))
    loop = bool(data.get("loop", True))
    steps = int(data.get("steps", 8))
    cfg_scale = float(data.get("cfg_scale", 1.0))
    seed = int(data.get("seed", -1))
    duration_padding_sec = float(data.get("duration_padding_sec", 0.0))
    duration = float(data.get("duration", 960.0 / bpm))

    init_audio_path = data.get("init_audio_path")
    init_noise_level = float(data.get("init_noise_level", 0.6))
    remix_mode = data.get("remix_mode", "variation")
    inpaint_start = float(data.get("inpaint_start", 0.0))
    inpaint_end = float(data.get("inpaint_end", 0.0))
    continue_start = float(data.get("continue_start", 0.0))
    invert_timing = bool(data.get("invert_timing", False))

    # Determine track number sequentially
    with jobs_lock:
        track_num = get_next_track_index()
        # Prevent collision if multiple generate tasks are started concurrently
        active_tracks = [j.get("track_num") for j in jobs.values() if j.get("status") in ["queued", "generating"]]
        while track_num in active_tracks:
            track_num += 1

    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": None,
            "error": None,
            "elapsed": None,
            "files": None,
            "prompt": prompt,
            "track_num": track_num,
        }

    threading.Thread(
        target=_run_generation,
        args=(job_id, prompt, bpm, duration, num_variants, loop, steps, cfg_scale, track_num, duration_padding_sec),
        kwargs={
            "init_audio_path": init_audio_path,
            "init_noise_level": init_noise_level,
            "seed": seed,
            "remix_mode": remix_mode,
            "inpaint_start": inpaint_start,
            "inpaint_end": inpaint_end,
            "continue_start": continue_start,
            "invert_timing": invert_timing
        },
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})

@app.post("/api/regenerate")
def api_regenerate():
    data = request.json or {}
    track_num = int(data.get("track_num"))
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400

    bpm = max(40, min(300, int(data.get("bpm", 120))))
    loop = bool(data.get("loop", True))
    steps = int(data.get("steps", 8))
    cfg_scale = float(data.get("cfg_scale", 1.0))
    seed = int(data.get("seed", -1))
    duration_padding_sec = float(data.get("duration_padding_sec", 0.0))
    duration = float(data.get("duration", 960.0 / bpm))

    
    unlocked_indices = data.get("unlocked_indices", [])
    if not unlocked_indices:
        return jsonify({"error": "No unlocked indices provided"}), 400

    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": None,
            "error": None,
            "elapsed": None,
            "files": None,
            "prompt": prompt,
            "track_num": track_num,
        }

    threading.Thread(
        target=_run_regeneration,
        args=(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num, unlocked_indices, duration_padding_sec, seed),
        daemon=True
    ).start()

    return jsonify({"job_id": job_id})

@app.route("/api/status/<job_id>")
def api_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Unknown job"}), 404
    return jsonify(job)

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
    file_path = data.get("file_path")
    if not file_path:
        return jsonify({"error": "File path is required"}), 400

    # Prevent directory traversal attacks
    safe_path = os.path.normpath(file_path).lstrip(os.path.sep)
    if safe_path.startswith("..") or os.path.isabs(safe_path):
        return jsonify({"error": "Invalid file path"}), 400

    full_path = os.path.join(OUTPUT_DIR, safe_path)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        try:
            os.remove(full_path)
            print(f"Deleted variant file: {full_path}")
            return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "File not found"}), 404

@app.post("/api/convert")
def api_convert():
    try:
        target_format = request.form.get("format", "wav").lower()
        if target_format not in ["mp3", "ogg", "wav"]:
            return jsonify({"error": f"Unsupported format: {target_format}"}), 400

        # Case A: Local file path on the server
        file_path = request.form.get("file_path")
        if file_path:
            # Prevent directory traversal attacks
            safe_path = os.path.normpath(file_path).lstrip(os.path.sep)
            if safe_path.startswith("..") or os.path.isabs(safe_path):
                return jsonify({"error": "Invalid file path"}), 400
                
            input_path = os.path.join(OUTPUT_DIR, safe_path)
            if not os.path.exists(input_path):
                return jsonify({"error": "File not found"}), 404

            if target_format == "wav":
                return send_from_directory(OUTPUT_DIR, safe_path, as_attachment=True)
                
            out_filename = os.path.splitext(os.path.basename(input_path))[0] + f".{target_format}"
            output_path = os.path.join(OUTPUT_DIR, f"conv_{uuid.uuid4().hex}.{target_format}")
            
            # Run ffmpeg
            import subprocess
            quality_arg = "4" if target_format == "ogg" else "2"
            subprocess.run(["ffmpeg", "-y", "-i", input_path, "-q:a", quality_arg, output_path], check=True)
            
            @after_this_request
            def remove_file(response):
                try:
                    os.remove(output_path)
                except Exception as e:
                    print(f"Error removing temp file {output_path}: {e}")
                return response
                
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
        subprocess.run(["ffmpeg", "-y", "-i", temp_in, "-q:a", quality_arg, temp_out], check=True)

        @after_this_request
        def clean_all(response):
            try:
                os.remove(temp_in)
                os.remove(temp_out)
            except Exception as e:
                print(f"Error cleaning temp files: {e}")
            return response

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

    print(f"\n  [OK] Grid Generator running at http://127.0.0.1:{args.port}\n")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)
