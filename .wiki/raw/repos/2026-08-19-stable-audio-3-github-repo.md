---
title: "Stability-AI/stable-audio-3 (GitHub repo README + perf table)"
source: https://github.com/Stability-AI/stable-audio-3
type: repo
date_ingested: 2026-08-19
tags: [stable-audio-3, vram, performance, tensorrt]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "Official successor repo to stable-audio-tools with concrete VRAM/latency numbers."
---

# Stability-AI/stable-audio-3 repo

- Successor inference/fine-tuning platform to stable-audio-tools (that repo remains only for foundational research / previous models).
- Variant table: Small-Music **433M** / Small-SFX **433M** (120s max, CPU-capable); Medium **1.4B** (380s max, GPU); Large **2.7B** (API-only).
- **Peak VRAM (H200)**: Small 1.69-2.40 GB; Medium **5.07-6.52 GB**; chunked decoding cuts medium/120s from 6.49 GB to ~5.14 GB.
- **Latency (H200)**: Small/5s 0.41s; Medium/5s 0.60s; Medium/380s 1.31s; **TensorRT** drops Medium/380s to 0.43s.
- SAME usable standalone: AutoencoderModel.from_pretrained("same-l").
- Install uv sync; extras --extra ui, --extra lora.
- Negative finding: **stable-audio-tools has no GitHub Releases at all** (rolling main branch only) — do not hunt for a changelog there.
- LoopMaster's local stable-audio-3/ directory is this stack (stable_audio_3 package, SAME, T5Gemma, rf_denoiser).
