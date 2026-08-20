---
title: "Stable Audio 3 Model Family"
type: reference
created: 2026-08-19
updated: 2026-08-19
confidence: high
volatility: warm
provenance: "compiled from wiki:research 2026-08-19 (stable-audio models/LoRAs sweep)"
---

# Stable Audio 3 Model Family

Released **2026-05-20** by Stability AI. LoopMaster's local `stable-audio-3/` stack IS this release (stable_audio_3 package, SAME autoencoder, T5Gemma conditioning, 8-step rf_denoiser sampling).

## Variants

| Variant | DiT params | Max length | Runs on | Peak VRAM (H200) | Open weights |
|---|---|---|---|---|---|
| Small SFX | 433M | 120s | CPU-capable | 1.7-2.4 GB | yes |
| Small (music) | 433M | 120s | CPU-capable | 1.7-2.4 GB | yes |
| Medium | 1.4B (+852M SAME-L AE) | 380s | GPU | 5.1-6.5 GB | yes |
| Large | 2.7B | 380s | API/enterprise only | n/a | **no** |

- The "Medium = 2B" figure on the HF collection is DiT (1.4B) + SAME-L AE (0.85B) combined.
- Latency (H200): Medium/5s 0.60s; Medium/380s 1.31s; with **TensorRT** 0.43s.
- Adversarial post-training enables the 8-step sampling LoopMaster uses.
- On the project's 12GB RTX 3080 Ti: Medium fp16 fits comfortably; measured locally 2026-08-19: full 4-variant loop generation ~2-4s, VAE decode 0.1-0.4s.

## Licensing (load-bearing for the sample library)
- **Stability AI Community License**: free commercial use under **USD $1M annual revenue**; "You own any outputs"; LoRAs/fine-tunes allowed; cannot use outputs to train foundation models; redistribution needs attribution. T5Gemma component under separate Gemma Terms.
- Sample-library distribution is permitted-by-reading under the cap, but not named explicitly in the license.

## For drum one-shots
**stable-audio-3-small-sfx** is the standout A/B candidate for the Kit Builder: SFX-specialized sibling, CPU-capable, FAD 0.395 vs Medium's 0.369, already a `--model small-sfx` choice in `app_server.py`.

See also: [[stable-audio-3-lora-ecosystem|Stable Audio 3 LoRA Ecosystem]] ([Stable Audio 3 LoRA Ecosystem](stable-audio-3-lora-ecosystem.md)), [[same-autoencoder|SAME Autoencoder]] ([SAME Autoencoder](../concepts/same-autoencoder.md)), [[stable-audio-ecosystem-2026|Stable Audio Ecosystem 2026]] ([Stable Audio Ecosystem 2026](../topics/stable-audio-ecosystem-2026.md)), [[generation_pipeline|Generation Pipeline]] ([Generation Pipeline](../concepts/generation_pipeline.md)).

Sources: raw/articles/2026-08-19-stable-audio-3-announcement.md, raw/repos/2026-08-19-stable-audio-3-github-repo.md, raw/repos/2026-08-19-stable-audio-3-medium-model-card.md, raw/papers/2026-08-19-stable-audio-3-paper.md, raw/repos/2026-08-19-stable-audio-3-small-sfx.md
