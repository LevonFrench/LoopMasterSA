# HANDOFF — LoopMaster SA3

## Session Summary (2026-05-26 evening)

### What Was Done

**Visualizer Tray** — Added a pulse-visualizer-inspired real-time audio visualizer between the transport bar and tracks. Three canvases: spectrum analyzer (log FFT bars), oscilloscope (waveform trace), peak meters (L/R bars). All driven by a dedicated `AnalyserNode` tapped off `masterGain`.

**Transport Panel** — Wrapped transport bar + visualizer in a styled panel matching the prompt box and track row styling (bg-card, border, blur). Removed the Stop All button (play/pause handles this).

**SA3 Generation Controls** — Exposed Seed (-1 = random), CFG (classifier-free guidance scale, 0.5–15), and Steps (diffusion steps, 1–100) as inputs next to BPM. All three are wired through the API to `model.generate()`.

**Seek Toggle** — Clicking on a waveform card jumps the playhead only when Seek toggle is ON (default ON). Prevents accidental seeks.

**Queue Toggle** — When ON, clicking a different variant queues it (pulsing amber dashed border). The switch happens at the next loop boundary via `updatePlayheads()` detecting pct wrap-around.

**Reverse Fix** — Reversing a clip no longer calls `stopAll()/playAll()`. It only restarts the specific track's source node in sync.

**Export Loops** — Button next to Render Mix that zips all currently selected (non-muted) variant WAVs using JSZip (CDN-loaded) and downloads as a zip file.

**Lead Random Button** — 🎹 Lead button with 32 lead styles × 22 descriptors, key/bpm aware (same pattern as Bass).

**Waveform Scaling** — Two-pass drawing: first pass finds global peak, second pass normalizes bars so tallest fills 90% of height.

**Tighter Cards** — Removed fixed 90px height, reduced padding/gap, increased waveform min-height to 48px. Cards auto-size to content.

**"Loops to Render"** — Renamed from "Loops".

**App Name** — Changed from "LoopmasterSA" to "LoopMaster SA3".

---

### Outstanding / Not Started

- **LFO/Peak Control**: "I want to add tempo synced lfo and volume peak control of all the fx mix and feedback elements controlled with knobs next to the sliders." — NOT STARTED.

---

### Key Technical Details

| File | What Changed |
|------|-------------|
| `stable-audio-3/static/index.html` | Seed/CFG/Steps inputs, Lead button, Export Loops button, Seek/Queue toggles, transport panel wrapper, app name |
| `stable-audio-3/static/app.js` | Visualizer tray rendering (renderVizSpectrum/Osc/Meters), initVizAnalyser, queue processing in updatePlayheads, seek/queue toggle logic in card click, waveform two-pass scaling, reverse fix, export loops handler, lead prompt generator, SA3 params in runGeneration |
| `stable-audio-3/static/app.css` | Transport-panel wrapper, visualizer tray, toggle switch, control-input-sm, is-queued animation, export button, tighter card sizing |
| `stable-audio-3/app_server.py` | `seed` parameter plumbed through API → `_run_generation` → `model.generate()` |
| `wiki/Home.md` | Full rewrite with new features documented |

### Audio Signal Chain
```
TrackSource → Luftikus EQ → Valentine → Ælapse → TrackCompressor(-6dB,5:1,10ms) → Panner → Gain → Analyser → MasterGain → Limiter(-11dB) → Makeup(+11dB) → MasterAnalyser → Destination
                                                                                                          ↘ VizAnalyser (FFT 2048)
```

### State Variables
- `vizAnalyser` — Separate AnalyserNode (fftSize=2048) for visualizer, tapped off masterGain
- `prevPlayPct` — Tracks previous playhead pct to detect loop boundary for queue processing
- `track._pendingVariant` — Queued variant index (set when Queue toggle is ON)
- `track._autoPlay` — Flag set by addTrackRow for deferred auto-play after buffer decodes
