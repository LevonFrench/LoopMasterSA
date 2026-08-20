---
title: "NeuralNotW0rk/LoRAW — legacy LoRA trainer for stable-audio-tools"
source: https://github.com/NeuralNotW0rk/LoRAW
type: repo
date_ingested: 2026-08-19
tags: [lora, stable-audio-tools, legacy]
confidence: medium
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "The pre-SA3 community LoRA path; relevant only for old stable-audio-open workflows."
---

# LoRAW (legacy)

- Community LoRA implementation for **stable-audio-tools** (pre-SA3). MIT.
- Config block (rank 16, alpha 16, lr 1e-4 typical), train.py --use-lora, optional --relora-every.
- Validated in the stable-audio-open-1.0 HF discussion #11 ("works very well"); one user merged a LoRA back into a full checkpoint.
- Same thread documents failure modes: 24GB RAM insufficient for full fine-tune; silent weight-non-loading when pointing --pretrained_ckpt_path at model.safetensors produced noise-only output.
- Superseded by SA3's native LoRA support for the current stack.
- Companion community full fine-tune example (SA-Open 1.0, not SA3): Nekochu/stable-audio-open-1.0-Music — full 1B F32 checkpoint, trained on a personal playlist (copyright provenance concern).
