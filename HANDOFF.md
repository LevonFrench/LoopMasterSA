# HANDOFF — LoopMaster SA3

## Session Summary (2026-05-26 evening)

### What Was Done

**App Rename** → LoopMaster SA3

**SA3 Generation Controls** — Seed (-1=random, 0-999999), CFG (0.5-15), Steps (1-100). All draggable like BPM (drag ↕, double-click to type). Wired through API to `model.generate()`.

**FX Text Overflow Fix** — Label width 36→48px, font 0.55→0.5rem, value span 40→36px. FX sections 220→200px min. All text truncates cleanly.

**8 FX Macro Knobs** — Space, Drive, Tone (original) + Filter (bipolar LP/HP), Reso, Delay, Feedback, Crush. Each dispatches to the relevant FX sliders.

**Card Click Zones** — Left half of card = queue variant switch for next loop boundary (pulsing amber dashed border). Right half = instant switch. Subtle vertical center divider line. Removed Queue toggle from transport bar.

**Volume Slider** — Track height 4→6px, thumb 12→14px.

**Tooltips** — All generation controls have detailed mouseover info explaining what each parameter does and how to interact.

**Seek Toggle** — ON by default. Click waveform to seek playhead. Turn OFF to disable.

**Reverse Fix** — Only restarts the specific track source, not all playback.

**Export Loops** — Zips all selected variant WAVs via JSZip.

**Lead/Bass Buttons** — Key/BPM aware prompt generators.

**Visualizer Tray** — Spectrum analyzer, oscilloscope, peak meters.

**Transport Panel** — Wrapped in styled box matching other panels.

---

### Outstanding

- **Tempo-synced LFO + volume peak control** of FX/mix/feedback with knobs next to sliders — NOT STARTED.

---

### Key Files

| File | Changes |
|------|---------|
| `static/index.html` | SA3 inputs with tooltips, seek toggle, card zones, 8 macros |
| `static/app.js` | Draggable inputs, card left/right zones, 8 macro handlers, reverse fix, queue at loop boundary |
| `static/app.css` | Thicker slider, card zone divider, FX text overflow fix, macro layout for 8 knobs |
| `app_server.py` | Seed param plumbed through API |

### Audio Signal Chain
```
TrackSource → Luftikus EQ → Valentine → Ælapse → Compressor(-6dB,5:1) → Panner → Gain → Analyser → MasterGain → Limiter(-11dB) → Makeup(+11dB) → Analyser → Dest
                                                                                                          ↘ VizAnalyser (FFT 2048)
```

### Card Click Behavior
```
┌─────────────────┬─────────────────┐
│   LEFT HALF     │   RIGHT HALF    │
│   Queue at      │   Instant       │
│   loop start    │   switch        │
│   (amber dash)  │                 │
└─────────────────┴─────────────────┘
```
