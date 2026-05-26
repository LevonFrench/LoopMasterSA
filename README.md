# LoopMasterSA

**LoopMasterSA** is a premium, real-time synchronized multi-track loop generator and mixing dashboard built on top of the Stable Audio 3 generative music model. It provides a cohesive, browser-based studio environment to generate musical loops from text prompts, arrange them in a synchronized grid, and mix them using professional-grade channel strips and master processor nodes.

---

## Key Features

*   **Synchronized Multi-Track Playback**: Audios are decoded into high-performance Web Audio API buffers and played simultaneously in absolute synchronization, allowing seamless loop testing.
*   **Interactive Channel Strip Mixers**:
    *   **Solo / Mute / Loop**: Control focus and playback behavior per track row.
    *   **Volume & Pan Controls**: High-legibility slider controls mapped to Web Audio gain and stereo panner nodes.
    *   **Real-time Metering**: Horizontal canvas meters showing perceived loudness (RMS) and instantaneous peak transients.
*   **Integrated Master Limiter**: Built-in brickwall master limiter (`DynamicsCompressorNode` at `-11dB` threshold, hard knee, `20` ratio, `3ms` attack, `100ms` release) combined with a `+11dB` makeup gain stage to boost output loudness without digital clipping.
*   **Init Audio Seed Variant Generation**: Pick any generated track variant as the active "Init Audio" seed, configure a noise level (`0.10` to `0.90`), and generate similar variation iterations.
*   **Custom Prompt Generator**: A specialized prompt generator helper that creates structured solo instrument phrases (following the solo style, key, and chord progressions guideline).
*   **Clean and Modern Interface**: Sleek dark-mode aesthetic utilizing glassmorphism, responsive grid layouts, custom-rendered waveforms, and smooth animations.

---

## Repository Structure

```
├── stable-audio-3/          # Stable Audio 3 generator and web app code
│   ├── app_server.py        # Flask backend server & generation API
│   ├── static/              # Web application assets
│   │   ├── index.html       # Dashboard layout
│   │   ├── app.js           # Audio graph, metering, and state synchronization
│   │   └── app.css          # Premium theme styling and CSS layouts
│   ├── pyproject.toml       # Backend dependencies
│   └── stable_audio_3/      # Core Stable Audio 3 model package
├── audio-file-mcp-app/      # MCP server for audio file actions
├── audio-grid-mcp-app/      # MCP server for grid layout management
├── run_server.bat           # Launcher script for Windows
├── .gitignore               # Strict gitignore keeping AI assets/models off git
└── wiki/                    # Project wiki documentation
    └── Home.md              # Detailed architecture and DSP pipeline info
```

---

## Getting Started

### 1. Requirements
*   **OS**: Windows 10/11 (with CUDA-capable GPU recommended for fast generation)
*   **Python**: Python `3.10` or `3.11`
*   **Node.js**: Recommended (for running MCP helper tools)

### 2. Setup
Create a virtual environment named `.venv` under the `stable-audio-3` subdirectory, install dependencies, and download the Stable Audio 3 model weights (`small-music` checkpoint).

### 3. Launching
To launch LoopMasterSA, simply run the batch script at the root directory:
```bash
.\run_server.bat
```
This runs the Flask server on port `7861`. Open your browser and navigate to:
```
http://localhost:7861
```

---

## Git Distribution Rules

To keep the repository lightweight and clean for distribution:
1.  **AI Weights Excluded**: Model checkpoints (`.safetensors`, `.ckpt`, `.pt`, `.onnx`) are automatically ignored.
2.  **Generated Assets Excluded**: Generated loops (`*.wav`, `*.mp3`) and intermediate directories (`outputs/`, `optimized/`) are kept off Git.
3.  **Local Environments Excluded**: Virtual environments (`.venv/`) and package manager lockfiles/node modules are excluded.
4.  **No Hardcoded Paths**: All script execution and asset paths are fully relative.
