---
confidence: high
volatility: cold
---

# User Guide

This guide describes how to operate the LoopMaster SA3 browser dashboard, generate multi-track loops, tweak effects, and export your creations.

## Setup & Launch

1. Open a terminal in the project root.
2. Run the interactive launcher:
   ```powershell
   .\run_server.bat
   ```
3. Select an execution model from the prompt menu:
   - **Option 1**: Medium Model (Official - FP32 Precision, High VRAM, GPU)
   - **Option 2**: Small Music Model (Lightweight, CPU/GPU)
   - **Option 3**: Small SFX Model (Sound Effects only)
   - **Option 4**: Medium Model (Optimized - BF16 Precision, Low VRAM, GPU)
4. Once loaded, open [http://localhost:7861](http://localhost:7861) in your browser.

---

## Workspace Layout

The interface is structured as a **Split Layout** containing three main panels:
1. **Header Transport Bar**: Contains the play/pause button, time progression readouts, global BPM/Steps sliders, and export controls.
2. **Arranger Playlist Timeline**: Sits under the transport bar, allowing loop-level arrangement muting and playback scrubbing.
3. **Tracks Grid**: A vertically scrollable container containing multi-track rows. Each row is composed of:
   - **Mixer Channel Strip**: Left-aligned controls containing Solo, Mute, FX, and MOD toggles, along with Copy, Paste, Regen, and Delete actions.
   - **Visual level VU Meters**: High-DPI canvas drawing real-time RMS (loudness) and peak hold levels.
   - **Rotary Knobs Section**: Quick access to Tone, Delay Mix (DMX), Reverb Mix (RMX), Pan, and Volume parameters.
   - **Variant Cards**: 4 waveforms representing generated audio candidates.

---

## Generating Loops

### Prompting Rules
Type descriptive textual descriptions into the prompt box. A good structure is: **mood + instruments + style + production techniques**.
- **Example**: `heavy industrial distorted drum beat, punchy compression, dark moody synth bassline, 120 bpm`

### Prompt Variation Buttons
Eight SVGs positioned in the prompt header row let you modify prompts:
- **Random**: Generates a completely new prompt.
- **In Key**: Keeps the active key signature but changes style and instruments.
- **Chord**: Swaps the chord progression inside your prompt.
- **Style**: Randomizes style/genre terms.
- **Inst**: Replaces the active instrument with an alternative.
- **Accent**: Swaps the production accent or style tags.
- **Drums**: Generates a BPM-aware drum sequence prompt.
- **Bass**: Synthesizes bass prompts locked to the active key.
- **Lead**: Synthesizes melodic synth/guitar lead prompts.

---

## Track Mixer Controls

The track mixer strip buttons are organized as a compact 2x4 grid:
- **Row 1**: Solo (`S`), Mute (`M`), FX drawer toggle (`FX`), Global Modulators drawer toggle (`MOD`).
- **Row 2**: Copy Settings, Paste Settings, Regenerate Unlocked, Delete Track.

### Parameter Knobs
- **Tone**: Sweeps EQ response (dark-bass to bright-air).
- **DMx**: Delay Mix (Send mix level).
- **RMx**: Reverb Mix (Send mix level).
- **Pan**: Stereo position (Double-click to center).
- **Vol**: Channel fader (Defaults to `80` / `0.8` gain).

---

## Saving & Loading Projects

- **Save Project**: Clicking the Save button serializes the track configuration, volume, pan, all LFO mod matrix routing slots, and current generation parameters into a `.lproj` JSON file.
- **Load Project**: Drag-and-drop or select an `.lproj` file to restore the entire session state, reload buffers, and connect the Web Audio graph.
- **Missing File Reconstruction**: If local WAV files are missing, a warning banner appears at the top of the grid. Click **Remake Missing** to sequentially regenerate missing audio variants using stored seed/prompt metadata.

## Related Documents
- `[[topics/remixing|Remixing & Outpainting]]` ([Remixing & Outpainting](remixing.md))
- `[[references/midi_modulation|MIDI & Modulation Routing]]` ([MIDI & Modulation Routing](../references/midi_modulation.md))
