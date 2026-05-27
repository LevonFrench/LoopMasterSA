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

## Completed Work: Comprehensive User Guide & Technical Documentation Integration
We authored and integrated a comprehensive user guide and technical documentation to cover the entire feature set and architecture of LoopMaster SA3:
1. **User Guide creation**: Wrote [User-Guide.md](file:///j:/projects/sa3/wiki/User-Guide.md) covering local setup and startup, model parameters, user interface dynamics, the master limiter dynamic configuration, dual-zone variant cards, 5-button preset prompt generators, creative DSP FX blocks (Filtr, Scream, Luftikus EQ, Valentine Saturator, Ælapse wow delay/convolver), offline rendering logic, client-side ZIP exporting, and undo system.
2. **Technical wiki routing**: Updated [Home.md](file:///j:/projects/sa3/wiki/Home.md) to add a TIP block linking directly to the new User Guide.
3. **Repository Landing integration**: Updated [README.md](file:///j:/projects/sa3/README.md) to link to both the User Guide and Technical Wiki Home Page to maximize discoverability.

## Completed Tweak: Local Model & Autoencoder Loading Support
We added support to resolve Stable Audio 3 models and SAME Autoencoders from a local directory before contacting Hugging Face Hub:
- **Local Resolution**: Modified `ModelConfig.resolve()` and `AutoencoderModelConfig.resolve()` in [model_configs.py](file:///j:/projects/sa3/stable-audio-3/stable_audio_3/model_configs.py) to check for matching folders under the project's local directory (`stable-audio-3/models/`).
- **Offline / Tokenless Mode**: By placing manually downloaded model weights (e.g., `model.safetensors` and `model_config.json` inside `stable-audio-3/models/stable-audio-3-small-music/`), the application runs entirely locally and offline, bypassing Hugging Face API checks, download attempts, and authentication tokens.

## Completed Integration: Inpainting and Continuation Remix Modes
We successfully added native inpainting and continuation capabilities directly in the LoopMaster SA3 multi-track generator:
- **Backend Setup**: Updated the POST `/api/generate` route in `app_server.py` to extract `remix_mode`, `inpaint_start`, `inpaint_end`, and `continue_start`. In `_run_generation()`, if a seed path is provided, we load the WAV into a tensor. If `remix_mode` is `"inpaint"`, we pass it as `inpaint_audio` along with `inpaint_mask_start_seconds` and `inpaint_mask_end_seconds` to the generator. If `remix_mode` is `"continuation"`, we pass it as `inpaint_audio` and mask everything after the user-specified split point to extend the sequence.
- **Frontend Controls**: Tied state in `app.js` and wired click events on the mode tabs to display the appropriate parameters subpanels. Programmed `updateRemixSlidersRange(duration)` to dynamically bound range sliders based on the selected variant buffer duration, and clamped the sliders so start never exceeds end.
- **Documentation**: Updated `User-Guide.md` with guidelines on how Variation, Inpaint, and Continuation remixing operates.

## Completed Work: Workspace Reorganization and Unused Repo Cleanup
To establish a clear structural boundary, separate the custom LoopMaster system from the core `stable-audio-3` framework, and keep the repository clean and minimalist:
- **Directory Reorganization & Deletion**: Created a dedicated `loopmaster/` directory in the workspace root and moved the custom frontend/backend application code (`loopmaster-app/`) and system wiki documentation (`wiki/`) into it. Completely deleted the C++ visualizer engine (`pulse-visualizer/`) and both MCP helper apps (`audio-file-mcp-app/`, `audio-grid-mcp-app/`) from the workspace and git tracking.
- **Robust Path Finding**: Updated `app_server.py` and `generate_variants.py` to search upward from their execute paths for the `stable-audio-3` parent folder, rendering scripts immune to relocation changes.
- **Launcher Synchronization**: Re-targeted the Windows launcher script (`run_server.bat`) in the workspace root to boot the server script from `loopmaster/loopmaster-app/app_server.py`.
- **Reference updates**: Updated repository structure diagrams and markdown paths inside `README.md`, `AGENTS.md`, and `Home.md` to target the newly relocated folders and documented reference and scaffolding credits for the deleted tools.
- **Cleanup**: Deleted the empty root `outputs/` folder.
- **Compilation Check**: Verified the dynamic module imports compile correctly, and checked server instantiation via background task tracking.

## Completed Work: Model Localization & Launcher Enhancements
To allow tokenless offline model executions and offer user choice on startup:
- **Model Checkpoint Localization**: Created `localize_models.py` inside `stable-audio-3/scripts/` to download and copy model configs and safe-tensor weights from the Hugging Face Hub (or local cache) directly to `stable-audio-3/models/stable-audio-3-medium/` and `stable-audio-3/models/stable-audio-3-small-music/`. Running this successfully localized both checkpoints for offline bypass.
- **Interactive Batch Menu**: Re-wrote `run_server.bat` in the workspace root to display a CLI menu prompt. The launcher defaults to the high-fidelity `medium` model (Option 1) on Enter, but allows launching `small-music` (Option 2) or `small-sfx` (Option 3) seamlessly.

## Completed Work: Visual Design - Loop Icon Upgrade
To align the visual branding with the LoopMaster identity:
- **Branding Icon Upgrade**: Replaced the static single-music-note SVG graphics inside the main header logo (`.app-logo`) and the initial layout empty-state placeholder screen (`.grid-empty-state`) with a vector double-arrow circular loop design.## Completed Work: Remix Options: Row Ordering, Call & Response, and Invert Timing
To support call-and-response structures, time/progression inversions, and visual grouping of remixed loops:
- **Direct Remix Row Placement**: Updated `addTrackRow` in `app.js` to track `parentTrackId`. Remixed track rows are spliced logically into the `tracks` array and inserted directly below their parent track row in the DOM container (`tracksContainer`) using `insertBefore`.
- **Call & Response ("Response") Mode**: Wired the UI selector for "Response" mode. This mode maps to Stable Audio 3 inpainting with a mask start time of `duration / 2.0` and a mask end time of `duration` in `app_server.py`. This retains the first half (call) of the parent track while regenerating the second half (response).
- **Invert Timing / Progression**: Added an "Invert Timing" checkbox. When active, it passes `invert_timing: true` to the `/api/generate` endpoint, causing the backend to reverse the seed audio waveform along the time dimension via `torch.flip(init_waveform, dims=[-1])` before generation.

## Completed Work: Interface Split Layout
To avoid full-page scrolling and keep transport controls and generation inputs continuously accessible:
- **Viewport Layout**: Locked the main viewport scrollbar by styling the `body` with `overflow: hidden` and `height: 100dvh`.
- **Dynamic Flex Layout**: Formatted `.app-container` to take up exactly `100dvh` with `box-sizing: border-box` and `overflow: hidden`.
- **Scrollable Track Rows**: Set `.tracks-container` to take up the rest of the available height via `flex: 1` and enabled vertical overflow scrolling with custom Webkit scrollbars that blend cleanly with the dark theme.

## Completed Work: FX Tray Layout Fixes
To resolve clipping, squishing, and overlapping inside the expandable FX drawer:
- **Luftikus EQ Visibility**: Added `min-height: 185px` on the `.fx-drawer` to ensure the taller 6-band analog EQ sliders are fully visible without clipping at the bottom.
- **Title and Toggle Alignments**: Changed `.fx-section-title` to a flex layout with `justify-content: space-between` and `align-items: center`. Removed absolute positioning on `.fx-toggle-btn` to flow On/Bypass buttons in-line with the section headers, resolving text truncation.
- **Macro Knobs Spacing**: Set `min-width: 420px` on `.fx-section.macros-section` and disabled wrapping (`flex-wrap: nowrap`) on `.fx-macro-knobs-row` to keep the 8 macro dials spaced evenly on a single line.

## Completed Work: Track Height & Tensor Size Mismatch Fixes
To prevent rows from being squished and correct PyTorch shape mismatch during batch remix generation:
- **Track Layout Stability**: Configured `.track-wrapper` with `flex-shrink: 0` in `app.css`. This stops the scrollable container layout from collapsing the rows, preventing the channel strip knobs from being clipped.
- **Inpaint Mask Tensor Batching**: Fixed `generate` in `stable_audio_3/model.py` to check the batch shape of the inpaint mask. If `batch_size > 1`, the code now repeats/expands the mask tensor (shape `[1, 1, samples]`) along the batch dimension to match the generated audio tensors, resolving PyTorch stacking shape conflicts.
## Completed Work: Prompt Modification Buttons (Chord, Style, and Instrument)
- **Buttons in index.html**: Added "Chord", "Style", and "Inst" buttons inline next to the "In Key" button in [index.html](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/index.html).
- **Prompt Buttons Relocation**: Relocated all prompt variation button pills (Random, In Key, Chord, Style, Inst, Drums, Bass, Lead) from inside the text input box to the prompt label header row next to the "Prompt" text label in [index.html](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/index.html) using a flex row container (`.prompt-header-row`). This aligns buttons neatly next to the label and eliminates vertical dead space in the controls panel. Removed absolute positioning and input box padding constraints in [app.css](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.css).
- **Instrument Randomizer**: Implemented `changeInstrumentOnly()` in [app.js](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.js) to replace the current prompt's instrument with a random alternative from the static instruments list. The function sorts instruments by descending length to correctly match multi-word instruments (e.g. "funky bass guitar" instead of "bass") and contains a fallback generation mechanism. Added the common misspelling `glockenspeil` (alongside `glockenspiel`) to the static instruments list to ensure it matches, and added an exclusion filter so that the randomized replacement is guaranteed to change to a different instrument on every click.
- **SVG Button Icons**: Replaced emojis and text-only labels inside all 8 prompt buttons (Random, In Key, Chord, Style, Inst, Drums, Bass, Lead) in [index.html](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/index.html) and [app.js](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.js) with clean vector inline SVGs, ensuring strict compliance with anti-emoji visual design constraints.
- **Macro Knobs 2x4 Grid**: Updated `.fx-macro-knobs-row` in [app.css](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.css) to use CSS Grid (`grid-template-columns: repeat(4, 1fr)`) instead of Flexbox, collapsing the 8 macro knobs into 2 neat rows of 4 knobs and reducing the macro section `.min-width` to a compact `220px`.
- **Event listener bindings**: Connected the button click handler to `changeInstrumentOnly()` in [app.js](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.js).




