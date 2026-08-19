# Kit Builder + Slicer Feed — Design (2026-08-19)

Owner: Claude. Files owned: `app_server.py`, `generation_executor.py`, new `kit_executor.py`,
`static/app.js`, `static/index.html`, `static/app.css`.
NOT touched: `stable-audio-3/stable_audio_3/model_configs.py`, `models/transformer.py` (Codex WIP).

## Goal
One new "Kit Builder" menu in the UI with three lanes:
1. **One-shots (A)** — single hits per kit piece, 3 velocity layers, N variations each.
2. **Hit sheets (B)** — one clip with many hits + silence, tagged `sliceable` for the upcoming slicer.
3. **Slicer feed** — presets (drum breaks, textures, loops-to-slice) generated normally but tagged `sliceable`.

The slicer (future) reads ONE registry file and finds everything it can slice.

## Backend

### New module `kit_executor.py`
- `KIT_PIECES`: key -> (noun, gen_duration). kick/snare/rimshot/clap/closed_hat/open_hat/
  tom_low/tom_mid/tom_high/ride/crash/shaker/cowbell/perc. Cymbals + open hat get 4.0 s,
  toms 2.0 s, rest 1.5 s.
- `VELOCITIES`: soft/medium/hard -> (prompt descriptor, peak target 0.45/0.70/0.98).
- `KitTask` dataclass: job_id, kit_name, style, pieces, velocities, variations,
  steps, cfg_scale, seed, include_sheets, sheet_hits.
- Prompt template (bypasses `enhance_prompt` — no loop/BPM tags):
  `"{style} {noun}, single hit, one-shot drum sample, {velocity descriptor}, dry, tight, clean studio recording"`.
- Executor loop: per piece, ONE batched `model.generate` call
  (batch = velocities x variations, capped at 8), under `model_lock`, `inference_mode`,
  padding 0, truncate True. Progress update per piece ("piece 3/8: closed hat…").
- Post-process each hit on CPU: trim leading silence (first sample > 1% of peak, back off 3 ms),
  trim tail (last sample > 0.5% of peak + 50 ms), 10 ms linear fade-out,
  peak-normalize to the velocity target.
- Save via `save_variant_atomically` with `is_loop=False` (ACID one-shot flag).
  Filenames: `{piece}_{velocity}_{nn}.wav` under `SESSION_DIR/kits/kit_{n}_{slug}/`.
- Write `kit.json` manifest: name, created, sample_rate, entries
  [{piece, velocity, variation, file, tags:["kit","one-shot"]}].
- Hit sheets (when `include_sheets`): per selected piece, duration 8 s, prompt
  `"{style} {noun}, {sheet_hits} isolated one-shot hits separated by silence, soft to hard, dry"`,
  saved as `{piece}_sheet_{nn}.wav`, tagged `sliceable`.

### Registry `sliceable.json` (new module `sliceable_registry.py`)
- One JSON file at `OUTPUT_DIR/sliceable.json`, guarded by a lock, append-record API:
  {file (relative), kind ("hit_sheet"|"break"|"loop"|"texture"), bpm, duration, prompt, created, session}.
- Kit executor records hit sheets. `api_generate` gains optional `sliceable: bool`
  (threaded through `GenerationTask`); publishes records after save.

### Routes in `app_server.py`
- `POST /api/generate_kit` -> validates body, registers one job, submits one `KitTask`.
- `GET /api/sliceable` -> returns the registry (for the future slicer UI).
- `GenerationExecutor.execute` dispatches on task type (GenerationTask vs KitTask).

## Frontend (`index.html` + `app.js` + `app.css`)
- New "Kit Builder" panel/menu next to the existing generate controls:
  - kit name + style prompt field
  - piece checklist (all default on)
  - velocity layer toggles (soft/med/hard), variations per layer (1-3)
  - "Include hit sheets" toggle (Option B)
  - Slicer-feed preset buttons: Drum Break, Perc Loop, Texture — call normal generate with
    `sliceable: true` and a preset prompt scaffold.
- Progress: reuse the existing job polling; kit job reports per-piece progress.
- Results: grouped list by piece with per-hit audition buttons + "Download kit (zip)" using the
  already-vendored jszip.

## Verify
- `py_compile` all touched Python; unit test for trim/normalize on synthetic tensors.
- Boot server, POST a 2-piece x 1-velocity kit, confirm files + kit.json + sliceable.json.
- `node --check app.js` after frontend edits.

## Sequencing
Performance-audit fixes land FIRST (same files), then this feature. One writer per file.
