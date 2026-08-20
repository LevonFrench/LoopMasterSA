---
title: "stabilityai/stable-audio-3-optimized + TensorRT route"
source: https://huggingface.co/stabilityai/stable-audio-3-optimized
type: repo
date_ingested: 2026-08-19
tags: [tensorrt, optimization, onnx, hardware]
confidence: high
provenance: "wiki:research 2026-08-19 round 2 (gap-closing, 5 parallel agents)"
summary: "Verified: experimental multi-framework export bundle; prebuilt TensorRT engines only for SM90/SM120."
---

# stable-audio-3-optimized (verified)

- Repo exists: experimental checkpoints for hardware acceleration; trees: onnx/ (fp16/fp8), tensorRT/, tflite/, cpu-amx/, MLX/. ~10.4k downloads.
- **Prebuilt TensorRT engines: SM 90 (H100/H200) and SM 120 (Blackwell/RTX 50) ONLY.** No SM 86 (RTX 30) or SM 89 (RTX 40).
- TensorRT route is tagged **Linux + NVIDIA** in the repo route table; setup via bootstrap.sh; ~5GB engines; unsupported GPUs fall back to a ~30-min ONNX->TensorRT build (success on Ampere unverified).
- H100 benchmarks: medium 45-150ms at 14GB VRAM; small 25-50ms at 8GB. No consumer-GPU benchmarks anywhere.
- fp8: ~1.3x faster on medium but **not seed-reproducible** vs fp16, seq cap 4096. sm_120 needed an AOT-engine bugfix (2026-07-31) for silent constant-output corruption — path is young.
- **Verdict for the local 3080 Ti/Windows: not worth adopting now** (no engines, Linux-only, no data, local already 2-4s). Perfect fit for rented H100/H200 (e.g. Verda ~$2.29/hr) for bulk library builds and LoRA training.
