---
confidence: high
volatility: cold
---

# Desktop Application

This article details the architecture and optimizations of the `loopmaster-desktop` standalone shell.

## Electron Wrapper

LoopMaster SA3 runs as a standalone desktop application via an Electron wrapper (`loopmaster-desktop`), bypassing the need for users to run batch scripts or manage the Python environment directly.

### Launcher Interface
A native HTML/CSS UI (`launcher.html`) replaces the legacy `run_server.bat` script. It allows users to visually select the PyTorch inference model (Medium, Small Music, Small SFX, BF16) before booting. UI styling is modularized in a `shared.css` stylesheet to reduce duplication across loading screens.

### Process Management & Platform Optimizations
The Electron `main.js` process spawns the Python backend (`app_server.py`) as a child process. 
- **Windows-Optimized Lifecycle**: The desktop app is heavily optimized for Windows environments. Upon closing the application, Electron forcefully terminates the PyTorch subprocess using `taskkill /pid <PID> /f /t`. This ensures that GPU VRAM is instantly freed, preventing zombie Python processes that hold onto GPU memory.
- **Lean Codebase**: macOS (`darwin`) specific lifecycle events and platform checks have been stripped out to keep the codebase minimal and strictly focused on Windows execution.

### Seamless Boot Sequence
1. The user selects a model in the Launcher.
2. The UI transitions to a dedicated loading screen (`loading.html`).
3. Electron begins polling the local Flask backend via HTTP GET requests (`http://127.0.0.1:7861/`), rather than relying on brittle standard-error scraping.
4. While polling occurs, the Python backend loads the VAE and transformer weights into VRAM and runs a dummy warmup generation to compile the DiT graph.
5. Once the Flask server responds with HTTP 200 (passing its health check), Electron silently swaps the view to the main Web Audio UI.

## Related Documents
- `[[concepts/architecture|System Architecture]]` ([System Architecture](architecture.md))
