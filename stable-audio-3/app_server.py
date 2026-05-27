"""
Stable Audio 3 — Grid Generator Backend (Pure Flask Server)
Ripped out Gradio dependencies to focus on custom web interface.
"""

import os
import sys
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
from flask import Flask, request, jsonify, send_from_directory

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
        
        if any(k in prompt_lower for k in sfx_keywords):
            final_prompt = f"TrackType: SFX, {prompt}"
        elif any(k in prompt_lower for k in instrument_keywords) or (loop and "loop" in prompt_lower):
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

    # 4. Standardized BPM & Length formatting suffix
    duration_int = int(round(duration))
    if "bpm" not in final_prompt.lower():
        final_prompt += f", BPM: {bpm}"
    if "length:" not in final_prompt.lower():
        final_prompt += f", Length: {duration_int} seconds"
        
    if loop:
        final_prompt += ", seamless loop, looping"
        
    return final_prompt

def _run_generation(job_id, prompt, bpm, duration, num_variants, loop, steps, cfg_scale, track_num, duration_padding_sec=6.0, init_audio_path=None, init_noise_level=0.6, seed=-1):
    global model
    try:
        with jobs_lock:
            jobs[job_id]["status"] = "generating"
            jobs[job_id]["progress"] = "Preparing prompt…"

        final_prompt = enhance_prompt(prompt, bpm, duration, loop)
        print(f"\n[Prompt Enhancement] Original: '{prompt}'")
        print(f"[Prompt Enhancement] Enhanced: '{final_prompt}'\n")

        with jobs_lock:
            jobs[job_id]["progress"] = f"Generating {num_variants} variants…"

        start_gen = time.time()

        # Load init audio if provided
        init_audio = None
        if init_audio_path:
            sanitized_path = os.path.normpath(init_audio_path).replace("..", "")
            full_init_path = os.path.join(OUTPUT_DIR, sanitized_path)
            if os.path.exists(full_init_path) and os.path.isfile(full_init_path):
                try:
                    init_waveform, init_sr = torchaudio.load(full_init_path)
                    if model.model_half:
                        init_waveform = init_waveform.half()
                    init_waveform = init_waveform.to(model.device)
                    init_audio = (init_sr, init_waveform)
                    print(f"[Init Audio] Loaded {full_init_path} successfully on device {model.device}.")
                except Exception as load_err:
                    print(f"[Init Audio] Error loading {full_init_path}: {load_err}")

        with model_lock:
            with torch.inference_mode():
                # Generate slightly longer than needed so content fills the entire loop
                gen_duration = duration + 2.0
                audio = model.generate(
                    prompt=final_prompt,
                    negative_prompt="poor quality, bad quality, low quality, noise, distortion, artifact",
                    duration=gen_duration,
                    steps=steps,
                    cfg_scale=cfg_scale,
                    batch_size=num_variants,
                    seed=seed,
                    duration_padding_sec=duration_padding_sec,
                    init_audio=init_audio,
                    init_noise_level=init_noise_level,
                )

        elapsed = time.time() - start_gen

        # Trim to exact loop duration (model generated extra headroom)
        sample_rate = model.model.sample_rate
        exact_samples = int(duration * sample_rate)
        audio = audio[:, :, :exact_samples]

        # Save to track_X folder inside the session directory
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
            acidize_wav_file(file_path, bpm, duration, loop, prompt)
            
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
    duration_padding_sec = float(data.get("duration_padding_sec", 6.0))
    duration = 960.0 / bpm

    init_audio_path = data.get("init_audio_path")
    init_noise_level = float(data.get("init_noise_level", 0.6))

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
        kwargs={"init_audio_path": init_audio_path, "init_noise_level": init_noise_level, "seed": seed},
        daemon=True,
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

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Stable Audio 3 Grid Generator Server")
    parser.add_argument(
        "--model", default="small-music",
        choices=["medium", "small-music", "small-sfx", "medium-base", "small-music-base", "small-sfx-base"],
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
