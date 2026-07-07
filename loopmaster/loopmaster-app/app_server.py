"""
Stable Audio 3 — Grid Generator Backend (Pure Flask Server)
Ripped out Gradio dependencies to focus on custom web interface.
"""

import os
import sys
import re

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

from wav_metadata import (
    is_drum_prompt, parse_root_note, create_labl_chunk, create_adtl_list,
    pack_cue_chunk, find_data_chunk_offset, acidize_wav_file, enhance_prompt
)

def _execute_model_task(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num, num_variants=4, unlocked_indices=None, duration_padding_sec=0.0, init_audio_path=None, init_noise_level=0.6, seed=-1, remix_mode="variation", inpaint_start=0.0, inpaint_end=0.0, continue_start=0.0, invert_timing=False):
    global model
    is_regeneration = unlocked_indices is not None
    target_indices = unlocked_indices if is_regeneration else list(range(num_variants))
    num_to_generate = len(target_indices)

    try:
        with jobs_lock:
            jobs[job_id]["status"] = "generating"
            jobs[job_id]["progress"] = "Preparing prompt…"

        final_prompt = enhance_prompt(prompt, bpm, duration, loop)
        
        prompts_list = []
        is_drum = is_drum_prompt(prompt)
        for target_idx in target_indices:
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

        print(f"\n[Prompt Enhancement] Original: '{prompt}'")
        for i, target_idx in enumerate(target_indices):
            print(f"[Prompt Enhancement] Variant {target_idx+1} Enhanced: '{prompts_list[i]}'")
        print()

        global first_generation_completed
        with jobs_lock:
            if not first_generation_completed:
                jobs[job_id]["progress"] = "Warming up diffusion model (first run)…"
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

        start_gen = time.time()

        seed_audio = None
        gen_duration = duration + (2.0 if loop else 0.0)
        if init_audio_path:
            full_init_path = os.path.join(OUTPUT_DIR, init_audio_path)
            if os.path.exists(full_init_path) and os.path.isfile(full_init_path):
                try:
                    init_waveform, init_sr = torchaudio.load(full_init_path)
                    
                    if invert_timing:
                        init_waveform = torch.flip(init_waveform, dims=[-1])
                        print(f"[Seed Audio] Inverted timing/progression (reversed waveform along time dimension) for {full_init_path}.")

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
                    err_msg = f"Error loading {full_init_path}: {load_err}"
                    print(f"[Seed Audio] {err_msg}")
                    with jobs_lock:
                        jobs[job_id]["progress"] = f"[Seed Audio] {err_msg}"

        with model_lock:
            with torch.inference_mode():
                pad_sec = 2.0 if loop else 0.0
                gen_kwargs = {
                    "prompt": prompts_list,
                    "negative_prompt": "poor quality, bad quality, low quality, noise, distortion, artifact",
                    "duration": duration,
                    "steps": steps,
                    "cfg_scale": cfg_scale,
                    "batch_size": num_to_generate,
                    "seed": seed,
                    "duration_padding_sec": pad_sec,
                    "truncate_output_to_duration": False,
                    "callback": progress_callback,
                    "chunked_decode": True,
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
                        overlap_sec = 0.3
                        mask_start = max(0.0, continue_start - overlap_sec)
                        gen_kwargs["inpaint_mask_start_seconds"] = mask_start
                        gen_kwargs["inpaint_mask_end_seconds"] = max(duration, gen_duration) + 10.0
                        print(f"[Generation] Running continuation keeping first {mask_start}s (overlap: {overlap_sec}s).")
                
                audio = model.generate(**gen_kwargs)
                first_generation_completed = True

        audio = audio.clone()
        with jobs_lock:
            jobs[job_id]["progress"] = "Processing audio & blending loop transitions…"
        elapsed = time.time() - start_gen

        sample_rate = model.model.sample_rate
        exact_samples = int(duration * sample_rate)
        
        if loop:
            # The model generated exact_samples + padding samples.
            # To create a seamless loop, we take the tail (everything after exact_samples)
            # and add it back to the beginning of the audio.
            if audio.shape[-1] > exact_samples:
                tail = audio[..., exact_samples:]
                
                # We can only add as much tail as there is head
                mix_len = min(tail.shape[-1], exact_samples)
                audio[..., :mix_len] += tail[..., :mix_len]
            
            # Truncate strictly to exact_samples to maintain perfect tempo alignment
            audio = audio[..., :exact_samples]
            
            # We still need to ensure it's exactly exact_samples in case the model generated too few
            if audio.shape[-1] < exact_samples:
                padding = torch.zeros((*audio.shape[:-1], exact_samples - audio.shape[-1]), device=audio.device, dtype=audio.dtype)
                audio = torch.cat([audio, padding], dim=-1)
        else:
            if audio.shape[-1] > exact_samples:
                audio = audio[..., :exact_samples]
            elif audio.shape[-1] < exact_samples:
                padding = torch.zeros((*audio.shape[:-1], exact_samples - audio.shape[-1]), device=audio.device, dtype=audio.dtype)
                audio = torch.cat([audio, padding], dim=-1)

        if init_audio_path and remix_mode in ["continuation", "response", "inpaint"]:
            try:
                import torchaudio.transforms as T
                if init_sr != sample_rate:
                    resampler = T.Resample(init_sr, sample_rate).to(audio.device)
                    init_waveform_resampled = resampler(init_waveform.to(audio.device))
                else:
                    init_waveform_resampled = init_waveform.to(audio.device)
                
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
                        for i in range(num_to_generate):
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
                    
                    for i in range(num_to_generate):
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

        with jobs_lock:
            jobs[job_id]["progress"] = "Saving and metadata tagging WAV files…"
        track_dir_name = f"track_{track_num}"
        out_dir = os.path.join(SESSION_DIR, track_dir_name)
        os.makedirs(out_dir, exist_ok=True)

        prompt_slug = slugify_prompt(prompt, 16)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        
        # Scan out_dir for all existing files matching this track
        existing_files = {}
        for f in os.listdir(out_dir):
            if f.endswith(".wav"):
                for var_idx in range(1, num_variants + 1):
                    if f"_var_{var_idx}_" in f:
                        existing_files[var_idx - 1] = f
                        break
        
        for gen_i, target_idx in enumerate(target_indices):
            # Delete old file if exists
            old_f = existing_files.get(target_idx)
            if old_f:
                old_f_path = os.path.join(out_dir, old_f)
                if os.path.exists(old_f_path):
                    try:
                        os.remove(old_f_path)
                    except Exception as del_err:
                        print(f"[{'Regen' if is_regeneration else 'Generation'}] Error deleting old file {old_f_path}: {del_err}")

            if prompt_slug:
                filename = f"track_{track_num}_{bpm}bpm_{prompt_slug}_var_{target_idx + 1}_{timestamp}.wav"
            else:
                filename = f"track_{track_num}_{bpm}bpm_var_{target_idx + 1}_{timestamp}.wav"
            file_path = os.path.join(out_dir, filename)
            torchaudio.save(file_path, audio[gen_i].cpu(), sample_rate)
            
            is_var_loop = loop
            if target_idx == 3 and is_drum:
                is_var_loop = False
            acidize_wav_file(file_path, bpm, duration, is_var_loop, prompt)
            
            existing_files[target_idx] = filename

        files = []
        for i in range(num_variants):
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
            completed = [jid for jid, j in jobs.items() if j.get("status") in ["done", "error"]]
            if len(completed) > 50:
                oldest_completed = sorted(completed, key=lambda x: list(jobs.keys()).index(x))[:-50]
                for jid in oldest_completed:
                    del jobs[jid]

    except Exception as e:
        import traceback
        traceback.print_exc()
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(e)
            completed = [jid for jid, j in jobs.items() if j.get("status") in ["done", "error"]]
            if len(completed) > 50:
                oldest_completed = sorted(completed, key=lambda x: list(jobs.keys()).index(x))[:-50]
                for jid in oldest_completed:
                    del jobs[jid]
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    finally:
        if 'audio' in locals():
            del audio
        if 'init_waveform' in locals():
            del init_waveform
        if 'seed_audio' in locals():
            del seed_audio

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
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400

    bpm = max(40, min(300, int(data.get("bpm", 120))))
    num_variants = max(1, min(8, int(data.get("num_variants", 4))))
    loop = bool(data.get("loop", True))
    steps = int(data.get("steps", 8))
    cfg_scale = float(data.get("cfg_scale", 1.0))
    seed = int(data.get("seed", -1))
    duration_padding_sec = float(data.get("duration_padding_sec", 0.0))
    duration = max(1.0, min(60.0, float(data.get("duration", 960.0 / bpm))))

    init_audio_path = data.get("init_audio_path")
    if init_audio_path:
        safe_path = os.path.normpath(init_audio_path).lstrip(os.path.sep)
        if safe_path.startswith("..") or os.path.isabs(safe_path):
            return jsonify({"error": "Invalid init_audio_path"}), 400
        init_audio_path = safe_path

    init_noise_level = float(data.get("init_noise_level", 0.6))
    remix_mode = data.get("remix_mode", "variation")
    inpaint_start = float(data.get("inpaint_start", 0.0))
    inpaint_end = float(data.get("inpaint_end", 0.0))
    continue_start = float(data.get("continue_start", 0.0))
    invert_timing = bool(data.get("invert_timing", False))

    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        track_num = get_next_track_index()
        # Prevent collision if multiple generate tasks are started concurrently
        active_tracks = [j.get("track_num") for j in jobs.values() if j.get("status") in ["queued", "generating"]]
        while track_num in active_tracks:
            track_num += 1

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
        target=_execute_model_task,
        args=(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num),
        kwargs={
            "num_variants": num_variants,
            "duration_padding_sec": duration_padding_sec,
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
        target=_execute_model_task,
        args=(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num),
        kwargs={
            "unlocked_indices": unlocked_indices,
            "duration_padding_sec": duration_padding_sec,
            "seed": seed
        },
        daemon=True
    ).start()

    return jsonify({"job_id": job_id})

@app.route("/status")
def server_status():
    return "OK", 200

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
