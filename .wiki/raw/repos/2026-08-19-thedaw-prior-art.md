---
title: "gantasmo/theDAW (ex-StableDAW) — SA3 browser DAW prior art"
source: https://github.com/gantasmo/theDAW
type: repo
date_ingested: 2026-08-19
tags: [prior-art, daw, sa3, lora, community]
confidence: high
provenance: "wiki:research 2026-08-19 round 2 (gap-closing, 5 parallel agents)"
summary: "Active MIT browser DAW around SA3; verified via GitHub API; several borrowable patterns."
---

# theDAW (ex-StableDAW)

- StableDAW (created 2026-05-18) is **archived**; successor **gantasmo/theDAW** is active: 671 commits, 130 stars, last push 2026-08-06, MIT. Origin: Music Hackspace hackathon at Berklee.
- Stack: FastAPI backend (port 8600, async job queue, FFmpeg), plugin modules (backend/modules/<name>/module.json + router.py, failure-isolated loader), React 19 + Vite + Zustand frontend, SA3 (DiT + SAME) engine, local-only by default, lazy model load.
- Features: multitrack EDIT tab (cached waveform peaks, snap grid, trim/fade, inpaint-from-editor, OfflineAudioContext commit-render), MIX tab (25 FFmpeg effects, 4 macro knobs, VST3 via pedalboard, .gan web-plugin format), Underfit LoRA tab (8 adapter types, layer include/exclude, per-LoRA strength + **sigma-interval gating**, additive stacking), LEARN tab (lineage DAG of every remix/inpaint/blend).
- Distribution: Pinokio launcher package exists (external installs beyond GitHub).

## Borrowable for LoopMaster
1. Plugin-isolated backend modules (kit builder / slicer / FX as independent modules).
2. LoRA sigma-interval gating + additive stacking (local lora module already supports intervals).
3. Lineage/genealogy DAG for generated samples (which one-shot came from which prompt/seed) — strong fit for the sample-library goal.
(Already present in LoopMaster: OfflineAudioContext mixdown, macro knobs, init_noise_level control.)
