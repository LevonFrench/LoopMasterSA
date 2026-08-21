# Changelog

## 2026-08-21 — Unified prompt composer and chord progressor

- Unified prompt writing in the top composer, with unrestricted free text alongside structured choices, and removed the redundant Final Prompt box.
- Added a focused File Naming popup for the canonical asset rules and removed the raw chord-map readout from the main interface.
- Rebuilt the builder as an exact 3×3 layout: Acoustic/Electric/Drums randomizes one active source, Genre/Key/Performance randomizes every unlocked row, and Mood/Avoid/Modifiers randomizes one active character; muting is now a value-preserving lock for Random All.
- Expanded the grouped, externally editable prompt catalogs to 1,468 selectable values while keeping manually chosen format and instrument-specific groups out of random rolls.
- Added 62 FL-style four-chord progressions (31 major and 31 minor), four resolved chord cards, deterministic four-bar cycling, and exact chord-track conditioning on the server.
- Kept chord details private to adjacent sidecars rather than WAV-embedded metadata, while publishing chord-free WAV caches plus beat-grid, transient, waveform-peak, and preferred slicer metadata.
- Preserved compatibility with legacy prompt/history fields, restored drafts and sent generations through the new active-row model, and retained the rolling 50-entry caps.
- Kept initial interaction light with parallel option loading, memoized dropdown templates, debounced text persistence, and windowed history rendering; improved labels, live status, keyboard behavior, focus handling, and responsive layout.
- Suite coverage now comprises 23 JavaScript tests, 14 Electron QA tests, and 87 backend tests.

## 2026-08-21 — Canonical loop assets, full sidecars, and slicer maps

- Replaced legacy track/timestamp filenames with lowercase canonical loop and one-shot names containing pack, descriptor, explicit BPM or `oneshot`, flat-normalized key, bars, and stable slot/take variation.
- Publish every new PCM16 WAV with an adjacent, same-stem `com.loopmaster.loop-meta` v1 JSON sidecar containing physical audio facts and SHA-256, musical grid/key/explicit chord timeline, all prompt sections, resolved seeds/model settings, provenance/license, 64 waveform peaks, and embedded-chunk claims.
- Added deterministic beat-grid and waveform-transient slicer catalogs plus a Roblox-ready `preferred` map capped at 15 internal boundaries for the current 16-pad deck.
- Embedded canonical ACID, labeled beat/transient cues, sampler loop regions, complete LIST/INFO provenance, and a compact chord-free `cKUP` cache before WAV audio data.
- Made WAV/sidecar publication and deletion pair-aware, added sidecars to loop-pack and kit ZIPs, aligned pack manifest field names, and cleaned stale slicer-registry entries.
- Preserved tonal one-shot keys while making the special drum-fill render explicitly keyless, and resolved/recorded reproducible per-item kit seed offsets.
- Added the machine-readable JSON Schema and a Roblox handoff specification covering filename grammar, every sidecar field, integrity/precedence rules, chord adaptation, slicer math, runtime mapping, validation, and legacy migration requirements.
- Routed the standalone eight-variant CLI through the same canonical PCM16 WAV, metadata-chunk, filename, seed, and adjacent-sidecar contract so it cannot create a second legacy format.
- Added regression coverage for canonical naming, flat key/chord normalization, strict sidecar invariants, PCM clipping/nonfinite audio, ACID/cKUP/cue/smpl output, increasing-intensity hit sheets, 16-pad boundary selection, tonal/drum one-shots, paired atomic publishing, kit metadata, and registry cleanup.

## 2026-08-21 — VAE stability and audit hardening

- Reduced repeated-generation GPU pressure by streaming decoded VAE chunks and variants into preallocated outputs instead of retaining lists and concatenating full batches.
- Moved completed waveforms to mutable float32 CPU tensors before loop, remix, and kit post-processing; kept seed-blend tensors dtype-safe for FP16 model runs.
- Replaced the process-global conditioning cache with model-instance, batch/device/dtype-aware CPU-backed LRU entries that cannot retain job-specific CUDA tensors or leak across models and LoRA changes.
- Standardized the medium model launchers on FP16 for 12 GB cards, corrected the desktop label, made startup warmup opt-in, and extended first-download startup tolerance from two to ten minutes.
- Added per-variant VAE progress checkpoints to the durable job ledger, including the last stage when an active job is recovered after a native process interruption.
- Fixed immediate custom-prompt submission, stale debounced section updates, page-exit persistence, malformed history recovery, and duplicate drafts created from already-submitted snapshots.
- Preserved `freePrompt` and `drums` in structured generation payloads and added server-side deterministic prompt recomposition validation plus ETag/304 coverage for prompt config.
- Enforced fan-out deadlines, retained ordered partial results with retries/backoff, corrected rate-limit `Retry-After` rounding and stale-client cleanup, and made kit generation continue after per-item failures.
- Documented the app's local inference routing: draft and bulk work cap at eight steps, while final work uses the requested step count; no paid/remote model-provider fan-out exists in this codebase.
- Added regression coverage for VAE/chunk memory lifetime, conditioning-cache isolation, launcher precision parity, inference tensor mutability, kit partial success, fan-out timeout/retry behavior, rate limiting, startup policy, prompt composition, and history eviction/sanitization.

## 2026-08-20 — Structured prompts and generation history

- Replaced the legacy single prompt/random controls with a config-driven music prompt builder covering genre, instrument, performance, mood, key, production, modifiers, and negative prompt.
- Added curated, random, skip, free-text, per-section reroll, and global randomization flows with persisted last-used selections.
- Centralized deterministic prompt assembly in `prompt_core.js` and added unit coverage for composition and history eviction.
- Added localStorage-backed draft and sent-generation history with pending/complete/failed states, result references, restore, resend, individual delete, clear-all, legacy-history migration, and a 50-entry cap per type.
- Debounced free-text overrides, memoized option specifications, windowed long history rendering, and versioned the external prompt option config for HTTP cache revalidation.
- Preserved the existing non-blocking generation queue, added structured-payload validation, negative-prompt forwarding, a per-client generation rate limit, and draft/final local-inference tiers.
- Added bounded parallel variant publishing with timeout propagation, exponential-backoff retries, and partial-result reporting instead of discarding successful variants.
- Updated the Electron QA harness for the structured builder and added fan-out retry/partial-result tests.

## 2026-08-20 — Randomizer option muting

- Added per-section mute controls that exclude the current curated option from section rerolls and Randomize All.
- Muted options remain visible and labeled in their dropdowns so they can be selected and unmuted later.
- Persisted muted-option lists alongside prompt selections, pruning removed or invalid config options on reload.
- Added safe all-muted behavior (the section falls back to skip) plus unit and Electron interaction coverage.

## 2026-08-20 — Free prompt, melodic instruments, and drums

- Added an always-visible free-prompt textarea whose text is composed with structured choices, persisted, captured in history, and preserved during randomization.
- Split drums and percussion into a dedicated dropdown with its own dice and removed drum choices from the melodic instrument pool.
- Expanded every curated prompt category, including 60 melodic instruments, 34 drum/percussion choices, 50 genres, and 36 performance styles.
- Pinned Key / Chord during Randomize All while retaining its per-section dice for intentional changes.
- Added client, config, backend-validation, and Electron interaction coverage for free text, separated pools, drum-free instrument rolls, and chord preservation.
