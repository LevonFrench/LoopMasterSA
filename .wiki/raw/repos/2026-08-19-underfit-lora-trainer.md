---
title: "dada-bots/underfit — SA3 LoRA/DoRA training dashboard"
source: https://github.com/dada-bots/underfit
type: repo
date_ingested: 2026-08-19
tags: [lora, dora, trainer, stable-audio-3]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "The community-standard (and officially recommended) LoRA trainer for Stable Audio 3."
---

# Underfit (dada-bots)

- Gradio dashboard for training/managing **LoRA / DoRA (recommended) / BoRA** and -XS fine-tunes for SA3-Medium, SA3-Small-Music, SA3-Small-SFX.
- Train on the **Base (50-step rectified-flow)** variant; resulting LoRAs also work with the **ARC (8-step)** variant at inference.
- Output: single .safetensors adapter; load via dashboard or run_gradio.py --lora-ckpt-path; multiple LoRAs blendable with strength controls.
- Hardware: NVIDIA (T4 16GB workable; H100/A100/4090 ideal) or Apple Silicon via MLX; ~17GB disk per model pack. A 12GB 3080 Ti is below the stated comfort line but likely workable (unverified).
- MIT tool license; base weights stay under the Stability Community License.
- Related social-lane lead (single-platform, unverified): github.com/esanchezharris/pmetal PR#1 — local SA3 LoRA/DoRA training on Apple Silicon (MLX).
