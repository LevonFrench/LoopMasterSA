---
title: "Stable Audio 3 LoRA Ecosystem"
type: reference
created: 2026-08-19
updated: 2026-08-19
confidence: high
volatility: hot
provenance: "compiled from wiki:research 2026-08-19 (stable-audio models/LoRAs sweep)"
---

# Stable Audio 3 LoRA Ecosystem (as of 2026-08)

## Native support (official)
The stable-audio-3 repo ships LoRA training (`uv sync --extra lora`): 8 adapter types (lora, **dora-rows** default, dora-cols, bora, + -xs SVD variants), 20-50+ audio/text pairs, **2-6.5 GB VRAM** (bf16 base halves it) — trainable on the project's 12GB 3080 Ti. Adapters are .safetensors with embedded lora_config; runtime strength/interval/layer-filter controls match LoopMaster's local `stable_audio_3/models/lora` module exactly.

## Trainers
- **Underfit (dada-bots)** — officially recommended Gradio dashboard for SA3 LoRA/DoRA/BoRA. Train on the Base (50-step) variant; adapters work on the ARC (8-step) variant. T4 16GB workable; 3080 Ti 12GB below the comfort line but likely workable (unverified). MIT.
- **LoRAW (NeuralNotW0rk)** — legacy trainer for old stable-audio-tools/SA-Open workflows only. Superseded.
- Social-lane lead (unverified): pmetal PR#1 — SA3 LoRA/DoRA on Apple Silicon via MLX.

## Pretrained community LoRAs
**None verified as of 2026-08-19.** HF search (~106 stable-audio results) is mostly official repos + format repacks (bf16/int8/tflite/mlx). No drum- or genre-specific SA3 LoRA with working files was found. The practical path to a drum-kit LoRA is training one with Underfit on curated one-shots.

## Known pitfalls (from SA-Open era, HF discussion #11)
- Full fine-tunes fail on <24GB RAM; LoRA is the consumer-hardware path.
- Silent weight-non-loading (wrong --pretrained_ckpt_path target) produces noise-only output.

See also: [[stable-audio-3-model-family|Model Family]] ([Model Family](stable-audio-3-model-family.md)), [[generation_pipeline|Generation Pipeline]] ([Generation Pipeline](../concepts/generation_pipeline.md)).

Sources: raw/repos/2026-08-19-stable-audio-3-lora-workflow.md, raw/repos/2026-08-19-underfit-lora-trainer.md, raw/repos/2026-08-19-loraw-legacy-trainer.md
