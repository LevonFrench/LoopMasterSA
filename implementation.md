# Implementation Log - Stable Audio 3 Setup

This document records environment fixes and dependency adjustments made to run Stable Audio 3.

## Environment Fixes

... [previous environment fixes logged] ...

## Completed Fix: Audio Edge Noise Burst Fix

... [previous completed fix details logged] ...

## Completed Tweak: Random Prompt Generator Button

... [previous completed random button details logged] ...

## Completed Tweak: Solo Instrumentation Default

... [previous solo defaulting details logged] ...

## Completed Tweak: Click to Deselect/Disable Track Row
- **static/app.js**: Updated `selectVariant`, `startTrackSource`, `stopTrackSource`, and `updateTrackLoopState` to support a deselected (`-1`) state. If a user clicks on the currently selected variant in a track row, it deselects it, removes the `.is-selected` UI highlighting, stops any playing source from that row, and renders the waveforms at a non-selected opacity. Clicking on any variant again will re-select and re-enable it.

## Remote Access Guidance

... [previous remote access details logged] ...

## Selected Design: Option A Master Limiter & Loudness Metering

We have selected and are implementing **Option A** for the master limiter and loudness metering.

### Architecture Details
1. **Master Limiter**: Native `DynamicsCompressorNode` on the `AudioContext` configured as a brickwall limiter (-11dB threshold, 0 knee, 20 ratio, 3ms attack, 100ms release) followed by a `GainNode` with +11dB makeup gain (`Math.pow(10, 11/20)`) to boost the limited signal to a 0dB ceiling.
2. **Signal Chain**:
   `Track Source -> Track Pan -> Track Volume -> Track Analyser -> Master Gain -> DynamicsCompressorNode (Limiter) -> GainNode (Makeup) -> Master Analyser -> Destination`
3. **Loudness Meters**: Real-time Peak, Peak Hold, and RMS dB levels (-60dB to 0dB scale) drawn on horizontal HTML5 canvases.
   - **RMS**: Leaky integration smoothing ($\alpha = 0.85$).
   - **Peak**: Instant rise, 12 dB/s decay.
   - **Peak Hold**: 1.5s hold time before decaying at 15 dB/s.
   - **Colors**: Green (-60 to -18dB), Yellow (-18 to -6dB), and Red (-6 to 0dB) linear gradient with a Cyan tick for the Peak Hold marker.

## Completed Design: LoopmasterSA & Init Audio Variation Generation
We renamed the application to **LoopmasterSA** and implemented an "Init Audio" variation generator feature:
1. **Renaming**: Updated `index.html` title and headers to say LoopmasterSA.
2. **Init Selection UI**: Added a `✨ Init` button to the header of each variant card. Clicking it selects the variant's WAV path as the active initial audio and populates a top-level controls badge.
3. **Noise Level Control**: Added a noise slider (0.10 to 0.90, default 0.60) in the top badge to configure the model's `init_noise_level` dynamically.
4. **Backend Integration**: In `app_server.py`, if `init_audio_path` is passed, the file is loaded via `torchaudio.load()`, tensors are moved to the model device, and they are passed to `model.generate()` with the specified noise level.

## Completed Fix: High-DPI Canvas Layout Feedback Loop
- **Problem**: On screens with `devicePixelRatio > 1` (or zoomed views), canvas sizes grew exponentially every frame. Because `.meter-canvas` and `#master-meter-canvas` lacked CSS size constraints, setting the `canvas.width` and `canvas.height` attributes expanded their layout size. Measurement via `getBoundingClientRect()` in the next frame returned a larger size, creating an infinite resizing loop that resulted in a giant white square (browser max canvas size overflow).
- **Fix**: Defined explicit dimensions (`width: 140px; height: 8px;` for `#master-meter-canvas` and `height: 6px;` for `.meter-canvas`) in `app.css`. This anchors the layout dimensions while permitting the drawing buffer to scale for high-DPI displays.

## Completed Repository Packaging & Documentation
- **Git Submodule Consolidations**: Removed nested `.git` folders from `stable-audio-3` and `audio-file-mcp-app` to allow tracking all files inside the main `LevonFrench/LoopMasterSA.git` repository.
- **Gitignore Rules**: Created a root-level `.gitignore` that ignores all local virtual environments (`.venv`), temporary caches (`.gradio/`), model checkpoints (`*.safetensors`, `*.ckpt`, `*.pt`, `*.bin`), and generated output directories (`outputs/`, `optimized/`, `*.wav`).
- **Wiki Knowledge Base**: Created `wiki/Home.md` explaining the system architecture, the master compressor/limiter settings, loudness metering math, and initial audio generation flow.
- **Repository README**: Wrote a root `README.md` containing features list, repository structure map, launcher instructions, and git distribution guidelines.

## Completed Tweak: In Key Prompt Locking Button
- **HTML Layout**: Added the `btn-random-in-key` button in [index.html](file:///j:/projects/sa3/stable-audio-3/static/index.html) positioned alongside the existing randomizer button.
- **State Lock**: Introduced a global `currentKeyOrChord` variable in [app.js](file:///j:/projects/sa3/stable-audio-3/static/app.js) to store the active key/chord signature.
- **Button Feedback**: Wired `generateRandomPrompt(keepKey)` to fetch/generate the signature. The button text dynamically changes to display the locked key or chord (e.g. `🔑 A minor` or `🔑 Cmaj7 to Fma...`) to provide clear visual feedback to the user.

## Completed Tweak: Offline WAV Mixdown Rendering
- **WAV Exporter**: Developed a client-side 16-bit PCM WAV exporter function (`bufferToWav`) in [app.js](file:///j:/projects/sa3/stable-audio-3/static/app.js) that formats raw floating-point samples into a valid WAVE/RIFF file blob.
- **Offline Context**: Structured the click event on the `⬇ Render Mix` button to instantiate an `OfflineAudioContext` with the active sample rate and duration.
- **DSP Graph Replication**: Recreated the track volume/pan nodes and the master limiter + makeup gain nodes inside the offline context, connecting and playing only active, unmuted track buffers.
- **Automatic Export**: Fetches the rendered audio buffer, runs WAV compilation, and triggers a browser file download of the high-fidelity mixdown immediately.

## Completed Tweak: Track-Level Effects Drawer (Luftikus, Valentine, Ælapse)
- **UI Container wrapper**: Wrapped each track row and its sliding effects panel inside a `.track-wrapper` element in [app.js](file:///j:/projects/sa3/stable-audio-3/static/app.js) to isolate grids and avoid layout displacement.
- **FX Button Toggle**: Added an `FX` button to the track row mixer strip to toggle drawer visibility (`style.display`).
- **Luftikus EQ (6 bands)**: Constructed a chain of 6 `BiquadFilterNode`s per track (10Hz, 40Hz, 160Hz, 640Hz, 2.5kHz, Air/12kHz shelf) with real-time gain sliders in the drawer.
- **Valentine saturator/compressor**: Implemented input gain routing to a sigmoid `WaveShaperNode` soft-clipper, passing to a `DynamicsCompressorNode` for Justice-inspired dynamic pumping. Managed dry/wet gain nodes for parallel compression mix.
- **Ælapse wow/flutter delay & spring reverb**:
  - Tape wow delay: Combined a `DelayNode` with a `2Hz` low-frequency oscillator (`OscillatorNode` LFO) modulating delay times by `2ms` for analog pitch drift.
  - Spring Reverb: Fed stereo programmatically-generated chirped spring impulse responses to a `ConvolverNode`.
- **Offline Replay**: Programmed the `OfflineAudioContext` mixdown builder to dynamically parse track EQ gains, saturator gain parameters, wow delay times, and spring convolution gains, matching the browser mix exactly.

## Completed Visual Refinement: Taste-Skill Integration
We successfully applied the `taste-skill` rules across the codebase:
- **Typography Modernization**: Replaced font imports and `--font-sans` variables using `Inter` with the premium geometric `Geist` font family.
- **Anti-Emoji Policy**: Removed all visual emojis (`✨` and `🔑`) and implemented clean vector inline SVGs for buttons and badge displays.
- **Tactile Click Feedback**: Standardized a `:active` scale-down transformation (`scale(0.96)`) for all button structures (Generate, Random, In Key, Render Mix, Stop All, Init Audio, Close).
- **Audio Card Elevation**: Configured `.audio-card` items to lift upward (`translateY(-2px)`) and cast wider, diffused desaturated drop shadows on hover/focus states.
- **Ambient Color Styling**: Swapped all meter-strip canvas containers' pure `#000` backgrounds for a dark charcoal `#0e0e14` to soften design contrast and eliminated oversaturated neon flows.
- **Mobile Viewport Stability**: Adjusted the global body height property from `100vh` to `100dvh` to ensure mobile navigation drawers and header blocks remain vertically stable.

## Completed Housekeeping: Clean up of Workspace Folders
To preserve structural hygiene:
- **Nested Repo Removal**: Deleted the `taste-skill/` directory, which was temporarily cloned in the root workspace during audits.
- **Cache Clean-up**: Purged the temporary `.gradio/` cache directories.
- **Stray Media Clearance**: Removed stray generated `.wav` files from the project root and subdirectories to ensure version control index clarity.

## Completed Backend Tweak: Session Directories and Timestamped Prompt-Slugged Filenames
We modified `app_server.py` to organize outputs and format filenames:
- **Session Directories**: Each server start creates a unique `outputs/session_YYYYMMDD_HHMMSS/` directory. All generations and track operations for the active session are housed inside this folder.
- **WAV Filename Formatting**: Filenames are structured as `track_X_<prompt_slug>_var_Y_<timestamp>.wav`.
- **Prompt Slug Limiting**: Prompt slugs are cleaned (keeping only alphanumeric/hyphen characters and spaces, converting spaces to underscores) and truncated to exactly 16 characters max to keep filenames concise.
- **Scoping Operations**: Scoped track sequential numbering and deletion endpoints to operate exclusively inside the active session directory.

## Completed FX Upgrade: Synced Delay, Reverb Size, and Macro Control Knobs
We updated the FX drawer and Web Audio DSP connections:
- **Tempo-Synced Delay**: Linked delay time value directly to the global BPM using a dotted-eighth note equation (`45.0 / bpm`). The manual delay time slider was replaced with a read-only time value display.
- **Reverb Size Control**: Repurposed the delay time slider to control "Reverb Size" (mapping 5 to 50 as `0.5s` to `5.0s`). Dragging it dynamically regenerates the `ConvolverNode` buffer.
- **Macro Control Sliders**: Implemented three macro controls:
  *   **Space**: Coordinates Reverb Mix, Delay Mix, and Reverb Size.
  *   **Drive**: Coordinates Valentine Drive, Valentine Compressor threshold, and Dry/Wet Mix.
  *   **Tone**: Coordinates Luftikus EQ sliders to shape dark-bass or bright-airy response curves.
  *   These controls work by programmatically updating individual parameters and triggering `'input'` events.
- **Macro Highlight Styling**: Styled `.fx-section.macros-section` in `app.css` with a highlighted background and border to draw focus in the UI.
- **Offline Bounce Replication**: Replicated Reverb Size configuration in `OfflineAudioContext` for exact WAV bouncing.

## Completed Tweak: FX Bypass, Send Routing, and Track Lock

We implemented independent bypass, parallel send routing for delay/reverb, track locking, and credited external packages:
- **Bypass Toggles**: Added On/Bypass buttons in the EQ, Valentine, and Ælapse titles. Toggling them dims the controls (opacity 0.4, pointer-events: none) and routes the audio click-free through parallel dry/wet gain nodes.
- **Send Effect Routing**: Treat delay and reverb as Send effects where the main dry signal path gain is fixed at 1.0 (uncut by wet send level changes).
- **Compressor at End of Chain**: Placed the Valentine dynamics compressor at the end of the channel FX chain, compressing the combined dry + distortion + delay + reverb returns.
- **Redundant Loop Toggle Removal**: Removed the Loop button (`L`) from the mixer strip. All tracks loop natively by default.
- **Track Lock Toggle**: Added a Lock button next to the Delete button. Toggling Lock disables volume, panning, all FX sliders, variant selection, and track deletion. Highlighted locked track rows with an amber border and a subtle visual fade.
- **Offline Rendering Sync**: Replicated the new compressor-last send routing, bypass states, and looping defaults in the `OfflineAudioContext` WAV mixdown bounce.
- **Tech Credits**: Credited Stability AI's Stable Audio 3, lkjbdsp's Luftikus EQ, tote-bag-labs' Valentine saturator, smiarx's Ælapse delay/reverb, and custom MCP applications in the README and project wiki.







