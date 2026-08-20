# Report: local stable-audio-3 fork vs upstream (2026-08-19)

Verdict: **DIVERGED** — behind on 3 core fixes + the optimized/ backends; ahead on Windows/perf hardening.

- Local baseline: upstream main@fa5ee84 (2026-05-21), vendored into this repo 2026-05-26 (747a50d).
- Upstream HEAD checked: a0b57f5 (2026-08-02). ~90% of the 127-commit gap is optimized/{tensorRT,tflite,mlx} (unused locally).
- Local-only (keep, do not rebase over): streamed checkpoint loader, seed-reproduction fix + per-variant streams, fp16 T5, per-step sync removal, use_checkpointing off at inference, dynamo suppress_errors removal, win32 CUDA index marker, diffusers/accelerate deps.
- Cherry-picked 2026-08-19: ad40e07 (LoRA-removal mutate-during-iterate fix) -> stable_audio_3/models/lora/model.py.
- Skipped: fee84bc cli.py sample_size (server path bypasses cli.py); 929f231 multi-region inpaint UI (gradio-only; revisit if LoopMaster wants multi-region inpaint).
- Recommendation: no full rebase. Re-check upstream quarterly; cherry-pick core fixes only.
