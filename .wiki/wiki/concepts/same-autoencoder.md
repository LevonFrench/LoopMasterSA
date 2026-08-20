---
title: "SAME Autoencoder"
type: concept
created: 2026-08-19
updated: 2026-08-19
confidence: high
volatility: warm
provenance: "compiled from wiki:research 2026-08-19 (stable-audio models/LoRAs sweep)"
---

# SAME Autoencoder (Semantically-Aligned Music autoEncoder)

Stability's successor to the Oobleck VAE, shipped with Stable Audio 3 (arXiv 2605.18613). This is the autoencoder LoopMaster's stack already runs.

## Why VAE-decode-speed research is superseded
- **4096x temporal compression** (vs 1024-2048x Oobleck-class), latent dim 256; SAME-S 108M / SAME-L 852M.
- Decode RTF (H100 fp16): SAME-L 561, SAME-S 2069 vs Oobleck-class SAO 284 — **2x-7x faster**.
- Chunked decoding cuts medium/120s VRAM 6.49 -> ~5.14 GB.
- Measured locally (2026-08-19, RTX 3080 Ti fp16): decode of four 10s variants takes **0.1-0.4s** after the flex_attention fix. Decode is not a bottleneck.
- Quality vs closest baseline: mixed but competitive (wins MUSHRA 82.2 vs 77.6).
- **Not drop-in compatible** with Oobleck latents — different architecture and latent space; irrelevant locally since the whole stack is already SAME-based.

Historical note: the 2026-08-19 crossed-session research into Oobleck decode tuning (chunk_size/overlap, fp16 risk) targeted the previous generation; keep only its Flask-streaming/progressive-delivery findings ([research doc](../../../output/research-progressive-emit-vae-2026-08-19.md)).

See also: [[stable-audio-3-model-family|Model Family]] ([Model Family](../references/stable-audio-3-model-family.md)), [[generation_pipeline|Generation Pipeline]] ([Generation Pipeline](generation_pipeline.md)).

Sources: raw/papers/2026-08-19-same-autoencoder-paper.md, raw/repos/2026-08-19-stable-audio-3-github-repo.md
