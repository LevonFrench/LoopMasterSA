# Output Directory Index

This directory contains generated summary reports, roadmaps, and presentation slides.

## Catalog
- [[plan-loop-metadata-contract-2026-08-20|Plan: Loop File Metadata Contract]] ([Plan: Loop Metadata](plan-loop-metadata-contract-2026-08-20.md)) — owner-ordered spec for what any looper wants inside a loop WAV: canonical acid chunk layout (pins the LoopMaster-vs-classic offset divergence found 2026-08-20), cue slice maps, smpl loop region, LIST provenance incl. ICOP license line, optional cKUP peaks cache, ID3/bpmxxx dialect mapping (TBPM/TKEY) with a WAV-corruption compatibility flag, and the grid-law validation gate shared with THE COOKUP's ingest tools.
- [[plan-engine-selection-2026-06-23|Plan: Engine Selection and Alternative Models]] ([Plan: Engine Selection](plan-engine-selection-2026-06-23.md)) — roadmap for multi-engine backend routing (SA3 / MusicGen / AudioLDM 2).
- [[plan-stability-performance-2026-07-06|Plan: Stability & Performance Hardening]] ([Plan: Stability & Performance](plan-stability-performance-2026-07-06.md)) — 6-part AG execution scope from the 2026-07-06 full-codebase audit (backend P0 fixes, frontend leak teardown, offline-render fidelity, render-loop perf, inference perf, launcher hardening).
- [[plan-hardening-repair-verification-2026-07-06|Plan: Hardening Repair & Verification Completion]] ([Plan: Repair & Verification](plan-hardening-repair-verification-2026-07-06.md)) — follow-up scope for AG: artifact sweep of the executed diff, full runtime verification of all 6 parts' DoD checklists, then commit. Documents the 3 execution defects already repaired (app.js 16× block duplication, escaped-quote artifact, T5 cache tuple crash).

## Category Mappings
- **Planning Roadmaps**: plan-engine-selection-2026-06-23, plan-stability-performance-2026-07-06, plan-hardening-repair-verification-2026-07-06

## Recent Changes
- **2026-07-06**: Added hardening repair & verification completion scope (post-execution).
- **2026-07-06**: Added stability & performance hardening scope (multipart plan for AG).
- **2026-06-23**: Added engine selection plan.
- **2026-06-21**: Directory initialized.
