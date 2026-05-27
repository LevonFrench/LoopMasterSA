# HANDOFF — LoopMaster SA3

## Session Summary (2026-05-26 evening)

### What Was Done

**Number Input Interaction** — All number inputs (BPM, Seed, CFG, Steps) use unified deadzone logic: single click = focus for typing, drag ↕ 3px+ = drag mode. Cursor shows `ns-resize`. No double-click required.

**8 FX Macro Knobs** — Space, Drive, Tone + Filter (bipolar LP/HP), Reso, Delay, Feedback, Crush. Each dispatches to its FX sliders.

**Card Click Zones** — Left half = queue at loop boundary (pulsing amber). Right half = instant switch. Hover shows `◀ queue` / `instant ▶` labels. Queue toggle removed from transport.

**Controls Guide** — Empty state shows visual diagram: card zones, seek toggle, input interaction tips.

**Delay Default** → 1/8th note (was dotted 8th).

**FX Text Overflow** — Labels 48px wide, font 0.5rem, values 36px. All text truncates.

**Volume Slider** — 6px track, 14px thumb.

**SA3 Params** — Seed (-1=random), CFG (0.5–15), Steps (1–100). Tooltips on all labels and inputs.

**Seek Toggle** — Click waveform to jump playhead (on) or just select (off).

**Reverse Fix** — Only restarts specific track source, not all playback.

**Export Loops** — Zips selected variant WAVs via JSZip.

**Lead/Bass/Drums/In-Key Buttons** — Key/BPM aware prompt generators.

**Visualizer Tray** — Spectrum, oscilloscope, peak meters.

---

### Outstanding

- **Tempo-synced LFO + volume peak control** of FX/mix/feedback with knobs next to sliders — NOT STARTED.

---

### Key Implementation Details

**Deadzone Drag Pattern** (`makeDraggableInput`):
```
mousedown → pending=true, activated=false
mousemove → if |dy| >= 3px: activated=true, blur, start drag
mouseup → if !activated: focus+select (click). Reset.
```

**Card Click Zone Logic**:
```
clickX < cardWidth/2 → queue (left half)
else → selectVariant (right half, instant)
```

**Audio Signal Chain**:
```
Source → EQ → Valentine → Ælapse → Compressor → Panner → Gain → Analyser → Master → Limiter(-11dB) → Makeup(+11dB) → Dest
```

### Key Files

| File | Role |
|------|------|
| `static/app.js` | All frontend logic, audio routing, drag handlers, macros |
| `static/app.css` | Styling, card zones, guides, FX layout |
| `static/index.html` | Layout, controls, tooltips, empty state guide |
| `app_server.py` | Flask API, seed/cfg/steps plumbing |
