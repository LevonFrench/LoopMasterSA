---
title: "Alternative local text-to-audio models for one-shots (AudioLDM 2, TANGO, AudioGen)"
source: https://huggingface.co/docs/diffusers/main/en/api/pipelines/audioldm2
type: article
date_ingested: 2026-08-19
tags: [alternatives, audioldm2, tango, audiogen, one-shot]
confidence: medium
provenance: "wiki:research 2026-08-19, stable-audio models/LoRAs sweep (5 web agents + social lane)"
summary: "Survey of non-Stability local models for SFX/one-shot generation, with licensing and VRAM blockers."
---

# Alternative local models (survey)

**AudioLDM 2** (https://huggingface.co/docs/diffusers/main/en/api/pipelines/audioldm2) — mature general text-to-audio via diffusers; audioldm2 1.1B / audioldm2-large 1.5B; fits 12GB fp16; BUT checkpoints are **cc-by-nc-sa-4.0 — non-commercial only**: blocker for sellable sample packs. 200-step default, 10.24s default length — not one-shot-tuned.

**TANGO / TANGO 2** (https://github.com/declare-lab/tango) — 866M, Flan-T5 + UNet; DPO-aligned Tango 2; open weights; beats AudioLDM-L on FAD (1.59 vs 1.96) in first-party tables (dueling first-party benchmarks with AudioLDM2 — no independent arbiter). VRAM UNKNOWN, likely fits 12GB.

**AudioGen (Meta)** (https://github.com/facebookresearch/audiocraft/blob/main/docs/AUDIOGEN.md) — autoregressive SFX model, only checkpoint audiogen-medium 1.5B, documented **16GB VRAM minimum — does NOT fit the 12GB 3080 Ti**. Negative finding: do not re-suggest.

**Not found**: any verified open checkpoint fine-tuned specifically on drum one-shots (as of Aug 2026). Hosted commercial products (Soundcraft Maestro, Loudly, Sonura) advertise AI sample packs with no open weights — skipped as unverifiable. ElevenLabs SFX is API-only — not researched (UNKNOWN).
