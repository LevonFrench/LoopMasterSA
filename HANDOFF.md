# HANDOFF — LoopMaster SA3

## Session Summary (2026-05-26 late evening)

### What Was Done This Session

**Remake → Remix** — Renamed the "Remake" button to "Remix" across JS and HTML.

**Removed Empty State Guide** — Stripped the card zone diagram, split mode demo, and drag tips from the empty state. Now just shows music icon + "Enter a prompt and hit Generate".

**Removed Docs Module** — Deleted the collapsible "How to Use LoopMaster SA3" step-by-step documentation panel and all associated CSS/JS.

**CFG Removed from UI** — Removed the CFG input from the controls panel. Backend still defaults to 1.0 automatically.

**Pan Knob Repositioned** — Moved pan knob to column layout (knob above label) in mixer-vol-pan row, sized 18×18 to match macro knobs. Sits directly above the last macro knob (S/C).

**Audio Cutoff Fix** — Server now generates `duration + 2.0s` of audio and hard-trims to exact loop length before saving. Prevents waveforms from dying off in the last 1-2 seconds.

**FX Labels Centered** — Changed FX control row labels and value readouts from `text-align: right` to `text-align: center`.

**Prompt Panel Tightened** — Reduced controls-panel padding from 18px to 12px vertical.

**Random Generators Expanded** — Massively expanded all prompt arrays:
- Instruments: 17 → 53
- Styles: 14 → 35, plus 24 moods + 12 production style tags
- Keys: 12 → 24 (with modes), Chords: 8 → 16
- Drums: 20 → 32 genres, 16 → 24 descriptors, + 10 drum elements
- Bass: 32 → 48 styles, 18 → 28 descriptors
- Lead: 32 → 48 styles, 22 → 32 descriptors

---

### Outstanding

- **Tempo-synced LFO + volume peak control** of FX/mix/feedback with knobs next to sliders — NOT STARTED.

---

### Key Implementation Details

**Generation Headroom** (`app_server.py`):
```python
gen_duration = duration + 2.0  # Generate longer
audio = model.generate(duration=gen_duration, ...)
exact_samples = int(duration * sample_rate)
audio = audio[:, :, :exact_samples]  # Trim to exact loop
```

**Deadzone Drag Pattern** (`makeDraggableInput`):
```
mousedown → pending=true, activated=false
mousemove → if |dy| >= 3px: activated=true, blur, start drag
mouseup → if !activated: focus+select (click). Reset.
```

**Card Click Zone Logic** (gated by Split toggle):
```
Split OFF → all clicks are instant switch
Split ON  → clickX < cardWidth/2 → queue (left half)
            else → selectVariant (right half, instant)
```

**Audio Signal Chain**:
```
Source → EQ → Valentine → Ælapse → Compressor → Panner → Gain → Analyser → Master → Limiter(-11dB) → Makeup(+11dB) → Dest
```

### Key Files

| File | Role |
|------|------|
| `static/app.js` | All frontend logic, audio routing, drag handlers, macros, prompt generators |
| `static/app.css` | Styling, card zones, FX layout, pan/macro knob sizing |
| `static/index.html` | Layout, controls, tooltips |
| `app_server.py` | Flask API, generation headroom + trim logic |
| `wiki/Home.md` | Knowledge base with architecture, controls, FX docs |
