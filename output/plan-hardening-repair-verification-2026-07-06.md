---
title: "Plan: Hardening Execution Repair & Verification Completion (for AG)"
type: plan
format: roadmap
sources: [output/plan-stability-performance-2026-07-06.md, loopmaster/loopmaster-app/static/app.js, stable-audio-3/stable_audio_3/model.py]
generated: 2026-07-06
project: sa3
confidence: high
volatility: hot
---

# Plan: Hardening Execution — Repair & Verification Completion

**Target agent:** Antigravity (AG)
**Project root:** the SA3 workspace root.
**Predecessor:** `output/plan-stability-performance-2026-07-06.md` (the 6-part hardening scope). AG executed all 6 parts, but the delivery shipped broken: the app loaded and did nothing. This plan finishes the job.

## What Went Wrong (context — read before starting)

Three defects were introduced during execution and have **already been repaired** (see below). Two were tool/apply artifacts, one was a logic bug:

1. **`app.js` was unparseable.** A ~108-line block (the `macroHoverTargets`/`mixerMacroHoverTargets` hover-mapping section) was inserted **16 times** (duplicate `const` → top-level `SyntaxError`). A parse error means zero listeners bind — the exact "interface loads, does nothing" symptom.
2. **`app.js:~7562`** contained literal escaped quotes (`querySelectorAll(\'.lfo-dot\')`) — a second parse error hiding behind the first.
3. **`model.py` T5 conditioning cache crashed every generation.** The conditioner returns dict values that are `(embedding, mask)` **tuples**, not tensors; the cache called `.detach()` directly on them. Warmup printed `Warmup failed (non-fatal): 'tuple' object has no attribute 'detach'` — but the same path runs on every real prompt, so all generation was broken.

**Root-cause discipline for this plan:** the duplication pattern means at least one apply/edit operation repeated an insertion without noticing. Therefore: make **small, single-anchor edits**, and run `node --check static/app.js` (or `python -m py_compile <file>`) **after every single edit** to a source file — not once at the end. Never re-apply an edit that reports failure without first re-reading the target region.

## Already Fixed — DO NOT REDO (verify only)

- `app.js`: 15 duplicate copies removed (previously lines 2171–3790). File is now 9,971 lines, exactly one `macroHoverTargets`, `node --check` clean.
- `app.js` ~7562: escaped quotes normalized.
- `model.py` (~296–306): `_detach_value()` helper added inside the cache-store branch — detaches tensors inside tuples/lists as well as bare tensors.
- Verified so far: `py_compile` clean on `app_server.py`, `model.py`, `sampling.py`, `dit.py`; server boots with `--model medium`, `GET /` → 200, served `app.js` byte-identical to the fixed file and parses. The verification server instance was stopped; port 7861 is free.
- **Nothing is committed yet.** The entire hardening effort is uncommitted working-tree state.

---

## Part A — Artifact Sweep of the Executed Diff

**Goal (observable):** proof that no other duplicated-block or escape-sequence artifacts exist in any file touched by the hardening execution.

Touched files (from `git status`): `app_server.py`, `static/app.js`, `static/app.css`, `static/index.html`, `sampling.py`, `model.py`, `dit.py`, plus docs.

1. For each source file, review `git diff -- <file>` top to bottom. You are looking for *your own* apply artifacts, not new features: repeated blocks, `\'` / `\"` literals, truncated statements, orphaned braces.
2. Run the duplication heuristic on each source file — any non-trivial line repeated ≥6 times that is not template markup is suspect:
   `grep -v "^\s*$" <file> | sort | uniq -c | sort -rn | head -20`
3. Escape-artifact scan: `grep -Fn "\\'" <file>` and `grep -Fn '\\"' <file>` on each touched file (already clean for `app.js`, `index.html`, `main.js` — sweep the rest).
4. Confirm `dit.py`'s CFG-gate change is semantically intact: the hoisted sigma scalar must be computed **once per forward** and used in both the LoRA gate (~466) and CFG gate (~479); confirm no tensor-vs-float comparison remains.
5. Confirm `sampling.py`'s NaN guard runs once per generation (not per chunk) and the gated `empty_cache` uses `torch.cuda.mem_get_info()`.

**DoD:** every touched file passes `node --check` / `py_compile`; diff review notes written into `walkthrough.md` (one line per file: "clean" or what was fixed).

## Part B — Execute the Original Verification Checklists (none were actually run)

**Goal (observable):** every per-part Definition of Done from `plan-stability-performance-2026-07-06.md` demonstrably passes. `task.md` currently marks all parts complete — that was premature; treat every DoD as unverified.

Ordered checklist (server: `run_server.bat`, choice 1 / medium):

1. **Boot:** server starts; the console must NOT print `Warmup failed` (the tuple fix should make warmup succeed — if it still fails, diagnose before proceeding; do not dismiss it as non-fatal).
2. **Part 1 checks:** generate 4 variants end-to-end (exercises CFG hoist, NaN guard, seeded Generator, cache store). Then: continuation remix with an Init Audio seed — console shows the `[Seed Audio]` print and output audibly continues the seed (this validates the `gen_duration` fix — confirm the variable is actually defined now). Outpaint 2x. `/api/convert` returns JSON error (not a hang) when ffmpeg is unavailable.
3. **Conditioning cache (Part 5.4):** immediately regenerate with the identical prompt — console logs `[Generation] Cache hit for text conditioning` and the job completes. Same seed twice → identical output files (Part 5.3).
4. **Part 2 checks (browser DevTools):** create 10 tracks, delete all, create 3 more (forces undo eviction) → `getEventListeners(document).mousemove.length` returns near baseline; load a project twice → idle CPU comparable to fresh session; delete a track mid-regeneration → no console errors; undo-restore works and restored knobs still drag.
5. **Part 3 checks:** FX Copy → Paste with distinctive HP/LP/drive values, zero console errors; save → reload → load project preserves those values; Render Mix A/B against live sound with extreme tremolo/gate/drive/wow settings.
6. **Part 4 checks:** 10 s Performance profile during 8-track playback — no per-frame Layout inside the tick/rAF lanes, no canvas reallocation. Record before/after scripting-time numbers.
7. **Part 6 checks:** kill the venv python mid-boot → desktop launcher shows an error, not an eternal spinner; second launch focuses the first window.
8. **VRAM soak:** 10 consecutive generations watching `nvidia-smi` — stable baseline, no staircase.

**DoD:** each item above explicitly marked pass/fail in `task.md` (fail = fix, then re-run). Timing/VRAM numbers recorded in `HANDOFF.md`.

## Part C — Commit

Only after Parts A and B are fully green:
1. Review `.gitignore`; confirm no generated audio, venvs, or AI workspace files are staged (`HANDOFF.md`, `task.md`, `walkthrough.md`, `implementation*.md` are gitignored per repo policy — keep it that way).
2. Commit in logical chunks (backend / frontend / inference / launcher / docs), no absolute local paths in any committed content.

**DoD:** `git status` clean apart from intentionally untracked files; each commit message names the plan part it implements.

## Constraints (unchanged from predecessor plan)

- **No pytest.** Syntax checks + manual browser/server verification only.
- Never delete anything under `outputs/`.
- `stable-audio-3/optimized/` (MLX port) stays untouched.
- Syntax-check after **every** edit, per the root-cause discipline above.
