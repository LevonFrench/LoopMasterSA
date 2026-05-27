# Session Handoff — LoopMasterSA Finalized Project

## Current Status
We have finalized the repository packaging, consolidated the git structure, fixed a critical high-DPI canvas layout bug, and prepared the project for version control distribution.

1.  **High-DPI Canvas Layout Fix**:
    - **Problem**: Users on high-DPI/Retina screens or specific browser zoom levels observed track rows failing to render and being replaced by a giant white blank square. This was caused by an infinite layout resizing loop: `drawMeter()` computed `rect.height * dpr` and set it to the `canvas.height` attribute. Lacking a CSS constraint, the DOM height expanded, which was then measured as larger in the next frame, causing exponential canvas growth until browser/GPU limits were exceeded.
    - **Fix**: Added explicit CSS dimensions (`width: 140px; height: 8px;` for `#master-meter-canvas` and `height: 6px;` for `.meter-canvas`) in `app.css`. This anchors the layout dimensions while permitting the drawing buffer to scale for high-DPI displays.
2.  **LoopmasterSA Renaming**:
    - Updated index page title, logo headers, and layout branding to **LoopmasterSA**.
3.  **Init Audio Seed Variations**:
    - Added `✨ Init` buttons to cards and a top controls panel badge with a noise slider (0.10 to 0.90, default 0.60) to generate variations.
    - Python backend (`app_server.py`) parses `init_audio_path` and `init_noise_level`, loading the file into PyTorch via `torchaudio.load()` and feeding it to `model.generate()`.
4.  **Git Consolidation & Packaging**:
    - Removed nested `.git` folders in `stable-audio-3/` and `audio-file-mcp-app/` so they are tracked as standard subdirectories in the parent `LevonFrench/LoopMasterSA.git` repository.
    - Created a comprehensive root-level `.gitignore` that ignores all model weights (`*.ckpt`, `*.safetensors`, `*.bin`, `*.pt`, `*.pth`), temporary directory caches (`.gradio/`), Python virtual environments (`.venv/`), node modules (`node_modules/`), local log files, and generated WAV assets.
5.  **Documentation & Wiki**:
    - Created `wiki/Home.md` detailing the signal processing chain, the master limiter parameters, real-time peak/RMS equations, and init audio flows.
    - Updated root `README.md` to outline features, directory structure, launch instructions, and git guidelines.
6.  **Offline WAV Mixdown Rendering**:
    - Added a `⬇ Render Mix` button that bounces down the current grid arrangement to a 16-bit PCM stereo WAV. It accurately reflects individual track gains, pan values, mute/solo flags, and the brickwall master limiter with makeup gain, rendering instantly via `OfflineAudioContext`.
7.  **Track-Level Effects Drawer**:
    - Integrated an expandable effects drawer on each track containing custom DSP implementations of:
      *   **Luftikus Analog EQ**: A 6-band peaking/high-shelf EQ cascade (10Hz to 12kHz shelf).
      *   **Valentine Compressor/Saturator**: Soft-clipping WaveShaper distortion with input gain and DynamicsCompressorNode mix for heavy dynamic pumping.
      *   **Ælapse Tape Delay & Spring Reverb**: A tape wow/flutter delay modulated by a 2Hz LFO, alongside metallic programmatically convolved spring reverb.
      *   All effects are fully supported during offline mixdown rendering.
8.  **Taste-Skill Visual Refinement**:
    - **Typography**: Swapped standard `Inter` font for the premium geometric `Geist` font family.
    - **Anti-Emoji**: Replaced all emojis (`✨` and `🔑`) with clean inline SVGs.
    - **Tactile Transitions**: Added scale transitions (`scale(0.96)`) on `:active` for all button actions.
    - **Card Elevation**: Configured cards to lift up (`translateY(-2px)`) and cast wider diffused desaturated shadows on hover.
    - **Color & Glows**: Replaced neon outer glows with desaturated shadows, and updated VU meter backgrounds to charcoal `#0e0e14`.
    - **Viewport Stability**: Changed body min-height to `100dvh` to prevent layout jumps on mobile.
9.  **Workspace Housekeeping**:
    - Deleted `taste-skill/` directory (temporary style-guide clone).
    - Deleted `.gradio/` cache directories.
    - Cleaned out all stray generated `.wav` files from the project root and subdirectories to ensure repository hygiene.
10. **Session Directory Routing & Slug Naming**:
    - Generates unique session-based timestamp subfolders under `outputs/`.
    - Sanitizes prompts and restricts prompt slug lengths in filenames to 16 characters.
    - Appends generation timestamps to all output WAV files.
    - Integrates track tracking and clean-up functions inside the active session context.
11. **Tempo-Synced Delays, Reverb Size, and Macro Sliders**:
    - Delay times are locked to global BPM (dotted-eighth sync: `45.0 / bpm` seconds).
    - Repurposed delay time slider into a Reverb Size control that regenerates spring convolver buffers dynamically (`0.5s` to `5.0s`).
    - Added Space, Drive, and Tone macro sliders in the FX drawer, morphing multiple parameters at once in the client and in the offline WAV mixdown.
    - Highlighted the Macro Control panel in the UI with custom CSS.
12. **FX Bypass, Send Routing, and Track Lock**:
    - Added independent "On/Bypass" toggle switches inside EQ, Valentine, and Ælapse titles. Bypass dims controls (opacity 0.4, pointer-events: none) and routes audio click-free via dry/wet gain fades.
    - Re-wired Delay/Reverb as parallel Aux Send effects (dry path gain remains fixed at 1.0).
    - Placed Valentine compressor at the end of the channel DSP chain, compressing the combined dry + saturated + send outputs return sum.
    - Removed redundant Loop (`L`) toggle button. All tracks loop natively by default.
    - Added Lock button next to Delete. Locking disables level/pan sliders, FX drawer sliders, bypass switches, variant selection, and track deletion. Locked tracks are styled with amber borders and a subtle visual fade.
    - Replicated send routing, bypass checks, and default looping in the `OfflineAudioContext` WAV exporter.
    - Credited Stability AI's Stable Audio 3, lkjbdsp's Luftikus EQ, tote-bag-labs' Valentine saturator, smiarx's Ælapse delay/reverb, and custom MCP applications in the README and project wiki.
13. **Critical Bug Fixes (Debug Pass)**:
    - **`bufferToWav` sample skip**: The WAV encoder reused `pos` for both the header byte offset and the PCM sample loop counter. After writing the 44-byte header, `pos` was 44, so the sample loop started at index 44 — skipping the first 44 samples and truncating the last 44. Fixed with a separate `sampleIdx` counter.
    - **Offline Aelapse dry gain mismatch**: Live chain keeps dry gain fixed at `1.0` (send effect architecture), but the offline renderer used `1 - Math.max(delayMix, reverbMix)`, attenuating dry signal. Fixed to `1.0`.
    - **Offline compressor placement**: Live chain routes `EQ → Saturator → Sends → Compressor`. Offline had compressor inside the Valentine stage before sends. Fixed to match live routing order.
14. **Inline Prompt Buttons & Drum Loop Generator**:
    - Moved Random, In Key, and new Drums buttons inside the text input as compact pill buttons with emoji labels (🎲 🔑 🥁).
    - Added genre-aware drum loop random generator (20 genres × 16 descriptors) that auto-fills BPM from the current BPM input.
    - Styled as glassmorphic pills with hover glow and press-scale micro-animations.
15. **Render Loops & Fade-Out Tail**:
    - Added a `Loops` number input in the transport bar next to Render Mix. Offline render creates a buffer of `singleLoopDuration × loopCount` plus a 5-second tail.
    - Sources stop at the content boundary; delay/reverb tails ring out naturally through the FX chain.
    - Master gain fades linearly to 0 over the 5-second tail for smooth endings.
16. **Waveform Card Alignment**:
    - Fixed grid alignment with `align-items: stretch` and fixed header height so waveform seek bars line up across all variant cards.
17. **Scream & Filtr FX Modules**:
    - Added **Filtr Filter** (Cure-Audio/Scream-style pre-EQ filter): LP/BP/HP/Notch with cutoff, resonance, and mix controls. Placed first in the DSP chain.
    - Added **Scream Distortion Filter** (resonant LP + waveshaper): Cutoff, Scream (maps 0-100% to Q 0.707-25 and drive 5-80), and mix controls. Placed after EQ.
    - Both modules have independent On/Off bypass toggles and are fully replicated in the offline WAV renderer.
    - Drive macro auto-enables Scream at 60% of macro value when pushed.
    - Credits added to README for [Cure-Audio/Scream](https://github.com/Cure-Audio/Scream) and [tiagolr/Filtr](https://github.com/tiagolr/filtr).

## Launcher & Server Info
*   **Launcher**: [run_server.bat](file:///j:/projects/sa3/run_server.bat) in the project root folder.
*   **Server Task**: The Flask server is running in the background as task `task-2235` on `http://127.0.0.1:7861` serving the UI.
