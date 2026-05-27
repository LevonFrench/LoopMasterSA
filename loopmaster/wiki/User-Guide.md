# LoopMaster SA3 User Guide & Documentation

Welcome to **LoopMaster SA3**, a professional, real-time synchronized multi-track loop generator and mixing dashboard built on top of the Stable Audio 3 generative music foundation model. LoopMaster SA3 provides a cohesive, browser-based studio environment to generate musical loops from text prompts, arrange them in a synchronized grid, and mix them using professional-grade channel strips, master processor nodes, and advanced visualizers.

---

## Table of Contents
1. [Getting Started & Installation](#1-getting-started--installation)
2. [Core Generation Engine & AI Prompts](#2-core-generation-engine--ai-prompts)
3. [The Mixer Grid & Card Controls](#3-the-mixer-grid--card-controls)
4. [Channel Strip DSP Effects](#4-channel-strip-dsp-effects)
5. [Macro Controls & Automation](#5-macro-controls--automation)
6. [Offline Rendering & Exporting](#6-offline-rendering---exporting)
7. [Keyboard Shortcuts & Advanced Workflows](#7-keyboard-shortcuts--advanced-workflows)

---

## 1. Getting Started & Installation

### Requirements
- **OS**: Windows 10 or 11
- **Hardware**: CUDA-capable NVIDIA GPU (recommended for fast inference)
- **Python**: Version `3.10` or `3.11`
- **Node.js**: Recommended (for optional MCP developer server integrations)

### Installation Steps
1. **Virtual Environment Setup**:
   Create a Python virtual environment inside the `stable-audio-3` subdirectory:
   ```bash
   cd stable-audio-3
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r pyproject.toml  # or install via uv/poetry if locked
   ```
2. **Model Checkpoint**:
   Ensure you have downloaded the Stable Audio 3 model weights (such as the `small-music` or `medium` checkpoint) and placed them in the appropriate directory mapping to your local configuration.
3. **Launching the Studio**:
   From the project root directory, run the Windows batch launcher script:
   ```powershell
   .\run_server.bat
   ```
   This script activates the virtual environment, configures the necessary PyTorch DLL paths, and boots the Flask backend server on port `7861`.
4. **Accessing the UI**:
   Open a web browser and navigate to:
   [http://localhost:7861](http://localhost:7861)

---

## 2. Core Generation Engine & AI Prompts

LoopMaster SA3 leverages Stability AI’s **Stable Audio 3 (SA3)** model to generate 44.1kHz high-fidelity stereo loops. The backend automatically enhances user prompts and formats output files for optimal loop synchronization.

### Prompt Auto-Enhancement Rules
To ensure the AI generates high-quality, easily loopable elements, the backend applies prompt preprocessing:
- **TrackType Classification**: Prepends `TrackType: Instrument` or `TrackType: SFX` depending on keyword matching (e.g., sound effects vs drums/guitar).
- **Solo Defaults**: Prepends `solo` to instrument prompts unless multi-instrument keywords (such as *duo*, *ensemble*, *band*, *orchestra*) are found.
- **Looping Tags**: Appends `seamless loop, looping` tags and the word `loop`.
- **Quality Enhancement**: Adds production descriptors (`analog warmth, high fidelity, 44.1 kHz, stereo, well-mixed`).
- **Timing Constraint**: Explicitly appends `BPM: [value], Length: [seconds]` to guide the model's rhythmic alignment.

### Key Prompt Formats
For manual prompt writing, SA3 responds best to structured inputs:
```
[Mood/Vibe] + [Instrumentation] + [Genre/Style] + [Key/Chord] + [Production Style]
```
*Example:* `dreamy solo grand piano jazz improvisation in C minor, tape saturated`

### Prompt Helpers (Dashboard Icons)
Five preset buttons provide rapid, structured prompt generation:
- **🎲 Random**: Generates a random key-signature solo instrument prompt (53 instruments × 35 styles × 24 moods).
- **🔑 In Key**: Generates a random prompt while **locking the current key or chord progression** to maintain harmonic compatibility with existing tracks.
- **🥁 Drums**: Generates drum loop prompts with descriptors (32 genres × 24 descriptors × 10 drum elements) formatted with the active BPM.
- **🎸 Bass**: Generates basslines locked to the current key or chord progression (48 styles × 28 descriptors).
- **🎹 Lead**: Generates lead synth or instrument melodies locked to the key/chord (48 styles × 32 descriptors).

### Backend Loop Processing
- **Audio Headroom (+2s Generation)**: To prevent audio waveforms from decaying or cutting off in the last 1-2 seconds of a loop, the Flask backend generates `duration + 2.0` seconds of audio. It then trims the audio back to the exact loop boundary (`duration = 960 / BPM` seconds, representing 4 bars) before saving.
- **WAV ACIDization**: Generated WAV files are post-processed on the server to insert **Acidized loop metadata** (`acid` chunk), **cue points** (`cue ` chunk), and **beat labels** (`LIST` chunk) directly into the WAV binary header. This ensures the output files import seamlessly into major Digital Audio Workstations (DAWs) with correct tempo, key, and 16-beat transient grid markers.

---

## 3. The Mixer Grid & Card Controls

The LoopMaster SA3 dashboard displays tracks as rows, each containing a **Mixer Strip** on the left and **four generated variant cards** on the right.

```
+-----------------------------------------------------------------------------------+
| MIXER STRIP           |  [ Variant Card 1 ]  [ Variant Card 2 ]  [ Variant Card 3 ]...|
| Vol/Pan/M/S/Lock/FX  |  Waveform Playhead  |  Waveform Playhead  |  Waveform Playhead|
+-----------------------------------------------------------------------------------+
```

### Draggable Inputs
The BPM, Seed, and Steps controls in the top header utilize a **deadzone drag pattern**:
- **Single Click**: Focuses the input field to let you type values with the keyboard.
- **Mouse Drag (Vertical ↕)**: Click and drag vertically. If the mouse moves more than 3 pixels, the input enters drag-to-adjust mode for quick scanning.

### Transport Controls
- **Play/Pause (Spacebar)**: Starts or pauses playback. All tracks are synchronized to a shared playhead.
- **Seek Toggle**: When Seek is **ON**, clicking anywhere on a variant card's waveform seeks the global playhead to that relative percentage. When **OFF**, clicking only selects the variant.
- **Split Toggle**:
  - **Split OFF**: Clicking a card instantly selects and plays it.
  - **Split ON**: Divides the card horizontally. Clicking the **left half** queues the variant to switch at the next loop boundary (flashing amber border). Clicking the **right half** triggers an instant variant switch.

- **Remix (Init Audio Flow)**: Clicking the `Remix` button on any variant card loads that specific audio file as the initial seed for subsequent generations. This enables three powerful remix modes:
  - **Variation Mode**: The standard style-transfer mode using a noise slider (0.10 to 0.90) to control the deviations from the seed audio. Lower values generate closer variations, while higher values allow the model to drift further.
  - **Inpaint Mode**: Targeted segment regeneration. Set start and end sliders (in seconds) to designate the region to regenerate. The rest of the loop is preserved exactly as in the seed audio.
  - **Continuation Mode**: Extends a track from a split point. Set the "Keep First" slider (in seconds) to lock the beginning of the track, and the engine will generate fresh continuation material for the remainder of the loop.
- **In-place Reversal (⇄)**: Reverses the underlying audio buffer in-place. If the track is currently playing, it restarts just that track's playback source in sync, avoiding clicks.

### Track Mixer Strip
- **S (Solo)**: Mutes all other non-soloed tracks.
- **M (Mute)**: Silences the track.
- **Lock**: Disables all mixers, volume/pan sliders, FX drawer controls, card selections, and deletion for that row. Highlighted with an amber border.
- **FX**: Toggles the visibility of the Track-Level DSP Drawer.
- **Delete (Trash)**: Removes the track row.
- **Volume Slider**: Mapped to a linear gain node (0 to 100%).
- **Pan Knob**: Mapped to a `StereoPannerNode` (-100 Left to +100 Right). Drag vertically to adjust; double-click to center.
- **Meters**: Canvas-based metering showing perceived loudness (RMS, dark alpha block), instantaneous peak (bright bar decaying at 12dB/s), and peak hold (cyan tick held for 1.5s then decaying at 15dB/s).
- **Mixer Macros (Flt, Res, DFb, DMx, RSz, RMx, S/C)**: A row of micro-knobs on the mixer strip mapping directly to the most critical DSP effects parameters. Drag vertically to adjust, double-click to reset.

---

## 4. Channel Strip DSP Effects

Each track possesses a dedicated DSP effects drawer containing five hardware-modeled creative processors. Toggling the **On/Bypass** buttons routes the audio click-free through parallel dry/wet gain nodes.

```
[Audio Buffer Source]
        |
        +-----> [ Filtr Filter ] -------------> (Mix / Bypass Node)
        |                                                 |
        +-----> [ Luftikus Analog EQ ] --------> (Mix / Bypass Node)
        |                                                 |
        +-----> [ Scream Distortion ] ---------> (Mix / Bypass Node)
        |                                                 |
        +-----> [ Valentine Saturator ] -------> (Mix / Bypass Node)
        |                                                 |
        +-----> [ Ælapse Wow Delay & Spring ] -> (Mix / Bypass Node)
        |                                                 |
        +-----> [ Valentine Compressor ] ------> (Mix / Bypass Node)
                                                          |
                                                    [ Track Compressor ]
                                                          |
                                                    [ Track Panner ]
                                                          |
                                                    [ Track Volume Gain ]
                                                          |
                                                    [ Master Dynamics Chain ]
```

### 1. Filtr Filter
A multi-type resonant filter:
- **Type**: Selectable Lowpass (LP), Bandpass (BP), Highpass (HP), or Notch.
- **Cutoff**: Range from `20Hz` to `20,000Hz`.
- **Reso**: Adjusts resonance ($Q$ factor) from `0.1` to `25`.
- **Mix**: Dry/wet blend from `0%` to `100%`.

### 2. Luftikus Analog EQ
A 6-band analog-modeled equalizer featuring fixed-frequency bands for musical tone shaping:
- **Bands**: Peaking filters at `10Hz`, `40Hz`, `160Hz`, `640Hz`, and `2.5kHz`, plus a high-shelf boost (`Air Band`) at `12kHz`.
- **Range**: Each band provides boost/cut of up to `±12.0 dB` (adjustable in `0.5 dB` increments).

### 3. Scream Distortion
A resonant distortion module:
- **Cutoff**: Lowpass filter cutoff frequency (`200Hz` to `16,000Hz`) to tame harsh highs.
- **Scream**: Controls resonance ($Q$) and waveshaper drive intensity simultaneously (`0%` to `100%`).
- **Mix**: Dry/wet blend from `0%` to `100%`.

### 4. Valentine Distortion & Compressor
Parallel saturator and Justice-style pumping compressor:
- **Drive**: Sigmoid waveshaper gain scale (`1.0x` to `10.0x`) introducing odd-order harmonics.
- **Thresh**: Compressor threshold (`-40dB` to `0dB` / Off).
- **Ratio**: Compression ratio (`1:1` to `20:1`).
- **Mix**: Parallel blend of the saturated and compressed signal.

### 5. Ælapse Tape Delay & Spring Reverb
Time and space send-routing effects:
- **Sync**: Tempo-synced delay times linked to the global BPM using beat divisions (1/16, 1/8T, 1/8, dotted 8th, 1/4, dotted 1/4, 1/2, dotted 1/2, 1/1).
- **Feedback**: Tape delay feedback loop gain (`0%` to `95%`). Introduces pitch flutter via a `2Hz` LFO modulating delay time by `2ms`.
- **Reverb Size**: Repurpositions synthetic stereo convolution impulse response lengths (`0.5s` to `5.0s`).
- **Mixes**: Independent delay and reverb send levels.

---

## 5. Macro Controls & Automation

The FX drawer features a **Macro Controls** panel. These sliders act as master coordinators, automating multiple DSP parameters simultaneously:

| Macro | Modulates | Behavior / Mapping |
|---|---|---|
| **Space** | Reverb Mix + Delay Mix + Reverb Size | Sweeps from dry to fully washed with long decay times. |
| **Drive** | Valentine Drive + Saturation Mix + Scream Amount + Scream Mix | Morphing control that transitions from clean to fuzzy, distorted saturation. |
| **Tone** | Luftikus EQ Bands | Sweeps from **Dark** (bass boost, treble cut) to **Flat** to **Bright** (air boost, bass cut). |
| **Filter** | Filtr Cutoff + Filtr Mix | Sweeps from **Lowpass** (bipolar left) to **Off** (center) to **Highpass** (bipolar right). |
| **Reso** | Filtr Resonance | Increases filter peak sharpness. |
| **Delay** | Delay Mix | Increases delay presence. |
| **Feedback**| Delay Feedback | Increases feedback length up to 95%. |
| **Crush** | Scream Cutoff + Scream Amount | Swings lowpass filter down while driving distortion up for lo-fi decimation. |

---

## 6. Offline Rendering & Exporting

LoopMaster SA3 provides tools to export your work without loss of quality.

### Render Mix (Offline WAV Compilation)
Clicking the `⬇ Render Mix` button compiles the entire multi-track grid into a high-fidelity 16-bit PCM WAV file.
- **Offline Context**: The browser spawns an `OfflineAudioContext` running at the native hardware sample rate.
- **DSP Graph Replication**: Replicates all active track gains, pan positions, solo/mute/loop configurations, and all active FX drawer parameters (including convolver buffers and LFO delay modulations).
- **Render Length**: Renders the exact number of loops specified in the **Loops to Render** input field.
- **Faded Tail**: Automatically adds a `5.0` second tail at the end of the rendering with a linear fade-out, allowing delay echoes and reverb decays to ring out cleanly without clipping.

### Export Loops (Batch Export)
Clicking `Export Loops` fetches all active (unmuted and selected) variant WAV files, packages them client-side into a ZIP container using **JSZip**, and downloads them as `loopmastersa_loops_[BPM]bpm.zip` for instant drag-and-drop integration into external DAWs.

### Undo System
An internal stack-based Undo manager tracks track row deletions. Clicking **Undo** restores the deleted track’s DOM element, connects its Web Audio graph nodes in sync, and restores its mixer and FX parameters.

---

## 7. Keyboard Shortcuts & Advanced Workflows

### Keyboard Shortcuts
- **Spacebar**: Toggles play/pause (disabled when focused inside input fields).
- **Enter**: Submits the text input inside the Prompt box.
- **Double-Click**: Resets pan knobs, mixer macros, and FX macros to their default center values.

### Recommended Workflows
#### 1. Cohesive Track Construction
1. Set your project BPM (e.g. `124`) and Steps (`20` for solid quality).
2. Click `🥁 Drums` to generate a drum loop prompt. Click **Generate** and choose the best sounding variant card.
3. Hit `🎸 Bass` to create a bassline. Because the bassline generator is key-aware, it will lock onto a musical key (e.g. `A minor`). Choose a bass variant.
4. Click `🔑 In Key` or `🎹 Lead` to generate lead synths and melodies. The prompts will remain harmonically locked to `A minor`.
5. Open the FX drawer on individual rows to sculpt frequencies using the Luftikus EQ or add depth using the **Space** macro.

#### 2. The Remix, Inpaint & Continue Method
1. **Variation**: If you generate a guitar loop that you like, but want a slightly different melody, click the **Remix** button on its variant card. In **Variation** mode, set the **Noise Slider** to `0.40`. Click **Generate** to get four new variations with subtle melodic deviations.
2. **Inpaint**: If you want to regenerate just the middle section (e.g. seconds 2.0 to 6.0) of a guitar loop, click **Remix**, select **Inpaint** mode, drag the start slider to `2.0s` and the end slider to `6.0s`, then click **Generate**.
3. **Continuation**: If you want to keep the first `4.0s` of a loop but have the AI extend it with a new tail, click **Remix**, select **Continuation** mode, drag the "Keep First" slider to `4.0s`, and click **Generate**.
