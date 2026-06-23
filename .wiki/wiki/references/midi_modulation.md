---
confidence: high
volatility: cold
---

# MIDI & Modulation Routing

This article documents the MIDI Learn mappings and the Global Modulations engine (LFOs & Matrix) in LoopMaster SA3.

---

## MIDI Learn Architecture

LoopMaster SA3 integrates standard MIDI controllers using the Web MIDI API:
- **Lazy Initialization**: Port listing and hardware requests (`navigator.requestMIDIAccess`) are deferred until the user clicks the **MIDI Learn** button (`#btn-midi-learn`) to minimize initialization issues and prevent unnecessary permission requests.
- **Mapping Protocol**:
  1. Click **MIDI Learn** to enter learn mode.
  2. Click any UI parameter control (knob, slider, bypass button).
  3. Move a hardware control on your MIDI device.
  4. The system registers the MIDI Control Change (CC) channel/number and maps it.
- **Persistence**: Mappings are serialized and saved in the browser's `localStorage` on change, reloading on page boot.

---

## Global Modulators

The Global Modulators panel drawer houses four independent Low Frequency Oscillators (LFO 1–4) and ADSR envelope generators.

### LFO Parameters
- **Shape**: Sine, Triangle, Saw, Square, or S&H (Sample & Hold / Random).
- **Sync**: Toggles between free-running frequency (0.1Hz to 20Hz) and BPM-synced beat divisions (e.g. 4 bars, 2 bars, 1 bar, 1/2, 1/4, 1/8, 1/16).
- **Offline Bouncing**: LFO shapes are calculated programmatically at 50ms intervals during offline mixdown to match realtime playback.

---

## Modulation Matrix Routing

An 8-slot matrix coordinates LFO routing to channel strip targets:

```
Modulator Source (LFO 1-4)
       │
       ▼  (Depth: -100% to +100%)
 Modulation Matrix Slot
       │
       ▼
Target Parameter:
  ├─ Volume (level)
  ├─ Panning (pan)
  ├─ Filter Cutoff (filter)
  ├─ Space Mix (space)
  ├─ Distortion Drive (drive)
  └─ Tuna FX parameters (Chorus, Phaser, Bitcrusher rates/depths/feedback)
```

- **Visual Feedback**: Mapped slider parameter controls display a small colored indicator dot that moves in real-time, showing the current modulation offsets.
- **Matrix Bypass**: A global Matrix Bypass toggle checkbox mutes all modulation slots simultaneously.

## Related Documents
- `[[concepts/dsp_effects|DSP & FX Processing]]` ([DSP & FX Processing](../concepts/dsp_effects.md))
- `[[topics/user_guide|User Guide]]` ([User Guide](../topics/user_guide.md))
