---
confidence: high
volatility: cold
---

# DSP & FX Processing

This article documents the digital signal processing (DSP) features, Web Audio API graph structures, and Master Limiter specifications in LoopMaster SA3.

## Channel Strip Effects

Each audio track row contains a dedicated channel strip with five main processors configured in series or parallel loops. All effects can be independently bypassed, which dims their UI indicators and routes audio directly through dry/wet gain nodes.

### 1. Resonant Filter (Filtr)
- **Design**: Split High-Pass (HP) and Low-Pass (LP) filter chain.
- **Node Type**: Two series-connected `BiquadFilterNode` structures.
- **Ranges**: Cutoff: 20Hz–20kHz, Q (Resonance): 0.1–25.
- **Macro Control**: The front-panel **Filter** knob sweeps from Lowpass (0% to 50%) to Bypass (50%) to Highpass (50% to 100%).

### 2. Analog EQ (Luftikus)
- **Design**: Replicates the hardware Luftikus mastering EQ.
- **Node Type**: A chain of 6 peaking `BiquadFilterNode` structures.
- **Bands**: Fixed center frequencies at 10Hz, 40Hz, 160Hz, 640Hz, 2.5kHz, and a High-Shelf "Air" band at 12kHz.
- **Gain Range**: Each band supports `±16dB` of boost or cut, stepping by `0.5dB` (increased from `±12dB` to prevent clamping of extreme macro EQ curves).

### 3. Distortion (Scream)
- **Design**: Resonant tube-style soft clipping.
- **Node Type**: A `WaveShaperNode` loaded with a custom sigmoid distortion curve.
- **Pre-filtering**: A pre-distortion `BiquadFilterNode` (lowpass) sweeps from 200Hz to 16kHz to soften high-end harshness.
- **Drive**: Controls input saturation level and soft clipping gain.

### 4. Tuna.js Effects Suite
- **Chorus**:
  - **Node**: Tuna Chorus node.
  - **Parameters**: Rate (0.01Hz to 8Hz, or synced to beat divisions), Depth (0 to 1), and Feedback (0 to 0.95).
- **Phaser**:
  - **Node**: Tuna Phaser node.
  - **Parameters**: Rate (0.01Hz to 8Hz, or synced to beat divisions), Depth (0 to 1), and Feedback (0 to 1).
- **Bitcrusher**:
  - **Node**: Tuna Bitcrusher node.
  - **Parameters**: Resolution (1 to 16 bits), Sampling Frequency down-sampling (0.001 to 1.0).

### 5. Tape Delay & Reverb (Ælapse)
- **Tape Delay**:
  - **WOW LFO**: A `2Hz` low-frequency oscillator modulates the delay time parameter by `±0.5%` (`±0.005s` max) to emulate tape wow/flutter pitch drift.
  - **BPM Sync**: Delay times are locked to tempo-synced beat divisions (1/16 through 1/1) using the equation `45.0 / bpm` for a dotted-eighth note division.
- **Spring Reverb**:
  - **Impulse Response**: A custom ConvolverNode loaded with programmatically generated stereo decay waveforms.
  - **Size**: Reverb Size maps from 0.5s to 5.0s, regenerating the convolver impulse response on the fly on parameter updates.
- **Bypass & Sends**:
  - Tape Delay and Spring Reverb are routed in parallel as send effects (dry signal gain remains fixed at 1.0), and feature independent bypass states.

---

## Macro Knobs Calibration

The mixer and FX drawer feature macro controls that map single input sliders to multiple Web Audio parameters:
- **Tone**: Sweeps the 6 Luftikus EQ bands. Boosts or cuts frequencies by up to `13.52dB` (extreme endpoints increased by a factor of 1.3 for more coloring capability).
- **Drive**: Coordinates Scream input drive and pre-filter cutoff.
- **Space**: Sweeps Reverb Mix (capped at 80% wet, scaling reverb size from 0.5s to 5.0s) and Delay Mix (capped at 75% wet, scaling delay feedback from 0% to 95%).
- **Filter**: Controls LP/HP cutoff and dry/wet blends simultaneously.

---

## Master Bus Limiter

To prevent digital clipping while boosting perceived loudness, the master bus features a brickwall limiter:
- **Limiter Node**: A native `DynamicsCompressorNode` on the root `AudioContext`.
- **Calibration Settings**:
  - Threshold: Fixed at `-1.0 dB` (uncoupled from master fader to eliminate low-end compression distortion).
  - Knee: `8.0 dB` (soft knee for transparent compression).
  - Ratio: `20:1` (brickwall limiting).
  - Attack: `3 ms`.
  - Release: `250 ms`.
- **Makeup Gain**: Fixed at `0.0 dB` post-limiting makeup gain.
- **Volume Fader Mapping**:
  - The master volume knob attenuates output gain from `0.0 dB` (value 100) down to `-68.5 dB` / silence (value 0).

---

## Offline Audio Rendering

The **Render Mix** function performs a non-realtime bounce of the grid layers:
1. Instantiates an `OfflineAudioContext` matching the project sample rate (44.1kHz).
2. Re-creates the entire serial/parallel Web Audio node graph for each active channel strip (including EQ nodes, Scream shaper, Tuna chorus/phaser/bitcrusher, wow delay LFOs, and convolver reverbs).
3. Connects the master fader gain, master compressor, and limiter parameters.
4. Schedules playback, automation envelopes, and arranger mutes.
5. Renders the audio buffer and encodes it as a high-fidelity 16-bit WAV file.

## Related Documents
- `[[concepts/architecture|System Architecture]]` ([System Architecture](architecture.md))
- `[[references/midi_modulation|MIDI & Modulation Routing]]` ([MIDI & Modulation Routing](../references/midi_modulation.md))
