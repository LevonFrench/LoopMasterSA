---
title: "stabilityai/stable-audio-3-medium (HF model card + LICENSE)"
source: https://huggingface.co/stabilityai/stable-audio-3-medium
type: repo
date_ingested: 2026-08-19
tags: [stable-audio-3, model-card, license]
confidence: high
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "Canonical model card and license text for the exact model LoopMaster runs."
---

# stable-audio-3-medium model card

- Text-to-audio latent diffusion transformer; variable-length generation, editing/inpainting.
- Generation speed cited: under 2s on H200; a few seconds on MacBook Pro M4.
- Training data: ~1.28M licensed recordings (806,284 AudioSparx + 472,618 Freesound CC-0/CC-BY/CC-Sampling+), music-verified against copyrighted material.
- T5Gemma text conditioning is under separate **Gemma Terms of Use**.
- **License (LICENSE.md, exact anchors)**: free commercial use below **USD $1,000,000 annual revenue**; "You own any outputs generated from the Models or Derivative Works to the extent permitted by applicable law"; fine-tunes/LoRAs explicitly allowed; must not use materials "to create or improve any foundational generative AI model"; redistribution requires attribution "licensed under the Stability AI Community License".
- **Parameter count conflict**: HF collection lists Medium as "2B"; the GitHub repo table says **1.4B** (DiT) — MarkTechPost breaks it down as ~1.4B DiT + 852M SAME-L autoencoder, which reconciles the two numbers. Recorded as 1.4B DiT + 0.85B AE.
- Sample-library use: license does not name "sample libraries" — permitted-by-reading under the revenue cap, but that is an inference from the text, not an explicit clause.
