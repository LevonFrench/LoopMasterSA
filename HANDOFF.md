# Handoff: Audio Click Fix + Split Unqueue (Session 2026-05-29)

## Completed Work

### 1. Audio Click During Generation Fix
**File**: [app.js](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.js) (line 283)

Changed `new AudioContext()` to `new AudioContext({ latencyHint: 'playback' })`.

The `'playback'` hint tells the browser to use a larger audio buffer (~2048+ samples vs ~128-256), trading latency for glitch resistance. When the GPU is saturated during Stable Audio 3 inference, the default low-latency buffer starves and produces audible clicks. The larger buffer gives the audio thread enough headroom to survive GPU contention.

### 2. Split Mode Unqueue Fix
**File**: [app.js](file:///j:/projects/sa3/loopmaster/loopmaster-app/static/app.js) (line 5215)

Added an `else if` branch to the card click handler: when split mode is on and the user clicks the right half of a queued card, it now **unqueues** the card instead of instant-switching to it.

Handles both cases:
- `_pendingVariant === i` — a different variant queued for switch
- `_pendingVariant === -1` — the current variant queued for mute

Previously, right-half clicks on queued cards fell through to `selectVariant()` (instant switch), making the queue state feel broken.

### 3. Performance Optimizations (Previous)
- SDPA backends enabled in `model.py`
- `warmup_model()` added to `app_server.py` startup
- `dynamic=False` on torch.compile

### 4. Repository Cleanup, Verification, & Push
- Run verification scans on the workspace finding no untracked files or directories.
- Verified compilation and syntax cleanly on all modified Python/JS sources.
- Audited workspace for size bloat finding all files over 10MB are correctly ignored by git.
- Staged all modifications and pushed code changes to origin/main remote.

## Current System State
- **Server**: Flask at port 7861, restart needed for warmup changes
- **Frontend**: Refresh browser to pick up AudioContext and split mode fixes
- **Repository**: Pushed clean to origin/main (all local modifications committed)