---
confidence: high
volatility: cold
---

# Remixing & Outpainting

This article describes how to modify, extend, and manage generated audio variants using the LoopMaster SA3 Remix Engine.

## Variant Management

Each track row contains four generated cards. You can interact with individual card slots:
- **Locking**: Click the padlock icon on a card to protect it. Locked cards are highlighted with an amber border and will not change when clicking the mixer's **Regen** button.
- **Deletion**: Click the Delete button in the card header. The server removes the file via the `POST /api/delete_variant` endpoint and dims the card, freeing up memory in the Web Audio context.
- **Split Mode & Queued Deactivation**:
  - With **Split Mode ON**, clicking the left side of a variant card queues a switch to that variant at the next loop boundary (showing a pulsing amber border).
  - Clicking the left side of the *currently playing* variant queues a **deactivation** (turning off the track at the next loop boundary).

---

## Remix Modes

Clicking **Remix** on a variant card populates the Init Audio badge and allows you to regenerate variations based on that seed.

```
Init Audio Input (WAV)
  │
  ├──► [Variation] ──────► Combines seed with noise (0.10 - 0.90)
  │
  ├──► [Response] ───────► Keeps first 50% (Call), regenerates last 50% (Response)
  │
  ├──► [Inpaint] ────────► Regenerates user-selected start/end range
  │
  └──► [Continuation] ───► Keeps up to split point, generates new tail
```

### 1. Variation
- **Details**: The model uses the seed audio as a starting point.
- **Control**: Adjust the **Noise** slider:
  - `0.10 - 0.30` (Low): Very close to the original, minor timbre shifts.
  - `0.40 - 0.60` (Medium): Noticeable variations, preserves basic rhythm.
  - `0.70 - 0.90` (High): Creative departures, retains only general character.

### 2. Response (Call & Response)
- **Details**: Keeps the first 50% of the loop intact (the "call"), while regenerating the second 50% (the "response").
- **Implementation**: Maps to inpainting with a mask range set between `duration / 2.0` and `duration`.

### 3. Inpaint
- **Details**: Regenerates a specific time region within the loop.
- **Control**: Drag the **Start** and **End** sliders in the remix panel to isolate the target window.

### 4. Continuation
- **Details**: Keeps the loop up to a user-defined split point, then generates fresh material for the rest of the loop.
- **Control**: Adjust the **Keep First** slider to configure the split point.

### Invert Timing
- **Details**: Available as a toggle in all remix modes.
- **Implementation**: Reverses the seed audio along the time axis using PyTorch's `torch.flip(init_waveform, dims=[-1])` before processing, creating backward progression structures.

---

## Outpainting (2x & 4x)

To extend loops beyond their original length:
- **Operation**: Click the **2x** or **4x** buttons on a variant card.
- **Behavior**: The server initiates an outpainting process starting at the parent track's duration. It creates a new track row directly below the parent track.
- **Visual Grid Span**: Cards in the outpainted row are assigned column-span layout rules (`.span-2` or `.span-4`) in `app.css` to visually represent their extended length relative to standard 8-second loops.
- **Timeline Alignment**: The global playhead loop duration dynamically updates to match the maximum active variant length, keeping the extended tracks in sync.

## Related Documents
- `[[concepts/generation_pipeline|Generation Pipeline]]` ([Generation Pipeline](../concepts/generation_pipeline.md))
- `[[topics/user_guide|User Guide]]` ([User Guide](user_guide.md))
