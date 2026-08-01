---
title: "Plan: Stability & Performance Hardening (Multipart Scope for AG)"
type: plan
format: roadmap
sources: [loopmaster/loopmaster-app/app_server.py, loopmaster/loopmaster-app/static/app.js, stable-audio-3/stable_audio_3/model.py, stable-audio-3/stable_audio_3/inference/sampling.py, loopmaster-desktop/main.js]
generated: 2026-07-06
project: sa3
confidence: high
volatility: hot
---

# Plan: Stability & Performance Hardening — Multipart Scope

**Target agent:** Antigravity (AG)
**Project root:** the SA3 workspace root (the folder containing `loopmaster/`, `stable-audio-3/`, `loopmaster-desktop/`).
**Derived from:** full-codebase audit (2026-07-06) of the Flask backend, the 9,822-line `app.js` frontend, the stable-audio-3 CUDA inference stack, and the Electron desktop wrapper. Every finding below was verified against source with file/line references. Line numbers are accurate as of 2026-07-06 — re-locate by symbol name if the file has shifted.

---

## 0. Architecture Context (read first)

One Flask process (`loopmaster/loopmaster-app/app_server.py`, `threaded=True`, port 7861) loads a single `StableAudioModel` global at startup. `POST /api/generate` / `/api/regenerate` spawn a daemon thread per request running `_execute_model_task`; the browser polls `GET /api/status/<job_id>`. Inference is serialized behind `model_lock`; job-state mutations behind `jobs_lock`. The frontend (`static/app.js`) is a vanilla-JS Web Audio DAW: per-track FX graph (HP/LP filter+drive, 6-band EQ, distortion, tape delay with wow LFO, spring convolver, native chorus/phaser/crusher, tremolo, tempo gate), 4 global LFOs + 2 ADSRs feeding an 8-slot mod matrix applied by a 25 ms Web-Worker tick via `setTargetAtTime`, plus an `OfflineAudioContext` mixdown that re-builds the graph by hand. The inference stack runs **eager** (torch.compile is guarded off on Windows in `model.py:69`); CFG runs as a batch-2 concat inside the DiT; the VAE decodes fp16, chunked, sequentially per variant (the logged 30–40 s stage).

## Global Constraints (apply to every part)

1. **Do NOT run pytest.** Verify via `python -m py_compile <file>`, `node --check static/app.js`, and manual browser testing only (AGENTS.md constraint).
2. **Never delete anything under `outputs/`** — user deletes manually.
3. **Surgical changes only.** Match existing style. No new frameworks, no build steps, no file splits unless a part explicitly says so.
4. **One part = one commit** (or a small commit series within the part). Do not start a part until the previous part's Definition of Done passes.
5. `stable-audio-3/optimized/` is an Apple-Silicon MLX port — **out of scope**, never touch it.
6. Do not commit absolute local paths. Update `task.md` as you complete each part; write session state to `HANDOFF.md` at wrap-up.
7. After each part, start the server (`run_server.bat`, choice 1/medium) and confirm: app loads at `http://127.0.0.1:7861/`, a 4-variant generation completes, playback works, zero new console errors (F12).

---

## Part 1 — Backend Stability Hotfixes (P0/P1)

**File:** `loopmaster/loopmaster-app/app_server.py`
**Goal (observable):** continuation/inpaint/response remix modes actually use the seed audio; `/api/convert` can no longer hang the server; repeated generations do not grow VRAM; malformed requests cannot OOM the GPU.

### 1.1 Fix the `gen_duration` NameError (silently kills all seed-audio remix modes)
`gen_duration` is referenced at lines 185, 190, 241 but never assigned. Any generate with `init_audio_path` + `remix_mode` in `{inpaint, response, continuation}` raises `NameError` at line 185, which the broad `except Exception as load_err` (~line 197) swallows — `seed_audio` stays `None` and the model generates unconditioned output. The user gets a wrong result with no error.
- Define `gen_duration` before first use as the padded generation length: `gen_duration = duration + pad_sec` (where `pad_sec = 2.0 if loop else 0.0`, matching line ~202). Cross-check line 241's `max(duration, gen_duration) + 10.0` still makes sense with that definition.
- In the `except Exception as load_err` handler, change the silent pass to also write the error into `jobs[job_id]["progress"]` and `print()` it — seed-audio load failures must be visible.
- **Verify:** generate a track, select it as Init Audio, run Continuation mode. Server console must show the `[Seed Audio] Padded seed audio ...` print, and the output must audibly continue the seed (not be unrelated audio). Repeat for Inpaint and Response.

### 1.2 Make `/api/convert` hang-proof and leak-proof
Both `subprocess.run(["ffmpeg", ...], check=True)` calls (lines 698, 738) have no timeout, and the upload-path temp file is saved (line ~719) *before* the `@after_this_request` cleanup is registered (line ~740), so an ffmpeg failure leaks the temp file into the web-served `outputs/` dir.
- Add `timeout=120` to both calls; wrap in `try/except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError)` returning `jsonify({"error": ...}), 500` with a human-readable message (including "ffmpeg not found on PATH" for `FileNotFoundError`).
- Register the temp-file cleanup (or a `try/finally` unlink) *before* invoking ffmpeg in both branches.
- Add `app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024` near app creation.
- **Verify:** rename ffmpeg off PATH temporarily → convert request returns a JSON error, server stays responsive, no stray files left in `outputs/`. Restore ffmpeg, confirm MP3 + OGG conversion still works from the export modal.

### 1.3 Free GPU tensors after every generation
`init_waveform` (line ~194), `seed_audio`, the `audio = audio.clone()` at line ~247, and resampled crossfade copies (~284–287) are never freed; `empty_cache()` is never called on the app path. Long sessions fragment the 12 GB card until OOM, and after a caught OOM (line ~418) the references keep VRAM pinned so the *next* job OOMs too.
- Wrap the generation body so a `finally` does `del` on `audio`, `seed_audio`, `init_waveform` (guarded with `if ... is not None` / `locals()` checks) — then call `torch.cuda.empty_cache()` **only in the OOM/except recovery path**, not per-generation (hot-path `empty_cache` forces device syncs; see Part 5 rationale).
- Remove the unnecessary `audio = audio.clone()` at line ~247 if the subsequent ops don't mutate the model-owned tensor in place (confirm: the tail-fold/truncate that follows operates on slices — if any op is in-place on `audio`, keep the clone).
- **Verify:** run 10 consecutive 4-variant generations while watching `nvidia-smi` — VRAM after each generation returns to a stable baseline (±200 MB), no upward staircase.

### 1.4 Clamp request parameters that can OOM the GPU
`num_variants` clamps to 32 (line ~492) and `duration` is unclamped (line ~498); `batch_size=num_to_generate` goes straight to the model, and CFG doubles that batch inside the DiT.
- Clamp `num_variants` to `[1, 8]` and `duration` to `[1.0, 60.0]` server-side (12 GB budget; the UI never asks for more).
- **Verify:** POST `/api/generate` with `num_variants: 32, duration: 300` via curl — job runs with clamped values, no OOM.

### 1.5 Close the `track_num` allocation race
`track_num` is computed under `jobs_lock` (~509–514) but the job is inserted in a *separate* lock block (~517); two overlapping requests can allocate the same track dir.
- Merge computation + `jobs[job_id] = {...}` insertion into a single `with jobs_lock:` block.

### 1.6 Consistent path sanitization for `init_audio_path`
Lines ~173–174 normalize and strip `..` but don't reject absolute paths, unlike `/api/delete_variant` and `/api/convert` (~623, ~681). On Windows, `os.path.join(OUTPUT_DIR, "C:\\...")` discards `OUTPUT_DIR`.
- Add the same `os.path.isabs(...)` rejection used by the other endpoints.

### 1.7 Prune the `jobs` dict
`jobs` (line 70) grows forever. After marking a job `done`/`error`, evict the oldest completed entries beyond the most recent 50.

**Definition of Done — Part 1:** `python -m py_compile loopmaster/loopmaster-app/app_server.py` clean; all four verify steps above pass; standard generation, regeneration, outpaint 2x, delete-variant, and MP3 export still work end-to-end in the browser.

---

## Part 2 — Frontend Audio-Graph Lifecycle Teardown (P0 leaks)

**File:** `loopmaster/loopmaster-app/static/app.js`
**Goal (observable):** deleting tracks, evicting undo entries, and loading a project fully release audio nodes, oscillators, buffers, and document-level listeners; a long session no longer accumulates CPU load or memory.

Current facts (verified):
- `initKnob` (line ~2039/2056), pan knobs (~3825/3832), and macro knobs (~3969/3984) each bind `document`-level `mousemove`/`mouseup` listeners **per knob** — `createTrackRow` wires ~50 knobs, so **~110 document listeners per track**, never removed. Each closure pins the track's whole node graph.
- Only buffer sources are ever `.stop()`-ed (single call site, line ~934). The per-track FX oscillators (tremolo LFO, gate LFO, chorus/phaser internal LFOs, aelapse wow LFO, `gateDcSource`) run forever.
- `deleteTrackRow` (~815–845) only zeroes/disconnects `gainNode`; undo eviction (~757–769) disconnects a few more nodes but no oscillators; `loadProject` (~5930–5934) does `tracksContainer.innerHTML=''` and drops the array with **no teardown at all** — every prior project's graph stays connected to `destination`.
- The native chorus/phaser wrappers' `disconnect()` (~272, ~324) omit their internal `lfo`.

### 2.1 Track-scoped listener teardown via `AbortController`
- In `createTrackRow`, create `track._abort = new AbortController()`. Pass `{ signal: track._abort.signal }` as the third argument to **every** `document.addEventListener` bound for this track's knobs (initKnob call sites for this row, pan knob ~3825, macro knobs ~3969). `initKnob` needs an optional `signal` param in its options; thread it through.
- Do NOT touch the transport-level `makeDraggableInput` listener at line ~582 — that is bound once globally and is correct.

### 2.2 Node registry + `destroyTrackAudio(track)`
- While building the graph in `createTrackRow` (~2140–2495), push every created node into `track._allNodes` and every `OscillatorNode`/`ConstantSourceNode` into `track._oscillators` (include the chorus/phaser wrapper internals — extend `createNativeChorus`/`createNativePhaser`/`createNativeBitcrusher` (~216–360) so their returned object exposes its internal LFO/nodes, and fix their `disconnect()` to include the LFO).
- Implement `destroyTrackAudio(track)`: stop any playing buffer source; `for (o of track._oscillators) try { o.stop(); } catch {}`; disconnect every node in `track._allNodes`; `track._abort.abort()`; null every `variant.buffer` and `track` node references.
- **Undo interaction (important):** `deleteTrackRow` pushes the row to `undoStack` (cap 3) for restore, and stopped oscillators cannot restart. Therefore: keep the current soft-mute on delete, and call `destroyTrackAudio` at the two points where a track becomes unrecoverable — **undo-stack eviction** (~757) and **`performUndo` replacing/abandoning entries**, plus **`loadProject`** (call it for every existing track before clearing, ~5930) and any "clear all" path. This bounds live-but-deleted graphs to ≤3 (the undo cap) instead of unbounded.

### 2.3 Guard async completions against dead tracks
`regenBtn` handler (~3693), `runOutpaint`, and `remakeMissingAudio` (~6287) await `pollJob` for up to minutes, then mutate the captured `track`/`variant` without checking it still exists.
- After every `await pollJob(...)` / fetch resolution that targets a track, bail out early with `if (!tracks.includes(track)) return;`. In `loadVariantAudio`, null the old `variant.buffer` before assigning the new one.

**Definition of Done — Part 2:** `node --check static/app.js` clean. In the browser: (a) create 10 tracks, delete all 10, run `getEventListeners(document).mousemove.length` in DevTools console before and after — count returns to within ~10 of the fresh-page baseline once the undo stack is evicted (create 3 more tracks to force eviction); (b) load a saved project twice in a row, then check `chrome://` Task Manager / Performance monitor — CPU at idle comparable to a fresh session (previously each load added permanent oscillator load); (c) delete a track mid-regeneration — no console errors when the job completes; (d) undo (restore deleted track) still works, knobs on the restored track still drag.

---

## Part 3 — Offline Render Fidelity & FX Copy/Reset Repair (P1 correctness)

**File:** `loopmaster/loopmaster-app/static/app.js`
**Goal (observable):** the rendered WAV mixdown sounds like live playback; FX Copy/Paste/Reset work without exceptions; HP/LP/drive settings survive save/load.

Verified defects:
- `runRenderMix` (~7996–8625) rebuilds the FX chain by hand and has drifted: it models Filtr as a single biquad from **legacy** params `t.filtrType/filtrCutoff/filtrResonance` (~8064–8085, 8480) while the live graph (~2229–2258) uses an HP+LP split plus a drive waveshaper. **Tremolo, tempo gate, delay wow LFO, reverb pre-delay, and reverb damp filter are absent** from the offline path entirely (live: ~2394–2489).
- FX-drawer Copy (~5161–5189) and Reset (~5439, 5477) query stale selectors (`.filtr-type`, `.filtr-cutoff`, `.filtr-reso`, `.chorus-rate-sync`, `.phaser-rate-sync`) that no longer exist in the drawer markup (now `.filtr-lp-cutoff`, `.filtr-hp-cutoff`, `.filtr-drive`, `.chorus-rate-sync-knob`, …) → `null.value` TypeError aborts the copy. `saveProject` (~5844–5846) uses `?.` on the same dead selectors, so it silently persists defaults — **HP/LP/drive settings are lost on every save/load**.

### 3.1 Fix the stale selector set
- Build one authoritative list of current FX-drawer selectors by reading the drawer innerHTML template (~2655–3263). Update Copy (~5161–5189), Reset (~5439/5477), `saveProject` (~5844), and `loadProject`'s restore branch (~6043–6236) to that list. Delete dead legacy branches rather than keeping both.
- **Verify:** set distinctive HP/LP/drive/chorus values on track 1 → Copy FX → Paste FX onto track 2 → all knobs match, zero console errors. Save project → reload page → load project → the same values persist.

### 3.2 Restore offline-render parity
- Port the live Filtr topology (HP biquad → LP biquad → drive waveshaper, ~2229–2258) into `runRenderMix`, replacing the single-biquad legacy block (~8064–8085, 8480).
- Add the missing stages to the offline chain, mirroring live construction and current track state: tremolo gain+LFO, tempo-gate gain+synced LFO, tape-delay wow LFO, reverb pre-delay node, reverb damp filter (~2394–2489). Respect bypass states exactly as the live `update*Bypass` functions do.
- **Verify (A/B):** create 2 tracks; set audible extremes (deep tremolo, hard gate, high drive, heavy wow, damped reverb); listen live, then Render Mix to WAV and play the file — the character must match. Then bypass everything and confirm a near-null render vs. live (levels equal, no missing/extra effects).

### 3.3 (Optional follow-up, only if 3.1/3.2 verify clean)
The root cause is two hand-maintained graph builders (~2140–2495 live vs ~8060–8309 offline). If time permits, extract a single `buildTrackFxChain(ctx, trackState)` used by both. This is a larger refactor — do it as a separate commit, and only after 3.2's A/B passes, re-running the same A/B afterwards.

**Definition of Done — Part 3:** `node --check` clean; 3.1 and 3.2 verifications pass; export loops (ZIP) and MP3 mixdown still work.

---

## Part 4 — Frontend Render-Loop & UI Performance (P1/P2)

**Files:** `loopmaster/loopmaster-app/static/app.js`, `static/app.css`
**Goal (observable):** during playback with 8 tracks, the DevTools Performance profile shows no per-frame layout thrash or canvas reallocation; idle CPU (no playback, panel open) is near zero.

Ordered quick wins (each is small and independent):
1. **Viz canvas reallocation (~1028–1163):** `renderVizSpectrum/Oscilloscope/Meters` call `getBoundingClientRect()` and reassign `canvas.width/height` every rAF frame. Guard exactly like `drawMeter` already does (~7524): only resize when the measured size actually changed; cache the rect via the existing `ResizeObserver` instead of measuring per frame.
2. **Mod-dot layout reads in the audio tick (~9505–9508, called from ~1341–1443):** `updateSliderModDot` does `querySelector` + `offsetWidth/Height/Left/Top` per modulated param per 25 ms tick. Move dot positioning out of `runAudioSchedulerTick` into a throttled visual pass (e.g. every 6th rAF frame), and cache each dot's geometry, recomputing only on resize/drawer-toggle.
3. **Playhead selector churn (~1681–1690):** cache `v.el.querySelector('.card-seek-bar')` once on the variant object (`v.seekBarEl`) at card creation; use the cached handle in `updatePlayheads`.
4. **Tick-loop `getElementById` (~1273, ~1447):** hoist `toggle-modulators-bypass` and `master-volume-slider` lookups to module-level cached constants.
5. **Meter scratch buffer (~2463):** `updateMeterState` allocates `new Float32Array(bufferLength)` per track per meter frame. Store one scratch array per analyser (keyed on `frequencyBinCount`) and reuse.
6. **Permanent box-shadow animations (app.css ~1097, ~2401, ~2536–2554):** `lock-breath`, `pulse-glow` (every MIDI-mapped control, forever), and LFO pulse buttons animate `box-shadow` (paint each frame). Re-express using `opacity`/`transform` on a pseudo-element or pre-rendered shadow layers; honor `prefers-reduced-motion` while you're in there.
7. **ResizeObserver storm (~7438–7445):** debounce the all-waveform redraw by ~100 ms so a drawer toggle doesn't redraw N×4 waveforms synchronously.
8. **MIDI mapping persistence (~8792):** wrap the `localStorage.setItem` in try/catch (quota errors currently throw inside the MIDI message handler).

**Definition of Done — Part 4:** `node --check` clean. Record a 10 s DevTools Performance profile during 8-track playback with the FX drawer + modulators open, before and after: purple "Layout" slivers inside the tick/rAF lanes are gone, canvas reallocation gone, scripting time per frame measurably lower (note the numbers in `HANDOFF.md`). Meters, mod dots, playheads, and MIDI learn all still function visually.

---

## Part 5 — Inference-Stack Performance & Safety

**Files:** `stable-audio-3/stable_audio_3/models/dit.py`, `stable_audio_3/inference/sampling.py`, `stable_audio_3/model.py`
**Goal (observable):** per-generation wall time drops measurably (record before/after timings); fp16 NaNs can no longer produce silent/corrupt WAVs; same-seed generations are reproducible.

Context: torch.compile is (correctly) disabled on Windows (`model.py:69` guard — Triton unavailable); the DiT runs eager. Do **not** attempt to enable torch.compile in this scope. The stale "45–60s compilation" status message (`app_server.py:146` area) should be updated to match reality in 5.5.

### 5.1 Remove the per-step GPU→CPU sync in the CFG gate
`dit.py:479` — `cfg_interval[0] <= sigma[0] <= cfg_interval[1]` forces two implicit `.item()` syncs on a CUDA tensor **every diffusion step** (same pattern at ~:466 for the LoRA gate). Fix: at the top of the DiT forward, compute `sigma_val = float(sigma.max().item())` once and use the Python float in both gates (one sync instead of several), or better, pass the per-step scalar sigma from `sample_diffusion`'s CPU-side schedule (sampling.py ~480–506) into the forward so no sync occurs. Prefer the simple single-hoist first; only thread the scalar through if profiling still shows the sync.
- **Verify:** time 10 identical 8-step, 4-variant generations before/after (the server already prints stage timings; add a one-line total print if needed). Expect a consistent reduction; record numbers.

### 5.2 NaN guard after fp16 VAE decode
`loading_utils.py:70-71` casts the whole model (VAE included) to fp16; the only post-decode treatment is `.clamp(-1,1)` (`model.py:362`), which does **not** remove NaN. Add `audio = torch.nan_to_num(audio, nan=0.0, posinf=1.0, neginf=-1.0)` immediately after the VAE decode returns (sampling.py ~533 or model.py before the clamp), and `print` a warning when any NaN was found (`torch.isnan` check on a cheap `.any()` — do it once per generation, not per chunk).

### 5.3 Per-call seeded Generator
`model.py:256-257` uses process-global `torch.manual_seed(seed)`. Replace with `g = torch.Generator(device=device).manual_seed(seed)` and `torch.randn(..., generator=g)`.
- **Verify:** two runs with the same seed/prompt/params produce byte-identical WAVs (or at minimum identical tensor checksums printed).

### 5.4 T5 conditioning cache for reroll workflows
`model.py:263-274` recomputes the T5Gemma text encoding on every `generate`. Add a small LRU (e.g. `functools.lru_cache`-style dict, max 16 entries) keyed by `(prompt, negative_prompt, seconds_total)` holding the conditioning tensors (detached). Regenerating variants of the same prompt (the app's "reroll" button) then skips the T5 forward.
- **Verify:** second generation with an identical prompt logs a cache hit and shaves the conditioning stage time.

### 5.5 Housekeeping
- `sampling.py:521-522` calls `torch.cuda.empty_cache()` before **every** VAE decode. Gate it: only call when `torch.cuda.mem_get_info()[0]` (free VRAM) is below ~2 GB. (Do not remove outright — it protects the 12 GB card at the decode peak — but stop paying the sync when there's headroom.)
- Ensure the chunked decode default stays `chunked=True` for all app-server code paths (`model.py:122` exposes `chunked_decode` — the app must never pass `False`; add a comment/assertion).
- Update the stale "compiling (45-60s)" status strings in `app_server.py` (~146) to reflect that compile is disabled on Windows.

**Definition of Done — Part 5:** `python -m py_compile` clean on all touched files; timing comparison recorded in `HANDOFF.md` (10-run before/after averages for: total generation, sampler loop, VAE decode); same-seed reproducibility confirmed; one full app session (generate, remix/continuation, outpaint, export) works end-to-end. **Do not run pytest.**

---

## Part 6 — Desktop Launcher & Hardening Polish (P2)

**Files:** `loopmaster-desktop/main.js`, `loopmaster/loopmaster-app/app_server_musicgen.py`, `app_server_audioldm.py`
**Goal (observable):** a failed backend boot shows an error instead of an infinite loading screen; sibling engine servers get the same safety fixes as Part 1.

### 6.1 Launcher robustness (`main.js`)
- `pollServerReady()` (~93–105) polls forever with no timeout and keeps polling even if the Python process dies. Add: (a) stop polling and show an error page (with the last ~30 lines of captured stderr) when `pythonProcess.on('close')` fires before the server is up; (b) a 5-minute overall timeout with the same error surface; (c) guard `mainWindow.loadURL` against a destroyed window (`if (mainWindow && !mainWindow.isDestroyed())`).
- Before spawning, probe port 7861; if something already responds, show a "stale server already running on 7861" message instead of silently attaching to an old process's UI.
- Add `app.requestSingleInstanceLock()` so a second launch focuses the existing window.

### 6.2 Sibling server parity
Apply the Part 1 pattern to `app_server_musicgen.py` and `app_server_audioldm.py`: single-lock track_num allocation (~214–223 in each), tensor cleanup + OOM-path `empty_cache`, `MAX_CONTENT_LENGTH`, jobs pruning, and replace bare `except:` (musicgen :46/:149, audioldm :46/:153) with `except Exception`. Do **not** add features; safety parity only.

**Definition of Done — Part 6:** kill the venv python mid-boot → launcher shows the error page, not an eternal spinner; double-launch focuses the first window; both sibling servers `py_compile` clean and boot to a completed generation (MusicGen small is fastest to test).

---

## Execution Order & Dependencies

```
Part 1 (backend P0)  →  Part 2 (frontend leaks)  →  Part 3 (fidelity/copy-paste)
                                                 →  Part 4 (perf quick wins)
Part 5 (inference) — independent, can run after Part 1
Part 6 (polish) — last
```
Parts 3 and 4 both touch `app.js` after Part 2's lifecycle changes land — do them sequentially, not in parallel. Priority if time-boxed: **1 → 2 → 3 → 5 → 4 → 6.**

## Known Risks / Edge Cases

- **Part 1.1:** the correct `gen_duration` semantics must be confirmed against the outpaint flow (frontend sends `duration` = extended target for outpaints). Test outpaint 2x/4x explicitly after the fix.
- **Part 2:** the undo-restore path must keep working — that is why `destroyTrackAudio` fires at eviction/project-load, never at first delete. If any knob on a restored track stops responding, a listener was bound with the wrong signal.
- **Part 3.2:** offline contexts don't support live `setTargetAtTime` scheduling identically for LFO-driven params; the existing offline modulation stepper (50 ms steps, ~8600 area) should drive the new tremolo/gate stages the same way it drives existing ones.
- **Part 5.1:** `sigma` may arrive batch-shaped; use `.max()`/first-element consistently with current semantics (`sigma[0]`).
- The wiki articles under `wiki/` (Home, User-Guide) reference behavior changed by Part 3/5 status-string updates — flag for a docs refresh pass after implementation (not part of this scope).

## Master Definition of Done

- [ ] All six parts' individual DoD checklists pass
- [ ] `python -m py_compile` on every touched `.py`; `node --check` on `app.js` — clean
- [ ] No pytest executed; no files under `outputs/` deleted
- [ ] Full manual smoke: launch (batch + desktop), generate 4 variants, continuation remix, outpaint 2x, regenerate unlocked, FX copy/paste, save/load project, render MP3 mixdown, export loops ZIP — zero console/server errors
- [ ] Before/after numbers (VRAM baseline, generation wall time, frame profile) recorded in `HANDOFF.md`
- [ ] `task.md` updated; commits are per-part, no absolute local paths committed
