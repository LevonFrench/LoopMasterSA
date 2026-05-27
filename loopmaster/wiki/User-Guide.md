# User Guide

Everything you need to know to use LoopMaster SA3.

---

## Setup & Launch

1. Run `.\run_server.bat` from the project root
2. Pick a model (Medium for quality, Small for speed)
3. Open [http://localhost:7861](http://localhost:7861)

You need Python 3.10+, a CUDA GPU (optional but recommended), and the SA3 model weights downloaded. See the [README](../../README.md) for full setup instructions.

---

## Generating Loops

### The Prompt Bar
Type what you want to hear. SA3 works best with structured prompts:

```
dreamy solo grand piano jazz improvisation in C minor, tape saturated
```

Good prompts include: **mood** + **instrument** + **genre** + **key** + **production style**.

The backend automatically adds looping tags, quality descriptors, and timing metadata — you don't need to include those.

### Prompt Buttons
Eight buttons sit below the prompt field for fast prompt generation:

| Button | What it does |
|--------|-------------|
| **Random** | Full random prompt — picks instrument, style, mood, key |
| **In Key** | Random prompt locked to the current key/chord |
| **Chord** | Swaps only the key/chord in your current prompt |
| **Style** | Swaps only the genre/style |
| **Inst** | Swaps only the instrument |
| **Drums** | Random drum loop prompt (BPM-aware, no key) |
| **Bass** | Random bassline locked to current key |
| **Lead** | Random melody/lead locked to current key |

### Generation Parameters

| Control | Default | What it controls |
|---------|---------|-----------------|
| **BPM** | 120 | Tempo. Determines loop length (4 bars). |
| **Seed** | -1 | Reproducibility. -1 = random. Set a number to get the same output. |
| **Steps** | 8 | Quality vs speed. 8 = fast drafts, 20+ = polished output. |

All number inputs support **click-to-type** and **vertical drag** to adjust.

---

## The Grid

Each generation creates a **track row** with four variant cards. Tracks stack vertically — add as many layers as you want.

### Variant Cards
Each card shows the waveform and filename. Click a card to switch to that variant.

With **Split mode ON** (toggle in the transport bar):
- **Left half click** → Queues the switch at the next loop boundary (pulsing amber border)
- **Right half click** → Instant switch

With **Seek ON**, clicking a waveform also seeks the playhead to that position.

### Track Controls (Mixer Strip)
Every track row has a mixer strip on the left:

| Control | What it does |
|---------|-------------|
| **S** | Solo — mutes everything except soloed tracks |
| **M** | Mute — silences this track |
| **Lock** | Freezes all controls for this row (amber border) |
| **FX** | Opens/closes the effects drawer |
| **Volume** | Track gain (0–100%) |
| **Pan** | Stereo position. Drag vertical, double-click to center. |
| **Delete** | Removes the track row |
| **Reverse** | Flips the audio backward in-place |
| **Meters** | Real-time RMS loudness + peak + peak hold |

### Mixer Macro Knobs
A row of small knobs on each mixer strip for quick FX access:

**Flt** (Filter cutoff), **Res** (Resonance), **DFb** (Delay feedback), **DMx** (Delay mix), **RSz** (Reverb size), **RMx** (Reverb mix), **S/C** (Scream/Crush)

Drag vertically to adjust. Double-click to reset.

---

## Variant Locking & Regeneration

- Click the **lock icon** on any variant card to protect it
- Locked variants show an amber border and won't change during regeneration
- Click the **refresh icon** on the mixer strip to regenerate only the unlocked variants
- Useful for keeping your best take while auditioning alternatives for the others

---

## Remixing

Click **Remix** on any variant card to use it as a seed for new generations. Four remix modes:

### Variation
The default. Generates new variants based on the seed audio. Use the **Noise** slider to control how far the output deviates:
- **Low (0.10–0.30)** — Subtle changes, same character
- **Mid (0.40–0.60)** — Noticeable variation, same vibe
- **High (0.70–0.90)** — Major creative departures

### Response (Call & Response)
Keeps the first half of the seed loop exactly, regenerates the second half. Creates natural musical call-and-response patterns.

### Inpaint
Regenerates a specific time range within the loop. Set **start** and **end** sliders to define the region. Everything outside the region stays intact.

### Continuation
Keeps the beginning of the loop up to a split point, generates fresh material for the remainder. Set the **Keep First** slider to control the split.

### Invert Timing
A toggle available in all remix modes. Reverses the seed audio's timing before generating — creates variations that mirror the original's rhythmic structure.

---

## Effects (FX Drawer)

Click **FX** on any track to open its effects drawer. Five processors, each with On/Bypass:

### Filtr — Resonant Filter
Multi-type filter with LP, BP, HP, and Notch modes.
- **Cutoff**: 20Hz–20kHz
- **Reso**: Resonance peak sharpness (0.1–25)
- **Mix**: Dry/wet blend

### Luftikus — Analog EQ
Six fixed-frequency bands for musical tone shaping:
- **10Hz, 40Hz, 160Hz, 640Hz, 2.5kHz** — Peaking filters, ±12dB in 0.5dB steps
- **Air** — High-shelf at 12kHz

### Scream — Distortion
Resonant distortion with taming control:
- **Cutoff**: Lowpass filter (200Hz–16kHz) to control harshness
- **Scream**: Drive intensity + resonance (0–100%)
- **Mix**: Dry/wet blend

### Valentine — Saturation & Compression
Parallel saturator and pumping compressor:
- **Drive**: Waveshaper intensity (1x–10x)
- **Thresh**: Compressor threshold (-40dB to 0dB)
- **Ratio**: Compression ratio (1:1 to 20:1)
- **Mix**: Parallel blend

### Ælapse — Tape Delay & Spring Reverb
Time and space effects:
- **Sync**: Tempo-synced delay times (1/16 through 1/1, including dotted and triplet divisions)
- **Feedback**: Delay feedback with tape-style pitch flutter (0–95%)
- **Reverb Size**: Convolution IR length (0.5s–5.0s)
- **Delay Mix / Reverb Mix**: Independent send levels

---

## Macro Controls

The FX drawer includes macro knobs that control multiple parameters at once:

| Macro | What it sweeps |
|-------|---------------|
| **Space** | Reverb mix + delay mix + reverb size → dry to washed |
| **Drive** | Valentine drive + saturation + scream → clean to destroyed |
| **Tone** | Luftikus EQ → dark to bright |
| **Filter** | Filtr cutoff + mix → lowpass (left) to off (center) to highpass (right) |
| **Reso** | Filter resonance peak |
| **Delay** | Delay presence |
| **Feedback** | Delay feedback length |
| **Crush** | Scream cutoff down + distortion up → lo-fi decimation |

---

## Transport & Visualizers

### Transport Bar
- **Play/Pause** (or Spacebar) — Starts/stops all tracks in sync
- **Time display** — Current position and loop length
- **Master meter** — Real-time level with limiter indicator
- **Seek toggle** — Whether waveform clicks seek the playhead
- **Split toggle** — Whether cards have queue/instant click zones

### Visualizer Tray
Three real-time displays driven by the master output:
- **Spectrum Analyzer** — 128-band FFT (20Hz–20kHz)
- **Oscilloscope** — Waveform trace
- **Peak Meters** — L/R level bars

---

## Exporting

### Render Mix
Bounces the entire session to a single 16-bit WAV file:
- All track volumes, pans, mute/solo states, and FX are applied
- Set **Loops to Render** to control the output length
- Automatic 5-second fade-out tail for reverb/delay decay

### Export Loops
Downloads all active variant WAVs as a ZIP file. Files are already ACIDized with BPM, key, and beat markers — ready for drag-and-drop into any DAW.

### Undo
Restores the last deleted track (DOM, audio graph, mixer state, FX parameters).

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Spacebar** | Play / Pause |
| **Enter** | Submit prompt |
| **Double-click** | Reset knobs/macros to default |

---

## Recommended Workflows

### Building a Track from Scratch
1. Set BPM (e.g. 124) and Steps (20 for quality)
2. Click **Drums** → Generate → pick the best variant
3. Click **Bass** → it auto-locks to a key → Generate → pick a variant
4. Click **In Key** or **Lead** → stays in the same key → Generate
5. Open FX drawers to sculpt — use **Tone** macro for quick EQ, **Space** for reverb

### Iterating with Remix
1. Find a variant you almost like
2. Click **Remix** on its card
3. Use **Variation** mode with noise at 0.40 → Generate
4. Lock the best variants, regenerate the rest
5. Use **Inpaint** to fix just one section if needed

### Exporting to a DAW
1. Mute anything you don't want
2. Click **Export Loops** for individual stems (ACIDized WAV ZIP)
3. Or click **Render Mix** for a single mixed bounce with FX applied
