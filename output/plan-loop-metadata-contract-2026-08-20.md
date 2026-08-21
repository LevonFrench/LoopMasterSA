# Loop File Metadata Contract — what any looper wants in the file

**Status:** design proposal (Claude, 2026-08-20, owner-ordered: "scope out a design for
exactly what our looper, any looper would want in file metadata"). Producers: LoopMaster
(`wav_metadata.py`, browser `buildAcidMetadata`). Consumers today: THE COOKUP's loop
factory (`bake/acid_probe.py`, `bake/ingest_loops.py` in the roblox repo), plus any DAW
(Ableton, ACID, FL) that honors these chunks. The goal: one WAV that self-describes so
completely that a looper needs ZERO sidecar files and zero hand-typing.

## The finding that motivates this doc

The `acid` chunk was never formally standardized, and it shows: LoopMaster currently packs
`<IHHifff` (type u32, root u16, reserved u16, **numBeats i32 @ offset 8**, meterNum f32,
meterDen f32, tempo f32), while the classic community layout most DAW-adjacent docs describe
puts **numBeats u32 @ offset 12** with u16 meter fields. THE COOKUP's probe read the classic
layout and got `beats = 1082130432` (that is float 4.0 read as an int) from a LoopMaster file.
Tempo happens to live at offset 20 in both, which is why tempo interop silently worked.
Two of our own tools already disagree; a third-party DAW is a coin flip. Hence: pin it.

## Layer 1 — the canonical `acid` chunk (DAW interop, REQUIRED)

Adopt the classic layout, byte-for-byte:

| offset | type | field | notes |
|---|---|---|---|
| 0 | u32 | fileType flags | bit0 = 0x01 "ACIDized loop" (LoopMaster: 1=loop, 0=one-shot — KEEP); bit1 0x02 root-note-set; bit4 0x10 stretch-enabled. Exact bit semantics vary by source — VERIFY EMPIRICALLY by round-tripping one file through a real DAW before freezing, and record the observed truth here. |
| 4 | u16 | rootNote | MIDI note (60 = C4 convention) |
| 6 | u16 | reserved | 0x8000 seen in the wild; 0 acceptable |
| 8 | f32 | reserved | 0 |
| 12 | u32 | numBeats | THE grid field — integer beats |
| 16 | u16 | meterDenominator | 4 |
| 18 | u16 | meterNumerator | 4 |
| 20 | f32 | tempo | BPM as produced |

**Action for LoopMaster:** change `struct.pack("<IHHifff", ...)` to
`struct.pack("<IHHfIHHf", acid_type, root_note, reserved, 0.0, num_beats, meter_den,
meter_num, tempo)` (size stays 24). Then round-trip-verify in one real DAW (drop the file
in Ableton: does it read tempo AND length right?) — the same verification law as the
byte-identical browser/Python check already done on 2026-08-19.

**Consumer law (both sides):** a reader must TOLERATE both layouts during the transition —
if `numBeats @ 12` is absurd (> 100,000) reinterpret via the legacy LoopMaster layout
(`i32 @ 8`), and always prefer RE-DERIVING beats from `duration x tempo / 60` over trusting
the stored integer (THE COOKUP's ingest already does; keep that as the audit).

## Layer 2 — `cue ` chunk: the slice map (REQUIRED for loops)

One cue point per BEAT at minimum (LoopMaster already writes these); optionally additional
TRANSIENT cues between beats. Sample-accurate positions. This is what makes a loop
slice-and-retriggerable (REX-style) without any runtime analysis — a looper that wants
tempo change without stretching plays cue-to-cue on its own clock. Label convention (in the
paired `LIST adtl` if present): `beat_N` for grid cues, `tx_N` for transient cues.

## Layer 3 — `smpl` chunk: the loop region (RECOMMENDED)

MIDI unity note + ONE loop of type forward with sample-accurate start/end covering the
musical length. This is the chunk hardware/software SAMPLERS read (where `acid` is what
DAWs read). For THE COOKUP it derives the engine's loop region in seconds; for anyone else
it makes the file behave in Kontakt/TAL/etc. Start = 0, end = beats x rate x 60 / bpm - 1.

## Layer 4 — `LIST INFO`: provenance (REQUIRED — the IP law)

Already shipping from LoopMaster; freeze the fields:
- `INAM` display name (falls back to filename stem)
- `ICMT` generation prompt / source description — the provenance line
- `ISFT` generator + version + BPM, e.g. `LoopMaster SA3 (140 BPM)`
- `ICRD` creation date ISO
- ADD `ICOP`: license posture string, e.g. `sa3-generated; license per Stable Audio terms;
  local-test until reviewed` — every audio asset carries its provenance INSIDE the file, so
  a WAV separated from its session folder still declares what it is (THE COOKUP AGENTS.md
  audio-provenance law made portable).
- OPTIONAL `IKEY`: musical key + scale as text (`F# minor`) for harmonic mixing later;
  rootNote alone loses major/minor.

## Layer 5 — `cKUP` chunk: looper cache (OPTIONAL, ours)

A custom chunk (id `cKUP`, JSON payload) carrying what OUR looper computes at ingest so
re-ingest is instant and display needs no audio decode:
`{"v":1,"peaks":[64 x 0..1],"slug":"...","lufs":null}`
Rules: never REQUIRED (any consumer must work without it); ignored by DAWs by design
(unknown chunks are skipped); version field first so it can evolve. Writer: THE COOKUP's
`ingest_loops.py` (roblox repo) on first ingest, or LoopMaster at render time if it wants
to precompute peaks.

## Layer 6 — ID3 mapping (bpmxxx interop + the DJ-software dialect)

`apps\bpmxxx` (BPM Explorer) analyzes BPM natively and detects musical KEY via
libkeyfinder, then writes **ID3v2** frames: `TBPM`, `TKEY`, `TIT2` (title), `TPE1`
(artist), `TALB`, `TYER`/`TDRC`, `COMM`. ID3 is the dialect Serato/rekordbox/Traktor
actually read — so the full field map across all three dialects is:

| meaning | acid chunk | LIST INFO | ID3 |
|---|---|---|---|
| tempo | `tempo` f32 | (ISFT suffix, informal) | `TBPM` (integer!) |
| key | `rootNote` (note only) | `IKEY` (proposed) | `TKEY` (full key, e.g. F#m) |
| name | — | `INAM` | `TIT2` |
| provenance | — | `ICMT`/`ISFT`/`ICOP` | `COMM` |

Rules: (1) when multiple dialects are present they MUST agree — a validator should flag
`TBPM != round(acid.tempo)`; (2) ID3 `TBPM` is integer-only, so `acid.tempo` stays the
precise value and TBPM the display value; (3) `TKEY` is the richest key field (major/minor),
prefer it over `rootNote` when both exist.

**COMPATIBILITY FLAG (verify before tagging WAVs with bpmxxx):** its `writeTags` writes an
ID3 header at byte 0 when none exists. That is correct for MP3/FLAC-adjacent files, but a
RIFF/WAV must carry ID3 inside an `id3 ` RIFF chunk — a prepended ID3 block at offset 0
CORRUPTS the WAV header. Untested claim from reading `src/tag-editor.js` only: confirm
whether the UI restricts tagging to MP3s before pointing it at the loop pack, or teach it
the `id3 ` chunk route for WAVs.

## Filename convention (the human layer + the fallback layer)

Canonical: `{pack}_{descriptor}_{bpm}bpm_{key}_{bars}bar_{var}.wav`
(e.g. `cookout_smokerise_140bpm_fmin_8bar_a1.wav`; one-shots put `oneshot` where the
tempo token would be: `cookout_stabhit_oneshot_gbmin_a1.wav`).

Rules: all lowercase `a-z0-9_` only (survives rbxasset://, URLs, slug sanitizers, and
kills the path case-sensitivity trap); BPM always glued as `140bpm` (a bare `808` in a
descriptor must never sniff as tempo — parsers PREFER the `\d{2,3}bpm` token over any
bare number); keys spelled with flats (`gbmin`, never `f#min` — `#` breaks URLs/shells);
length in BARS (humans think bars; exact beats live in the acid chunk); variation token
last so takes sort adjacent. Precedence law unchanged: in-file metadata is machine truth,
the filename is the fallback; when both exist they must agree.

## Validation gate (any producer, any consumer)

1. `abs(duration x bpm / 60 - round(same)) <= 0.03` beats — the grid law; reject, don't warn.
2. PCM 16-bit, 44.1k or 48k, WAV/OGG never MP3 (start-silence gotcha, Roblox-staff documented).
3. Loop files: no silence/reverb tail past the cut (clicks on wrap); zero-crossing or
   micro-crossfaded seam.
4. `acid.tempo > 0` and `flags` loop bit set for loops; one-shots: tempo 0, loop bit clear.
5. Chunks ordered BEFORE `data` (LoopMaster already does this to avoid decoder tail noise).

## Field-to-consumer map

| Looper need | Source chunk.field |
|---|---|
| native BPM | `acid.tempo` |
| musical length (beats) | derived from duration x tempo (audit vs `acid.numBeats`) |
| root note / key | `acid.rootNote` (+ `INFO.IKEY` if present) |
| loop vs one-shot | `acid.flags` bit0 |
| slice points | `cue ` positions |
| loop region (seconds) | `smpl` loop or 0..duration |
| display name | `INFO.INAM` else filename |
| provenance/license | `INFO.ICMT` + `ISFT` + `ICOP` |
| waveform peaks | `cKUP.peaks` else computed at ingest |

## Open items (owner/next session)

1. Empirical DAW round-trip of the canonical layout (one Ableton drop answers it) —
   record observed flag semantics here afterward.
2. LoopMaster `wav_metadata.py` + browser `buildAcidMetadata` layout fix (keep the two
   byte-identical — that invariant already exists and must survive the change).
3. Decide whether LoopMaster writes `smpl` + `ICOP` + `cKUP` at render or leaves them to
   ingest tools.
4. THE COOKUP probe/ingest: add the dual-layout tolerance (its repo, queued there).
