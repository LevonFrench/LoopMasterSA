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

### 25. Verification of FX Bypass, Send Routing, and Track Lock
We implemented and verified the FX bypass buttons, send effect routing for delay/reverb, track locking, and credited external packages:
1.  **FX Bypass Toggles**: Added On/Bypass buttons inside the EQ, Valentine, and Ælapse titles in the FX drawer. Toggling to Bypass dims the control sliders (`opacity: 0.4` and `pointer-events: none`) and routes the audio click-free by fading parallel wet/dry gain nodes to dry `1.0` and wet `0.0`.
2.  **Send Effect Routing**: Treat delay and reverb as parallel Aux Send effects, where the main dry signal path gain is fixed at `1.0` and send return levels are summed in parallel without attenuating the dry signal.
3.  **Compressor at End of FX Chain**: Placed the Valentine dynamics compressor at the very end of the channel strip FX chain, compressing the combined dry + saturated + delay + reverb return sum.
4.  **Track Lock Toggle**: Added a Lock button next to the Delete button. When active, it disables volume and pan sliders, disables all FX sliders, disables bypass toggles, prevents variant card selection, and blocks track deletion. The locked track row is visually dimmed and styled with an amber border.
5.  **Offline Render Sync**: Updated the `OfflineAudioContext` WAV mixdown bounce to match this compressor-last send routing, bypass state mapping, and default looping behaviors.
6.  **Package Credits**: Added clear attribution for Stability AI's Stable Audio 3, lkjbdsp's Luftikus EQ, tote-bag-labs' Valentine saturator, smiarx's Ælapse delay/reverb, and custom MCP applications in the README and project wiki.

### 26. Verification of Comprehensive User Guide & Technical Documentation
We created and linked the comprehensive user guide:
1.  **User Guide Creation**: Created `wiki/User-Guide.md` containing exhaustive instructions on setup/launch, AI prompt enhancement, draggable inputs, transport, mixing, DSP effects, macro controls, offline rendering, and file exporting.
2.  **Documentation Linking**: Added tip banners at the top of the technical wiki (`wiki/Home.md`) and the repository entry point (`README.md`) linking directly to the new user guide with clickable markdown links.
3.  **Link Integrity Check**: Checked that all references and paths are valid and clickable.

### 27. Verification of MCP App Metadata Debugging
We corrected copy-pasted configuration files under `audio-grid-mcp-app`:
1.  **Manifest verification**: Updated `audio-grid-mcp-app/mcpb/manifest.json` to declare the correct app name `audio-grid-mcp-app`, the correct display name `Audio Grid MCP App`, and corrected the tools section to publish the actual tool `display_audio_grid` with its proper description.
2.  **Build script correction**: Modified `audio-grid-mcp-app/scripts/build-mcpb.mjs` to target `audio-grid-mcp-app-${version}.mcpb` as output bundle file.
3.  **Package structure and entrypoint**: Corrected `package.json` to assign the binary command to `"audio-grid-mcp-app"`.
4.  **Documentation correction**: Rewrote `audio-grid-mcp-app/README.md` to accurately document the grid comparison app instead of the single audio file app.
5.  **Verification**: Executed `npm test` inside `audio-grid-mcp-app` to verify all 454 unit tests compile and pass.

### 28. Reorganize Workspace and Cleanup Unused Repositories
We consolidated the workspace and removed all unused helper repositories to keep the project clean and minimalist:
1.  **Directory Reorganization**: Moved `loopmaster-app/` and the system documentation `wiki/` into a new `loopmaster/` subfolder.
2.  **Unused Repo Deletion**: Completely deleted the C++ visualizer code (`pulse-visualizer/`) and the two MCP helper applications (`audio-file-mcp-app/` and `audio-grid-mcp-app/`) from disk and git tracking, as they are not needed to run or maintain the LoopMaster application.
3.  **Import Path Resolution**: Configured `loopmaster/loopmaster-app/app_server.py` and `loopmaster/loopmaster-app/generate_variants.py` to recursively locate the peer `stable-audio-3` folder upwards from their directory.
4.  **Launcher Sync**: Updated the Windows batch script `run_server.bat` at the workspace root to target `loopmaster/loopmaster-app/app_server.py`.
5.  **Reference and Doc Updates**: Updated all path mappings in `README.md`, `AGENTS.md`, and `Home.md`, and added explicit credits documenting the role of `pulse-visualizer` (as UI visual reference) and `audio-file-mcp-app`/`audio-grid-mcp-app` (as scaffolding tools).
6.  **Verification**: Verified that both python scripts compiled cleanly, and launched the Flask backend server locally to confirm it successfully initializes and listens on port 7861.

### 29. Model Localization & Launcher Enhancements
We added support to run either the high-fidelity `medium` model or standard `small-music` model offline:
1.  **Checking and Localizing Weights**: Created `stable-audio-3/scripts/localize_models.py` which resolved both `stabilityai/stable-audio-3-medium` and `stabilityai/stable-audio-3-small-music` checkpoints and stored them inside `stable-audio-3/models/` for tokenless offline execution.
2.  **Batch Launcher Menu**: Re-wrote `run_server.bat` to present a menu selector prompt on startup, allowing the user to select `medium` (default, choice 1), `small-music` (choice 2), or `small-sfx` (choice 3).
3.  **Verification**: Checked script execution, verified that local checkpoint copies completed successfully on disk, and confirmed that launching with `medium` loads the local model files correctly.

### 30. Visual Design - Loop Icon Upgrade
We updated the dashboard branding and placeholder icons to fit the "LoopMaster" identity:
1.  **Icon Upgrades**: Replaced the standard single-music-note SVG icon inside both the header logo (`.app-logo`) and the initial layout empty-state screen (`.grid-empty-state`) with a vector double-arrow circular loop icon.
2.  **Verification**: Confirmed the new icons load and render correctly under standard fills.

### 31. Verification of Remix Options: Row Ordering, Call & Response, and Invert Timing
We implemented and verified the new remix options:
1.  **Row Ordering**: Updated `addTrackRow()` in `app.js` to accept a `parentTrackId` parameter. If a track is a remix (i.e., generated from an initial audio seed), the script locates the parent track within the `tracks` array and inserts the new track row immediately below the parent track row in both the logical `tracks` array and visually in the DOM container (`tracksContainer`) using `insertBefore`.
2.  **Call & Response Mode**: Configured the frontend to support the `"response"` remix mode. The backend maps `remix_mode == "response"` to stable audio inpainting, specifying a mask starting at `duration / 2.0` and ending at `duration`. This preserves the first half of the loop (the call) and regenerates the second half (the response).
3.  **Invert Timing**: Added the "Invert Timing" checkbox next to the remix modes. If checked, the client passes `invert_timing: true` to the `/api/generate` endpoint, which reverses the seed audio tensor along the time dimension (`torch.flip(init_waveform, dims=[-1])`) before performing the generation.

### 32. Verification of Interface Split Layout
We split the interface layout so that the header, control panel, and transport/visualizer panel remain fixed in viewport space, while the track rows scroll independently:
1.  **Body and Layout Constraints**: Disabled page-level vertical scrollbar by setting `overflow: hidden` and `height: 100dvh` on `body`.
2.  **App Container Height**: Constrained `.app-container` to `height: 100dvh` with `box-sizing: border-box` and `overflow: hidden`, establishing a rigid outer grid.
3.  **Scrollable Track Container**: Configured `.tracks-container` to absorb the remaining vertical space using `flex: 1`, enabled vertical scrolling via `overflow-y: auto`, and styled custom subtle scrollbars using webkit pseudo-elements to maintain the sleek, dark Geist aesthetic.

### 33. Verification of FX Tray Layout Fixes
We resolved the styling issues that mangled the FX drawer sections:
1.  **Vertical Height Expansion**: Set `min-height: 185px` on `.fx-drawer` to ensure the 6-band Luftikus Analog EQ sliders are completely visible without vertical scrolling or bottom-edge clipping.
2.  **Overlapping Title Resolution**: Re-styled `.fx-section-title` into a flex row (`display: flex; justify-content: space-between; align-items: center`) and removed absolute positioning of `.fx-toggle-btn`. This positions the On/Bypass buttons naturally next to the titles on the same baseline, resolving overlapping and text truncation.
3.  **Macro Knob Spacing**: Expanded the macro controls section width to `min-width: 420px`, removed flex-wrap, and spaced the 8 macro knobs evenly to prevent them from squishing, wrapping, or overlapping.

### 34. Verification of Track Height Squishing & Tensor Size Mismatch Fixes
We resolved two critical bugs introduced during the split layout integration:
1.  **Track Height Squishing**: Added `flex-shrink: 0` to `.track-wrapper` in [app.css](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.css). This prevents the flex container from compressing the track rows vertically, resolving the clipping of the channel strip knobs (FLT, RCS, DFB, DMX, etc.) and keeping all UI rows at their full natural height.
2.  **PyTorch Size Mismatch on Remixing**: Fixed the batch shape error in `generate` inside [model.py](file:///j:/projects/sa3/stable-audio-3/stable_audio_3/model.py). When an initial seed audio is provided with a batch size greater than 1, we explicitly expand/repeat the `inpaint_mask` tensor (shape `[1, 1, samples]`) along the batch dimension to match the batch size (e.g. `[4, 1, samples]`). This resolves `Error: Sizes of tensors must match except in dimension 1`.
3.  **Scrollbar Flexbox Constraint**: Set `min-height: 0` on `.tracks-container` in `app.css`. Without this, flexbox defaults to `min-height: auto` which prevents the container from shrinking below its content height, resulting in rows overflowing off-screen without triggering the scrollbar.

### 35. Verification of Prompt Modification Buttons (Chord, Style, and Instrument)
1. **Buttons Relocation**: Verified that all prompt pill buttons (Random, In Key, Chord, Style, Inst, Drums, Bass, Lead) have been relocated out of the text entry input box and placed inside the label header row container next to the "Prompt" text label in [index.html](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/index.html).
2. **Layout Sizing Stability**: Verified that removing absolute positioning from `.prompt-inline-btns` and deleting the input box padding-right in [app.css](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.css) allows the text input to stretch dynamically across the dashboard panel without overlapping button text or leaving vertical dead space below the input field.
3. **Change Instrument Action**: Tested clicking the "Inst" button and verified that it successfully identifies the current instrument in the text box (matching multi-word names first) and replaces it with a randomly selected new instrument while retaining the mood, style, key/chord, and formatting of the rest of the prompt.
4. **Fallback Handling**: Verified that if the prompt has no recognizable instrument pattern, clicking "Inst" generates a structured, styled prompt using the new instrument, a random mood, and style, keeping the current key signature.
5. **Spellings & Selection Exclusions**: Confirmed that `glockenspeil` (as a common misspelling) is matched correctly in prompts. Confirmed that the randomized replacement filters out the active instrument, guaranteeing that the instrument changes to a different option on every click.
6. **Vector Icons Integration**: Verified that all 8 prompt buttons (Random, In Key, Chord, Style, Inst, Drums, Bass, Lead) render with modern inline SVG icons and no text emojis, conforming to anti-emoji requirements.
7. **Macro FX Knobs 2x4 Layout**: Confirmed that the 8 macro dials in the FX drawer collapse into 2 rows of 4 knobs. Tested changing panel widths and verified the CSS Grid maintains alignment cleanly.### 36. Verification of Individual Variant Locking & Regeneration
We implemented and verified individual variant locking and regeneration:
1.  **Variant Lock Control**: Added a lock button with a padlock/unlock SVG to each variant card. Clicking it toggles `variant.locked`, toggles the `.card-is-locked` CSS class on the card, and updates the icon state.
2.  **Visual Styling**: Added HSL-tailored amber borders and subtle glow styling for locked cards in `app.css` (`.card-is-locked`), visually separating locked configurations from editable variants.
3.  **Circular Regeneration Action**: Placed a circular refresh button (`.regen-btn`) in the mixer strip. Clicking it checks the count of unlocked variants $N$, packages the original prompt and generation parameters (BPM, seed, CFG scale, steps) stored in `originalParams` during creation, and sends a POST request to `/api/regenerate`.
4.  **Backend Target Processing**: The backend (`_run_regeneration` inside `app_server.py`) generates $N$ new variants, matches them to the unlocked target indices, replaces only the target WAV files on disk with new timestamped names (preventing browser cache hits), and returns the updated 4-file array.
5.  **Dynamic Update & Playback Swap**: The frontend downloads and decodes the new WAVs, replaces only the waveforms and buffers of the unlocked card slots, and restarts playback on active variant updates.
6.  **Verification**: Verified that locking cards #1 and #3 and clicking the refresh button updates only cards #2 and #4 while leaving #1 and #3 unchanged. Tested playback transitions and verified all systems perform seamlessly.

### 37. Verification of Master Volume Controls
1.  **Layout**: Verified the presence of the master volume slider and text readout inside the master level section of [index.html](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/index.html), positioned inline next to the master VU meter.
2.  **Web Audio Gain Control**: Verified that dragging the master volume slider adjusts the master `GainNode` value in real-time, scaling overall playback volume.
3.  **Offline Render Integration**: Verified that the offline rendering engine (`OfflineAudioContext`) in `app.js` reads the master volume slider value and applies it during the mixdown bounce, ensuring the exported WAV matches the output mix levels.
