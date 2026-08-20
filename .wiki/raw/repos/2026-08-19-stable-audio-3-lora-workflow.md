---
title: "Stable Audio 3 official LoRA workflow (docs/workflows/lora.md)"
source: https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/lora.md
type: repo
date_ingested: 2026-08-19
tags: [lora, dora, fine-tuning, stable-audio-3]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "Authoritative spec for the LoRA format LoopMaster's load_and_apply_loras already implements."
---

# SA3 native LoRA workflow

- Install: uv sync --extra lora. Train with --rank, --adapter_type (default **dora-rows**), --steps, --data_dir.
- Needs 20-50+ audio/text clip pairs; **2-6.5 GB VRAM** depending on settings; --base_precision bf16 halves frozen-weight VRAM. Fits a 12GB 3080 Ti.
- 8 adapter types: lora, dora-rows, dora-cols, bora, plus -xs SVD-core variants (smaller files; --svd_bases_path speeds startup).
- Inference: run_gradio.py --lora-ckpt-path style.safetensors; multiple LoRAs; runtime DiT strength 0-10, conditioner strength, noise-level interval, per-layer filtering via set_lora_strength() — all matching LoopMaster's local lora module.
- Format: .safetensors with embedded lora_config metadata, loaded strict=False. Weight merging and ReLoRA-style resume (--lora_checkpoint) supported.
- Officially recommends **Underfit** (dada-bots) as the external training dashboard. No official pretrained community LoRA list exists.
