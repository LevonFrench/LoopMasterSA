# Setup & Verification Walkthrough

This document outlines the testing workflow and environment verification.

## Walkthrough

### 14. Verification of Option A Master Limiter & Loudness Metering
We implemented and verified Option A for the master brickwall limiter and real-time level metering:
1. **Implementation**:
   - Configured `DynamicsCompressorNode` as a brickwall limiter (-11dB threshold, 0 knee, 20 ratio, 3ms attack, 100ms release) and routed all tracks through it.
   - Applied +11dB manual makeup gain via a post-limiter `GainNode` to boost limited signals to a 0dB ceiling.
   - Added `AnalyserNode` instances to each track and the master bus to fetch real-time time-domain data.
   - Created a continuous `requestAnimationFrame` loop to calculate Peak (instant rise, 12 dB/s decay), Peak Hold (1.5s hold, 15 dB/s decay), and RMS (leaky integration with alpha = 0.85).
   - Rendered the levels on horizontal canvas displays with a tri-color green/yellow/red gradient and a cyan peak-hold indicator tick.
2. **Verification via Headless Browser**:
   - Navigated to the application, generated a track, and successfully verified that the master meter container and limiter badge display correctly.
   - Verified that playing a track renders high-fidelity audio waveforms and triggers active level bouncing on both the individual track mixer strip and the master meter.
   - Verified that pausing the audio halts playback and initiates decay of both meters back to silent levels.

### 15. LoopmasterSA Renaming & Init Audio Seed Variations
We renamed the application to **LoopmasterSA** and added an Init Audio Variation feature:
1.  **Frontend Layout**: Added `✨ Init` buttons to variant card headers, wired state management in `app.js` to track the active initial audio, and added a top controls badge with a noise slider (0.10 to 0.90, default 0.60) to adjust output deviation.
2.  **Backend Integration**: Modified `app_server.py` to parse `init_audio_path` and `init_noise_level` from client requests. If present, the server loads the seed WAV file using `torchaudio.load()`, places the tensors on the model device, and passes them to `model.generate()`.
3.  **UI Verification**: Clicked on variant cards to set as seed, modified noise levels, generated similar variants successfully, and verified that generated output rows populate properly in the dashboard.

### 16. High-DPI Canvas Sizing Fix
1.  **Bug Identification**: Users on high-DPI screens or specific zoom levels noticed a giant white square blanking out the track container. This was caused by an infinite layout resizing loop: `drawMeter()` calculated `rect.height * dpr` and set it as `canvas.height` attribute, which expanded the DOM height of the canvas (since there was no CSS height constraint), which was then measured as larger in the next frame, leading to exponential canvas growth until browser memory/GPU limits were exceeded.
2.  **Fix**: Added explicit CSS dimensions (`width: 140px; height: 8px;` for `#master-meter-canvas` and `height: 6px;` for `.meter-canvas`) in `app.css`. This constrains the DOM height of the canvases and stabilizes their bounding client rectangles, preventing layout feedback loops while maintaining high-DPI rendering support.

### 17. Consolidated Packaging and Documentation
1.  **Repo Consolidation**: Removed the nested `.git` folders in `stable-audio-3` and `audio-file-mcp-app` so that the entire project structure is clean and tracked in the parent repository pointing to `LevonFrench/LoopMasterSA.git`.
2.  **Ignore rules**: Created a root-level `.gitignore` that recursively ignores virtual environments (`.venv`), temporary caches (`.gradio/`), outputs/checkpoints (`*.safetensors`, `*.ckpt`, `outputs/`), and generated `.wav` files.
3.  **Documentation**: Wrote a detailed system wiki at `wiki/Home.md` and updated the root `README.md` to provide architecture details, launcher instructions, and git distribution guidelines.
