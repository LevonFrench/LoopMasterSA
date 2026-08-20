---
title: "stabilityai/stable-audio-3-small-sfx — SFX/one-shot sibling model"
source: https://huggingface.co/stabilityai/stable-audio-3-small-sfx
type: repo
date_ingested: 2026-08-19
tags: [stable-audio-3, sfx, one-shot, drums]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "SFX-specialized sibling model — the standout candidate for drum one-shot generation."
---

# stable-audio-3-small-sfx

- Purpose-built **SFX-only** checkpoint in the same SA3 family — ~0.6B total (459M DiT + 108M SAME-S per MarkTechPost breakdown).
- 5s SFX clip in ~0.41s on H200 via 8-step ping-pong; runs on consumer hardware incl. **CPU-only**; trivial to A/B in LoopMaster (`--model small-sfx` already in the server's choices).
- Quality tradeoff: FAD 0.395 (small-sfx) vs 0.369 (medium) per MarkTechPost — medium slightly better, small-sfx much lighter.
- Same licensed corpus (AudioSparx + Freesound CC), same Community License.
- Secondary source: https://www.marktechpost.com/2026/05/26/stability-ai-releases-stable-audio-3-a-family-of-fast-latent-diffusion-models-for-audio-generation-and-editing/ (family table, FAD numbers).
- **Best candidate to A/B against Medium for drum one-shots** — SFX-tuned distribution may produce cleaner isolated hits.
