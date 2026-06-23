---
confidence: high
volatility: cold
---

# Future Opportunities

This article documents proposed futures, architecture studies, and design options for LoopMaster SA3.

---

## 1. Server-Side Mixdown via `web-audio-api`

### Objective
Move the `OfflineAudioContext` mixdown export logic (which currently runs in the user's browser, consuming resources and locking UI loops during long exports) to a background Node.js process on the server.

### Library
`web-audio-api` (pure JS implementation of the Web Audio API for Node.js, requiring no native compilation dependencies).

### Proposed Execution Flow
1. User clicks **Render Mix**.
2. The frontend sends the project's `.lproj` state JSON to the server.
3. The server spins up a Node.js worker that loads the JSON, recreates the signal paths, and renders the WAV file.
4. The server returns a download link for the completed file.

---

## 2. Multi-Channel DAW Stem Routing

### Objective
Extend the WAV ZIP exporter to allow exporting tracks with their individual FX tails fully rendered (stems). Currently, loop ZIPs download raw variants. Rendering stems through the per-track Web Audio effects offline would allow direct DAW imports with EQ, Scream, and delays/reverbs preserved.

## Related Documents
- `[[concepts/architecture|System Architecture]]` ([System Architecture](../concepts/architecture.md))
- `[[concepts/dsp_effects|DSP & FX Processing]]` ([DSP & FX Processing](../concepts/dsp_effects.md))
