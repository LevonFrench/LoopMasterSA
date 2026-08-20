---
title: "SAME: A Semantically-Aligned Music Autoencoder (arXiv 2605.18613)"
source: https://arxiv.org/html/2605.18613v1
type: paper
date_ingested: 2026-08-19
tags: [same, autoencoder, vae, decode-speed]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "The autoencoder that replaced Oobleck — decode-speed concerns are superseded."
---

# SAME autoencoder paper

- Encoder-bottleneck-decoder with parameter-free patching (P=256) + Transformer Resampling Blocks: **4096x temporal compression** (vs 1024-2048x for prior codecs incl. Oobleck), latent dim 256.
- Two sizes: SAME-S (108M), SAME-L (852M).
- **Decode RTF on H100 fp16**: SAME-L 561, SAME-S 2069, vs Stable Audio Open (Oobleck-class) 284 — roughly **2x-7x faster** than the Oobleck-class baseline.
- Quality vs closest baseline: mixed but competitive — wins MELlog1p (0.057 vs 0.070) and MUSHRA (82.2 vs 77.6), marginal losses on SI-SDR and stereo CCPC.
- **Not a drop-in for Oobleck latents**: different architecture and latent space; requires the stable-audio-3 pipeline (LoopMaster already runs it).
- Supersedes the 2026-08-19 crossed-session VAE-decode research: with SAME + local fixes, decode measures 0.1-0.4s on the project's RTX 3080 Ti.
