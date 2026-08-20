---
title: "Stable Audio 3 technical report (arXiv 2605.17991)"
source: https://arxiv.org/abs/2605.17991
type: paper
date_ingested: 2026-08-19
tags: [stable-audio-3, architecture, paper]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "Primary technical report: three sizes, SAME autoencoder, adversarial post-training."
---

# Stable Audio 3 paper

- Three architecture sizes (small/medium/large); novel semantic-acoustic autoencoder; **adversarial post-training to reduce inference steps** (why 8-step generation works — the local rf_denoiser/pingpong path).
- Only small and medium weights released publicly ("can run on consumer-grade hardware"); large is not open-weight.
- Parameter/VRAM tables live in the full PDF (not fetched); the repo README carries the practical numbers.
