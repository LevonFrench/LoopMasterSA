# HANDOFF — LoopMaster SA3

## Session Summary (2026-05-27)

### What Was Done This Session

**Master Volume Fader DB-Scaling & Compression Correction**:
- Implemented a coordinated fader-to-limiter mapping in `app.js` and the `OfflineAudioContext` mixdown builder via the `getMasterFaderParams(sliderVal)` helper function.
- Set the maximum value (100% / far right) to exactly `0 dB` (unity gain, no extra amplification) and disabled the limiter threshold (`0 dB` / no compression).
- Counteracted the Web Audio dynamics compressor auto-makeup gain curve (which boosts levels as threshold is lowered) by attenuating the output `masterVolumeNode` gain correspondingly (up to `-68.5 dB` at the lowest values). This guarantees that turning the fader left always applies more compression *and* reduces the overall volume level cleanly.
- Updated the slider text readout to display decibels (e.g. `0.0 dB`, `-3.5 dB`, `-inf dB`) and wired the `.limiter-label` text to update dynamically to match the current active threshold value.

**Limiter Defaults & dB Calibration**:
- Calibrated the threshold scaling coefficient in `app.js` to exactly `28.889` so that a slider value of `91` maps precisely to a `-2.6 dB` limiter threshold.
- Set the default volume slider value in `index.html` to `91` and updated starting UI labels to display `-2.6 dB` for the limiter and `-3.6 dB` for the master volume readout on load.

**Precision Draggable Input Sensitivities**:
- Reduced the drag sensitivities for vertical adjustments on text inputs in `app.js`:
  - **BPM**: Sensitivity reduced from `0.25` to `0.08`.
  - **Seed**: Sensitivity reduced from `0.5` to `0.1`.
  - **Steps**: Sensitivity reduced from `0.25` to `0.08`.
- This ensures much more granular control and prevents overshooting values when dragging.

**Copy and Paste FX Settings Clipboard**:
- Added "Copy FX" and "Paste FX" buttons to the title of the Macro Controls section inside each track row's FX drawer.
- Implemented a clipboard in `app.js` that captures all bypass states, select values, slider values, and macro states of a track's FX drawer.
- The paste routine updates all target track DOM controls and dispatches input/change events to automatically update the underlying Web Audio API nodes instantly.

**Button Placement Swap**:
- Swapped the order of prompt buttons inside `.prompt-inline-btns` in `index.html` to place "In Key" immediately to the left of "Random".

**PyTorch & GPU Inference Optimizations**:
- Enabled TensorFloat-32 (TF32) matrix calculations (`allow_tf32 = True`) and cuDNN autotuning (`benchmark = True`) on GPU initialization inside `model.py`.
- Scheduled model compilation (`torch.compile`) targeting the core Diffusion Transformer (`DiT`) model in `model.py` when running on a CUDA device to eliminate graph execution overhead.
- Confirmed virtual environment compatibility and hardware detection mapping to the system's `NVIDIA GeForce RTX 3080 Ti` GPU.

**MP3 & OGG Export Support**:
- Added a format selector dropdown to the transport panel (`#render-format-select`).
- Created a server-side `/api/convert` endpoint that uses local FFmpeg to convert WAV audio outputs to high-quality MP3 (`-q:a 2`) and OGG (`-q:a 4`) files dynamically, cleaning up temporary files on completion.
- Connected the "Render Mix" and "Export Loops" functions in `app.js` to trigger conversions automatically, downloading the mixdown or zipping individual loops in the selected format.
- Calibrated local path transcoding in `/api/convert` to dynamically map `-q:a 4` for OGG and `-q:a 2` for MP3 to match the high-quality upload conversion settings.

---

### Key Repository Layout

```
sa3/
├── stable-audio-3/           # SA3 model library, virtualenv, localized weights
│   ├── models/               # Localized checkpoints (medium, small-music)
│   └── stable_audio_3/       # Core model package
├── loopmaster/
│   ├── loopmaster-app/       # Flask backend + JS frontend
│   │   ├── app_server.py     # API server & generation worker
│   │   └── static/           # Dashboard (index.html, app.js, app.css)
│   └── wiki/                 # Documentation
│       ├── Home.md           # Architecture & technical reference
│       └── User-Guide.md     # Feature walkthrough & workflows
├── run_server.bat            # Interactive launcher (model selector menu)
└── AGENTS.md                 # Agent operating rules
```

---

### System State
- Server runs on `http://localhost:7861`
- All features functional: generation, remixing (variation/response/inpaint/continuation), FX chain, variant locking/regen, render/export
- All sliders, knobs, inputs, and PyTorch backend execution paths are optimized and responsive.

### Next Steps
- Launch server via `run_server.bat` and select the format option (MP3 or OGG) to verify mixdown and ZIP loops downloads.
