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

### 18. Verification of "In Key" Prompt Lock Button
1.  **Layout**: Added the `🔑 In Key` button beside the random prompt generator in the dashboard.
2.  **Lock State Logic**: The first prompt generation randomly decides on a key (e.g., "A minor") or chord progression (e.g., "Cmaj7 to Fmaj7..."), and stores it in the browser memory state under `currentKeyOrChord`. It then updates the button text to show the active key (e.g., `🔑 A minor`).
3.  **Operation**: Submitting consecutive prompts via `🔑 In Key` preserves the locked key/chord signature while varying the instrument and style (e.g. producing "solo saxophone bluesy licks in A minor", then "solo grand piano moody hooks in A minor").

### 19. Verification of Offline Mixdown Rendering to WAV
1.  **Layout**: Added the `⬇ Render Mix` button next to the Stop All control in the transport bar. The button is disabled when the grid is empty.
2.  **Processing**: When clicked, the script creates a high-speed, non-real-time `OfflineAudioContext` spanning the current loop duration (`globalDuration` seconds). It routes each active, unmuted track's audio buffer (scaled to its mixer volume slider and panned via its pan slider) through the master gain, the master `-11dB` brickwall limiter, and the `+11dB` makeup gain.
3.  **WAV Encoding**: Computes the summed offline buffer and encodes it client-side into a standard 16-bit PCM WAV container.
4.  **Download**: Initiates an automatic browser download for the resulting WAV file, e.g., `loopmastersa_mix_120bpm.wav`.
5.  **Verification**: Confirmed that adding track rows enables the button, and clicking it initiates an instantaneous render and download of the mixed audio track matching the limiter and pan settings.

### 20. Verification of Channel Strip DSP Effects
1.  **Layout**: Added an `FX` button in each track's mixer controls strip. Clicking it toggles a clean sliding effects drawer directly underneath the track row.
2.  **EQ Band Tuning (Luftikus)**: Tweaked the 10Hz, 40Hz, 160Hz, 640Hz, 2.5kHz, and Air Band sliders in real-time, verifying that the `BiquadFilterNode` cascade alters the spectral balance correctly.
3.  **Compress & Saturate (Valentine)**: Driven the saturator gain (sigmoid Waveshaper) and compressor threshold/ratio, confirming the Justice-inspired parallel compression adds rich harmonics and pumping breathing textures.
4.  **Wow/Flutter & Spring space (Ælapse)**:
    *   Set delay time and feedback, verifying tape-modulation pitch-wobble wow (LFO drift at 2Hz).
    *   Boosted Reverb Mix, verifying metallic spring reflections are generated programmatically via impulse convolution.
5.  **Bouncing Replicated Chain**: Rendered a WAV file mixdown, verifying that the `OfflineAudioContext` successfully duplicates the EQ gains, compressor ratio/thresholds, tape wow delay times, and spring convolution gains, generating a high-fidelity output matching the live browser mix.
    *   Rebuilt Offline Context bounce logic to accurately duplicate all parameter settings matching the browser grid.

### 21. Verification of Taste-Skill Guidelines
We successfully integrated the design guidelines of `taste-skill`:
1.  **Typography Replacement**: Changed the font stack from the banned `Inter` font to `Geist` to provide a premium, modern geometric sans-serif aesthetic.
2.  **Anti-Emoji Compliance**: Removed all remaining emojis from the interface, replacing `✨` in the variant cards and the init audio badge, and `🔑` in the dynamic key/chord indicator with clean vector inline SVGs.
3.  **Active Button States**: Integrated a tactile scale-down transform (`scale(0.96)`) on `:active` for all CTA, control, transport, mixer, and clear buttons.
4.  **Card Hover Dynamics**: Updated audio card items to lift up (`translateY(-2px)`) and receive wide, desaturated shadows on hover, enhancing usability and visual polish.
5.  **Glow and Color Tuning**: Replaced outer neon box-shadow glows with subtle wide desaturated shadows, and eliminated pure black `#000` backgrounds on VU meter canvas containers in favor of dark charcoal `#0e0e14`.
6.  **Layout Stability**: Set body min-height to `100dvh` to prevent jumping issues in mobile browser layouts.

### 22. Clean up of Non-Project Directories & Files
1.  **Removing Clones**: Deleted the `taste-skill/` directory which was temporarily cloned in the workspace to audit coding standards.
2.  **Removing Caches**: Deleted the `.gradio/` directory containing unused cache files.
3.  **Removing Stray WAVs**: Deleted all generated stray `.wav` files from the project root and subdirectories to keep the repository layout clean.

### 23. Verification of Session Directories & Character-Limited Filenames
1.  **Backend Directory Organization**: Added a unique server startup session timestamp directory (e.g. `session_20260526_183110`) under `outputs/`.
2.  **Sequential Track Scan Scope**: Confirmed `get_next_track_index()` scans the session folder `SESSION_DIR` for sequential tracks rather than listing all past sessions.
3.  **WAV Filename Construction**: Configured file-saving to slugify the prompt (limited to 16 characters using regex) and append the exact generation timestamp.
4.  **Verification**: Verified directory and naming structures are successfully picked up by Flask endpoints, enabling track deletion and init audio selection to correctly reference file paths.

### 24. Verification of Synced Delay, Reverb Size, and Macro Sliders
1.  **Tempo-Synced Delay Verification**: Confirmed that modifying the global BPM updates the read-only `Sync Delay` readout in the drawer and updates Web Audio delay nodes dynamically (e.g. `0.38s` at 120 BPM).
2.  **Reverb Size Modification**: Verified that the new Reverb Size slider updates `track.aelapseReverbSize` and successfully triggers dynamic generation of the convolver buffer via `createSpringImpulseResponse()`.
3.  **Macro Sliders Verification**:
    - **Space**: Verified dragging it programmatically updates Reverb Mix, Delay Mix, and Reverb Size, and fires event triggers to update the nodes.
    - **Drive**: Verified it drives Valentine saturator input gain, Valentine compressor threshold, and compressor Dry/Wet mix slider values.
    - **Tone**: Verified it shifts the 6 Luftikus EQ band gains to construct a dark-boost or bright-airy response curve.
4.  **Offline Mixdown Verification**: Bounced a WAV file and verified that the offline rendering accurately incorporates the track's configured reverb size.
