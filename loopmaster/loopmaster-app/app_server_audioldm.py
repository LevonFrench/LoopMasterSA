import os
import sys
import re

os.environ["HF_HOME"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "huggingface"))
os.environ["TORCH_HOME"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "torch"))

import uuid
import time
import threading
import argparse
import torch
import torchaudio
from flask import Flask, request, jsonify, send_from_directory, send_file, after_this_request
import traceback

current_dir = os.path.dirname(os.path.abspath(__file__))
from wav_metadata import acidize_wav_file, enhance_prompt

# Ensure output dirs
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(SCRIPT_DIR, "static")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)

SESSION_TIMESTAMP = time.strftime("%Y%m%d_%H%M%S")
SESSION_DIR_NAME = f"session_{SESSION_TIMESTAMP}"
SESSION_DIR = os.path.join(OUTPUT_DIR, SESSION_DIR_NAME)
os.makedirs(SESSION_DIR, exist_ok=True)

model = None
model_lock = threading.Lock()
jobs = {}
jobs_lock = threading.Lock()

def get_next_track_index():
    if not os.path.exists(SESSION_DIR):
        return 1
    max_idx = 0
    for name in os.listdir(SESSION_DIR):
        if name.startswith("track_") and os.path.isdir(os.path.join(SESSION_DIR, name)):
            try:
                idx = int(name.split("_")[1])
                if idx > max_idx:
                    max_idx = idx
            except:
                pass
    return max_idx + 1

def slugify_prompt(prompt, limit=16):
    cleaned = re.sub(r'[^a-zA-Z0-9\s_-]', '', prompt)
    cleaned = re.sub(r'[\s_-]+', '_', cleaned).strip('_')
    return cleaned[:limit]

def load_model(model_name):
    global model
    from diffusers import AudioLDM2Pipeline
    
    mapping = {
        'audioldm2': 'cvssp/audioldm2',
        'audioldm2-large': 'cvssp/audioldm2-large',
        'audioldm2-music': 'cvssp/audioldm2-music'
    }
    hf_model = mapping.get(model_name, model_name)
    
    print(f"Loading AudioLDM 2 model '{hf_model}'...")
    start = time.time()
    
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32
    
    model = AudioLDM2Pipeline.from_pretrained(hf_model, torch_dtype=dtype)
    model = model.to(device)
    print(f"Model loaded in {time.time() - start:.2f}s on {device}")

def _execute_model_task(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num, num_variants=4, unlocked_indices=None):
    global model
    is_regeneration = unlocked_indices is not None
    target_indices = unlocked_indices if is_regeneration else list(range(num_variants))
    num_to_generate = len(target_indices)

    try:
        with jobs_lock:
            jobs[job_id]["status"] = "generating"
            jobs[job_id]["progress"] = "Preparing prompt..."
            
        final_prompt = enhance_prompt(prompt, bpm, duration, loop, engine="audioldm")
        
        with jobs_lock:
            jobs[job_id]["progress"] = "Running AudioLDM 2..."

        start_gen = time.time()
        
        with model_lock:
            # Generate multiple waveforms for the single prompt
            output = model(
                final_prompt,
                num_inference_steps=steps,
                audio_length_in_s=duration,
                num_waveforms_per_prompt=num_to_generate,
                guidance_scale=cfg_scale
            )
            audios = output.audios

        elapsed = time.time() - start_gen
        
        with jobs_lock:
            jobs[job_id]["progress"] = "Processing audio & blending loop transitions..."

        # AudioLDM2 typically uses 16000 Hz or similar, we'll check its config or assume from output
        # `audios` is a numpy array of shape (batch_size, sequence_length)
        # Convert to torch tensor
        audio_tensor = torch.from_numpy(audios).unsqueeze(1) # shape: (batch_size, 1, seq_len)
        
        # AudioLDM 2 outputs at 16000Hz (base)
        sample_rate = 16000
        
        # Make stereo if we want it to match frontend expectations (duplicate channels)
        audio_tensor = audio_tensor.repeat(1, 2, 1) # shape: (batch_size, 2, seq_len)
        
        exact_samples = int(duration * sample_rate)

        # Crossfade tail for seamless loop
        if loop:
            if audio_tensor.shape[-1] > exact_samples:
                audio_tensor = audio_tensor[..., :exact_samples]
            elif audio_tensor.shape[-1] < exact_samples:
                padding = torch.zeros((*audio_tensor.shape[:-1], exact_samples - audio_tensor.shape[-1]), device=audio_tensor.device, dtype=audio_tensor.dtype)
                audio_tensor = torch.cat([audio_tensor, padding], dim=-1)

        track_dir_name = f"track_{track_num}"
        out_dir = os.path.join(SESSION_DIR, track_dir_name)
        os.makedirs(out_dir, exist_ok=True)

        prompt_slug = slugify_prompt(prompt, 16)
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        
        existing_files = {}
        for f in os.listdir(out_dir):
            if f.endswith(".wav"):
                for var_idx in range(1, num_variants + 1):
                    if f"_var_{var_idx}_" in f:
                        existing_files[var_idx - 1] = f
                        break
                        
        for gen_i, target_idx in enumerate(target_indices):
            old_f = existing_files.get(target_idx)
            if old_f:
                old_f_path = os.path.join(out_dir, old_f)
                if os.path.exists(old_f_path):
                    try:
                        os.remove(old_f_path)
                    except: pass
            
            filename = f"track_{track_num}_{prompt_slug}_var_{target_idx + 1}_{timestamp}.wav"
            file_path = os.path.join(out_dir, filename)
            
            wav_t = audio_tensor[gen_i]
            torchaudio.save(file_path, wav_t, sample_rate)
            acidize_wav_file(file_path, bpm, duration, loop, prompt)
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
            
    except Exception as e:
        traceback.print_exc()
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(e)

# Flask API Setup
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
    if not prompt: return jsonify({"error": "Prompt is required"}), 400
    bpm = int(data.get("bpm", 120))
    num_variants = int(data.get("num_variants", 4))
    loop = bool(data.get("loop", True))
    
    # AudioLDM2 uses standard num_inference_steps, usually 50-200.
    # SA3 used 'steps' from frontend. We might want to cap it.
    steps = int(data.get("steps", 50))
    if steps > 200: steps = 50
    
    cfg_scale = float(data.get("cfg_scale", 3.5))
    duration = float(data.get("duration", 960.0 / bpm))

    with jobs_lock:
        track_num = get_next_track_index()
        active_tracks = [j.get("track_num") for j in jobs.values() if j.get("status") in ["queued", "generating"]]
        while track_num in active_tracks: track_num += 1

    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued", "progress": None, "error": None, "elapsed": None,
            "files": None, "prompt": prompt, "track_num": track_num,
        }

    threading.Thread(
        target=_execute_model_task,
        args=(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num),
        kwargs={"num_variants": num_variants},
        daemon=True,
    ).start()

    return jsonify({"job_id": job_id})

@app.post("/api/regenerate")
def api_regenerate():
    data = request.json or {}
    track_num = int(data.get("track_num"))
    prompt = data.get("prompt", "").strip()
    if not prompt: return jsonify({"error": "Prompt is required"}), 400

    bpm = int(data.get("bpm", 120))
    loop = bool(data.get("loop", True))
    steps = int(data.get("steps", 50))
    if steps > 200: steps = 50
    cfg_scale = float(data.get("cfg_scale", 3.5))
    duration = float(data.get("duration", 960.0 / bpm))
    
    unlocked_indices = data.get("unlocked_indices", [])

    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[job_id] = {
            "status": "queued", "progress": None, "error": None, "elapsed": None,
            "files": None, "prompt": prompt, "track_num": track_num,
        }

    threading.Thread(
        target=_execute_model_task,
        args=(job_id, prompt, bpm, duration, loop, steps, cfg_scale, track_num),
        kwargs={"unlocked_indices": unlocked_indices},
        daemon=True
    ).start()

    return jsonify({"job_id": job_id})

@app.route("/api/status/<job_id>")
def api_status(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job: return jsonify({"error": "Unknown job"}), 404
    return jsonify(job)

@app.route("/api/delete_track/<int:track_num>", methods=["POST"])
def api_delete_track(track_num):
    track_dir = os.path.join(SESSION_DIR, f"track_{track_num}")
    if os.path.exists(track_dir) and os.path.isdir(track_dir):
        try:
            import shutil
            shutil.rmtree(track_dir)
            return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Track not found"}), 404

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="audioldm2")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    # Pre-load model
    load_model(args.model)

    print(f"\n  [OK] AudioLDM 2 Grid Generator running at http://127.0.0.1:{args.port}\n")
    app.run(host=args.host, port=args.port, debug=False, threaded=True)
