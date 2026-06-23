---
title: "Plan: Engine Selection and Alternative Models"
type: plan
format: roadmap
sources: [j:\projects\sa3\.wiki\wiki\concepts\architecture.md, j:\projects\sa3\.wiki\wiki\concepts\generation_pipeline.md]
generated: 2026-06-23
project: sa3
---

# Plan: Engine Selection and Alternative Models

> Generated from LoopMaster SA3 Knowledge Base (2 articles consulted)

## Executive Summary
Currently, LoopMaster SA3 is hardcoded to run Stable Audio 3. To expand the creative capabilities and provide alternatives that don't crash on unsupported hardware, we will implement an engine selection layer. This allows users to choose between Stable Audio 3, Stable Audio Open, MusicGen, and AudioLDM 2 at startup.

## Architecture Decisions

### Decision 1: Backend Routing Strategy
**Context**: [System Architecture] documents that the Flask server exposes API routes to the frontend.
**Options considered**:
- Option A: Refactor `app_server.py` to use a Strategy pattern for all engines in one file.
- Option B: Create separate server scripts (`app_server_musicgen.py`) that implement the same API contract but keep dependencies isolated.
**Decision**: Option B. Different engines require different heavyweight libraries (`audiocraft` vs `diffusers`). Running them in separate processes minimizes memory leaks and avoids CUDA context clashes.
**Consequences**: The Electron `main.js` must handle routing the launch command to the correct script.

### Decision 2: Stable Audio Open Placement
**Context**: Stable Audio Open uses the identical DiT architecture as Stable Audio 3.
**Decision**: Treat Stable Audio Open as just another model weight option inside the existing `app_server.py` rather than a standalone engine.

## Implementation Phases

### Phase 1: Launcher & Electron Shell Updates
**Goal**: Allow users to select their engine on boot.
**Tasks**:
- [ ] Add Engine dropdown to `launcher.html`.
- [ ] Update `main.js` to launch the appropriate backend script based on the Engine selection.

### Phase 2: Engine API Contracts
**Goal**: Ensure new backends communicate identically with `app.js`.
**Tasks**:
- [ ] Implement `app_server_musicgen.py` handling `/api/generate` and returning tracks in the expected `session_X/track_Y` format.
- [ ] Adapt `wav_metadata.py` to optionally skip SA3-specific prompt injections for non-SA3 engines.

### Phase 3: MusicGen & AudioLDM Execution
**Goal**: Generate audio.
**Tasks**:
- [ ] Integrate Meta's `audiocraft` for MusicGen loops (with crossfade patching).
- [ ] Integrate `diffusers` AudioLDM2 pipeline.

## Risks & Mitigations
| Risk | Source | Mitigation |
|------|--------|------------|
| VRAM OOM on switching | Technical | By using separate processes, closing the SA3 server and starting the MusicGen server fully clears VRAM. |
| Dependency Conflicts | Technical | We will attempt to install `audiocraft` and `diffusers` in the same `.venv`. If pip conflicts arise, we will create dedicated venvs. |

## Open Questions
- Do we need remixing (inpaint, continue) supported in MusicGen on day 1?
- Should we use the exact same tail-crossfade logic for making MusicGen audio seamless?
