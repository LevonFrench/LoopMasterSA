---
title: "SA3 drum-LoRA training recipe (sourced synthesis)"
source: https://github.com/Stability-AI/stable-audio-3/blob/main/docs/workflows/lora.md
type: article
date_ingested: 2026-08-19
tags: [lora, training, recipe, drums]
confidence: high
provenance: "wiki:research 2026-08-19 round 2 (gap-closing, 5 parallel agents)"
summary: "Sourced recipe from official lora.md + Underfit README + fal.ai trainer; one-shot specifics remain UNKNOWN."
---

# Drum-LoRA training recipe (sourced)

## Established
- Adapter: `--adapter_type dora-rows --rank 16` (official default; Underfit independently recommends DoRA).
- VRAM: medium ~6.5GB, ~5.5GB with `--base_precision bf16` + lora-xs; small ~2-2.5GB. bf16 base = "negligible quality impact".
- Train on **Base (50-step)** checkpoints; Underfit: LoRAs "work perfectly with ARC (8-step)" at inference (Underfit's claim only; official doc silent).
- Captions: one `.txt` sidecar per clip, same basename, plain text = the prompt (Underfit "SA3 convention"; corroborated by fal.ai trainer). Base model reportedly trained on key-value strings like `Genre: techno, BPM: 140, Mood: dark`.
- Dataset: official floor 20-50 clips; Underfit frames it as 10+ min total (30+ recommended), one coherent style per dataset. Quality > quantity.
- Latent length is "the underrated knob" — lower to ~12s with random_crop to learn style without memorization.
- Steps **disagree across sources**: official example 1000; Underfit 10k-20k ("~10k sweet spot, >20k overfits"); fal.ai 500-2000. Validate locally, trust no single number.
- LR: no source gives a number; leave default.
- No 12GB-class fit/wall-clock reports exist anywhere (searched).

## UNKNOWN — needs local experiments
- Sub-second one-shot handling: padding? min clip length? internal latent padding behavior?
- Clip-count floor for one-shot datasets (existing guidance assumes music-length clips).
- Adapter choice for percussive/transient vs tonal content.

Additional source: https://github.com/dada-bots/underfit, https://fal.ai/models/fal-ai/stable-audio-3-trainer
