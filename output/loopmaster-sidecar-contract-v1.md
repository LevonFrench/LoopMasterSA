# LoopMaster Audio Sidecar Contract v1

**Schema:** `com.loopmaster.loop-meta`, version `1`

**Status:** implementation contract

**Published:** 2026-08-21

**Machine-readable schema:** [loopmaster-sidecar-schema-v1.json](loopmaster-sidecar-schema-v1.json)
**Canonical schema URI:** `https://schemas.loopmaster.app/loop-meta/v1.json`

This document defines the metadata file written beside every LoopMaster audio
asset. It is the handoff contract for the Roblox ingest tools, the CookOut loop
player, pack builders, and any future consumer.

The sidecar is deliberately complete. A consumer must not need to infer tempo,
length, key, slice locations, prompt provenance, or generation identity from a
filename. The WAV duplicates the portable fields that DAWs and samplers already
understand; the filename remains a readable fallback.

## 1. File pair

Every published WAV is paired with a same-stem JSON document:

```text
cookout_smokerise_140bpm_gbmin_8bar_a1.wav
cookout_smokerise_140bpm_gbmin_8bar_a1.meta.json
```

The pair is one logical asset. Copy, rename, upload, delete, and package both
files together.

The sidecar records both filenames and a SHA-256 digest of the final, tagged WAV.
A consumer that finds a sidecar must verify all three before accepting it:

1. `file` equals the adjacent WAV basename.
2. `metadataFile` equals the sidecar basename.
3. `audio.sha256` equals the digest of the adjacent WAV.

A failed check means the pair is stale, mismatched, or corrupted. Reject it; do
not silently combine fields from two different assets.

### Authority and fallback order

For a valid pair, use this order:

1. **Sidecar JSON** — complete canonical record.
2. **Embedded WAV metadata** — portable projection for a separated WAV.
3. **Canonical filename** — human-readable fallback only.
4. **Analysis/defaults** — last resort for legacy files.

When two available layers disagree, reject the asset during ingest and report
the fields that conflict. Do not guess which value the author intended.

## 2. Canonical filenames

Loop:

```text
{pack}_{descriptor}_{bpm}bpm_{key}_{bars}bar_{variation}.wav
```

One-shot:

```text
{pack}_{descriptor}_oneshot_{key}_{variation}.wav
```

Examples:

```text
cookout_smokerise_140bpm_fmin_8bar_a1.wav
cookout_stabhit_oneshot_gbmin_a1.wav
```

Rules:

- Lowercase ASCII only: `a-z`, `0-9`, and `_` between fields.
- `pack` and `descriptor` are each collapsed to one alphanumeric token. Their
  current producer limit is 64 characters each; there is no 40-character
  Roblox slug limit in the source contract.
- BPM is always an explicit glued token such as `140bpm`.
- Keys use flats: `gbmin`, never `f#min`. Unknown/keyless assets use `nokey`.
- Musical length is written in whole 4/4 bars.
- One-shots use `oneshot` in the tempo position and have no bars field.
- Variation is last and matches `[a-z][1-9][0-9]*`.

Variation letters identify render slots; the number identifies the take for
that slot. A four-variant render begins at `a1`, `b1`, `c1`, `d1`. Rerendering
slot B produces `b2`, then `b3`, while preserving the other slot identities.

Consumers must preserve `sidecar.id` in full. If a target platform needs a
short display label or upload key, create a separate local alias and retain the
canonical ID as `sourceId`; never truncate the canonical record.

## 3. Top-level document

The JSON document is UTF-8, uses LF line endings, and contains these required
top-level fields:

| Field | Type | Meaning |
|---|---|---|
| `$schema` | string | Contract schema URI: `https://schemas.loopmaster.app/loop-meta/v1.json` |
| `schema` | string | Contract identifier: `com.loopmaster.loop-meta` |
| `version` | integer | Contract major version; currently `1` |
| `id` | string | Canonical WAV stem, without extension |
| `file` | string | Adjacent WAV basename |
| `metadataFile` | string | This sidecar's basename |
| `kind` | enum | `loop` or `oneshot` |
| `naming` | object | Parsed canonical naming fields |
| `audio` | object | Physical WAV facts and integrity values |
| `musical` | object | Tempo, meter, grid, key, and chord timeline |
| `loopRegion` | object/null | Sample-accurate loop boundary |
| `waveform` | object | Fixed 64-value display overview |
| `slices` | object | Beat, transient, and preferred slicer maps |
| `generation` | object | Prompt and reproducibility/provenance inputs |
| `provenance` | object | Generator, timestamp, and license posture |
| `embedded` | object | Which standard WAV projections were written |

Unknown top-level fields are forbidden in v1. `generation` and `provenance`
permit additional fields so producers can append source-specific details
without redefining the playback contract.

## 4. Representative sidecar

This example is abridged where arrays are marked; the JSON Schema is the exact
machine-readable definition.

```jsonc
{
  "$schema": "https://schemas.loopmaster.app/loop-meta/v1.json",
  "schema": "com.loopmaster.loop-meta",
  "version": 1,
  "id": "cookout_serenepiano_120bpm_cmaj_8bar_a1",
  "file": "cookout_serenepiano_120bpm_cmaj_8bar_a1.wav",
  "metadataFile": "cookout_serenepiano_120bpm_cmaj_8bar_a1.meta.json",
  "kind": "loop",
  "naming": {
    "pack": "cookout",
    "descriptor": "serenepiano",
    "variation": "a1"
  },
  "audio": {
    "format": "wav",
    "encoding": "pcm_s16le",
    "sampleRate": 44100,
    "channels": 2,
    "bitDepth": 16,
    "frames": 705600,
    "durationSeconds": 16,
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "bytes": 2839876
  },
  "musical": {
    "bpm": 120,
    "meter": { "numerator": 4, "denominator": 4 },
    "beats": 32,
    "bars": 8,
    "gridErrorBeats": 0,
    "key": {
      "token": "c_maj",
      "filename": "cmaj",
      "display": "C major",
      "rootMidi": 60
    },
    "chords": [
      { "bar": 1, "beat": 1, "chord": "c_maj", "roman": "I", "symbol": "C", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
      { "bar": 2, "beat": 1, "chord": "d_maj", "roman": "II", "symbol": "D", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
      { "bar": 3, "beat": 1, "chord": "g_maj", "roman": "V/vi", "symbol": "G/A", "formulaOffsets": [0, 4, 7], "bass": "a", "bassOffset": 2 },
      { "bar": 4, "beat": 1, "chord": "a_min", "roman": "vi", "symbol": "Am", "formulaOffsets": [0, 3, 7], "bass": null, "bassOffset": null },
      { "bar": 5, "beat": 1, "chord": "c_maj", "roman": "I", "symbol": "C", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
      { "bar": 6, "beat": 1, "chord": "d_maj", "roman": "II", "symbol": "D", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
      { "bar": 7, "beat": 1, "chord": "g_maj", "roman": "V/vi", "symbol": "G/A", "formulaOffsets": [0, 4, 7], "bass": "a", "bassOffset": 2 },
      { "bar": 8, "beat": 1, "chord": "a_min", "roman": "vi", "symbol": "Am", "formulaOffsets": [0, 3, 7], "bass": null, "bassOffset": null }
    ],
    "chordSource": "prompt",
    "chordsVerified": false
  },
  "loopRegion": {
    "startSample": 0,
    "endSampleInclusive": 705599,
    "endSampleExclusive": 705600,
    "startSeconds": 0,
    "endSeconds": 16
  },
  "waveform": {
    "peaks": ["exactly 64 normalized numbers from 0 through 1"]
  },
  "slices": {
    "unit": "samples",
    "beatGrid": [
      { "id": "beat_1", "kind": "beat", "sample": 0, "seconds": 0, "bar": 1, "beat": 1 },
      { "id": "beat_2", "kind": "beat", "sample": 22050, "seconds": 0.5, "bar": 1, "beat": 2 }
    ],
    "transients": [
      { "id": "tx_1", "kind": "transient", "sample": 17640, "seconds": 0.4, "strength": 0.1842 },
      { "id": "tx_2", "kind": "transient", "sample": 52920, "seconds": 1.2, "strength": 0.1328 }
    ],
    "preferred": [
      { "id": "tx_1", "kind": "transient", "sample": 17640, "seconds": 0.4, "strength": 0.1842 },
      { "id": "tx_2", "kind": "transient", "sample": 52920, "seconds": 1.2, "strength": 0.1328 }
    ]
  },
  "generation": {
    "jobId": "9be2f1b40b8e",
    "resultId": "9be2f1b40b8e:a1",
    "trackNumber": 12,
    "variantIndex": 0,
    "model": "medium-bf16",
    "qualityTier": "final",
    "requestedSeed": -1,
    "seed": 48172,
    "seedOffset": 0,
    "variantSeed": 48172,
    "steps": 8,
    "cfgScale": 1,
    "requestedDurationSeconds": 16,
    "durationPaddingSeconds": 2,
    "sliceable": true,
    "prompt": {
      "composed": "serene ambient piano in C major",
      "conditioned": "serene ambient piano in C major, harmonic progression locked to C - D - G/A - Am, one chord per bar, repeat this exact four-bar cycle through 8 bars",
      "enhanced": "TrackType: Instrument, solo serene ambient piano in C major, 120 BPM, seamless loop, harmonic progression locked to C - D - G/A - Am, one chord per bar, repeat this exact four-bar cycle through 8 bars",
      "negative": "poor quality, bad quality, low quality, noise, distortion, artifact, vocals, speech",
      "userNegative": "vocals, speech",
      "sections": {
        "genre": "ambient",
        "instrument": "piano",
        "harmony": "Use Chord Progressor",
        "progressionId": "major_serene_01",
        "progressionKey": "C major",
        "progression": "I-II-V/vi-vi: Serene"
      }
    },
    "progression": {
      "catalogId": "major_serene_01",
      "catalogVersion": 1,
      "key": "C major",
      "mode": "major",
      "mood": "Serene",
      "formula": "I-II-V/vi-vi",
      "selection": "I-II-V/vi-vi: Serene",
      "cycleBars": 4,
      "cycle": [
        { "slot": 1, "roman": "I", "chord": "c_maj", "symbol": "C", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
        { "slot": 2, "roman": "II", "chord": "d_maj", "symbol": "D", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
        { "slot": 3, "roman": "V/vi", "chord": "g_maj", "symbol": "G/A", "formulaOffsets": [0, 4, 7], "bass": "a", "bassOffset": 2 },
        { "slot": 4, "roman": "vi", "chord": "a_min", "symbol": "Am", "formulaOffsets": [0, 3, 7], "bass": null, "bassOffset": null }
      ],
      "events": [
        { "bar": 1, "beat": 1, "roman": "I", "chord": "c_maj", "symbol": "C", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
        { "bar": 2, "beat": 1, "roman": "II", "chord": "d_maj", "symbol": "D", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
        { "bar": 3, "beat": 1, "roman": "V/vi", "chord": "g_maj", "symbol": "G/A", "formulaOffsets": [0, 4, 7], "bass": "a", "bassOffset": 2 },
        { "bar": 4, "beat": 1, "roman": "vi", "chord": "a_min", "symbol": "Am", "formulaOffsets": [0, 3, 7], "bass": null, "bassOffset": null },
        { "bar": 5, "beat": 1, "roman": "I", "chord": "c_maj", "symbol": "C", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
        { "bar": 6, "beat": 1, "roman": "II", "chord": "d_maj", "symbol": "D", "formulaOffsets": [0, 4, 7], "bass": null, "bassOffset": null },
        { "bar": 7, "beat": 1, "roman": "V/vi", "chord": "g_maj", "symbol": "G/A", "formulaOffsets": [0, 4, 7], "bass": "a", "bassOffset": 2 },
        { "bar": 8, "beat": 1, "roman": "vi", "chord": "a_min", "symbol": "Am", "formulaOffsets": [0, 3, 7], "bass": null, "bassOffset": null }
      ]
    },
    "remix": {
      "mode": null,
      "source": null,
      "noiseLevel": null,
      "inpaintStart": null,
      "inpaintEnd": null,
      "continueStart": null,
      "invertTiming": false
    }
  },
  "provenance": {
    "generator": "LoopMaster SA3",
    "createdAt": "2026-08-21T02:15:40Z",
    "license": "sa3-generated; license per Stable Audio terms; local-test until reviewed",
    "session": "session_20260821_021430"
  },
  "embedded": {
    "acid": true,
    "cue": true,
    "smpl": true,
    "listInfo": true,
    "ckup": true
  }
}
```

The digest and byte count above are illustrative. Real consumers must calculate
and validate both from the finalized WAV; they must never special-case them.

## 5. Physical audio fields

`audio` describes the finalized WAV, after metadata chunks have been inserted.
It is not copied from requested generation duration.

| Field | Contract |
|---|---|
| `format` | Always `wav` |
| `encoding` | Always signed little-endian PCM16: `pcm_s16le` |
| `sampleRate` | `44100` or `48000` |
| `channels` | Positive channel count; current output is normally stereo |
| `bitDepth` | Always `16` |
| `frames` | Samples per channel, also called sample frames |
| `durationSeconds` | `frames / sampleRate` |
| `sha256` | Lowercase SHA-256 of the complete finalized WAV bytes |
| `bytes` | Final WAV byte size |

All slicer and loop offsets use **sample frames**, not interleaved scalar sample
indices. For stereo audio, `sample: 44100` still means one second at 44.1 kHz.

## 6. Musical timing invariants

Loop timing is derived from the finalized audio:

```text
exactBeats = audio.frames / audio.sampleRate * musical.bpm / 60
musical.beats = round(exactBeats)
musical.gridErrorBeats = abs(exactBeats - musical.beats)
musical.bars = musical.beats / 4
```

For v1 loops:

- BPM is a positive integer.
- Meter is exactly 4/4.
- `gridErrorBeats <= 0.03`.
- Beat count must be divisible by four.
- Bars must be a positive integer.
- `loopRegion` spans exactly `0 .. audio.frames`.

For one-shots:

- `musical.bpm`, `beats`, `bars`, and `gridErrorBeats` are `null`.
- `loopRegion` is `null`.
- Embedded ACID tempo and beat count are zero and the loop flag is clear.
- Transient slicer points may still be present.

## 7. Key, chord, and progressor representation

One key is stored in four equivalent forms so every consumer can use a natural
representation:

```json
{
  "token": "gb_min",
  "filename": "gbmin",
  "display": "Gb minor",
  "rootMidi": 66
}
```

Roots are flat-normalized: `c db d eb e f gb g ab a bb b`. Qualities are
`maj` or `min`. `F# minor`, if entered by a user, therefore becomes the exact
object above. A keyless asset stores `key: null` and uses `nokey` in its name.

### Canonical chord events

Chord events use musical positions rather than seconds. A progressor-authored
event carries both the canonical playback token and the source notation:

```json
{
  "bar": 3,
  "beat": 1,
  "chord": "g_maj",
  "roman": "V/vi",
  "symbol": "G/A",
  "formulaOffsets": [0, 4, 7],
  "bass": "a",
  "bassOffset": 2
}
```

| Field | Contract |
|---|---|
| `bar`, `beat` | One-based musical position. Progressor events always use beat `1`. |
| `chord` | Flat-normalized `<root>_<quality>` token for the resolved chord root and quality. |
| `roman` | Authored catalog step, preserved as musical source notation. |
| `symbol` | Human-readable resolved symbol, including slash bass when present. |
| `formulaOffsets` | Semitone intervals above the chord root. Extensions intentionally exceed `11`. |
| `bass` | Flat-normalized absolute bass root, or `null`. It is separate from `chord`. |
| `bassOffset` | Bass pitch-class distance from the chord root in `0..11`, or `null`. |

`bass` and `bassOffset` must either both be non-null or both be null. The chord
progressor writes every rich field on every event, including explicit null bass
fields. A legacy/manual chord map may use the minimal `bar`, `beat`, and `chord`
shape, but consumers must preserve rich fields whenever supplied.

Grammar:

```text
<flat-root>_<approved-quality>
```

- Roots: `c db d eb e f gb g ab a bb b`
- Approved qualities: `maj min dim aug sus2 sus4 maj6 min6 maj7 min7 dom7
  dim7 aug7 maj9 min9 dom9 min11 dom11 dom13 min13 majadd9 minadd9
  majadd11 minadd11 dimaddaug5 min7aug5`
- Bar and beat are one-based.
- The first event must begin at bar 1, beat 1.
- A chord holds until the next event or the end of the asset.
- Duplicate positions and positions outside the loop are invalid.

`chordSource` is `user`, `prompt`, `analyzed`, `imported`, or `null`.
`chordsVerified` states whether audio analysis or a human has confirmed the
rendered sound. A manually authored map uses `chordSource: "user"`; the chord
progressor uses `chordSource: "prompt"`. Normal LoopMaster generation writes
`chordsVerified: false` for both. These events record authored/requested intent,
never acoustic verification. Resolving Roman numerals and conditioning a model
prompt does not prove that the rendered audio played those chords. A key-only
prompt never fabricates a chord event.

### Curated four-chord progressor

Catalog version 1 contains exactly **62 curated four-chord presets**: 31 major
and 31 minor. Every preset has a stable ID, mode, mood label, display formula,
and exactly four authored Roman-numeral steps. The selected key must match the
preset mode. Accidentals, case, extensions, alterations, suspensions, added
tones, and slash-bass notation are resolved deterministically against that key;
resolved roots and bass notes always use flat spellings.

The four slots are a four-bar cycle. The resolver writes exactly one chord at
beat 1 of every loop bar and repeats slots 1 through 4 modulo the requested loop
length. An eight-bar loop therefore carries eight `musical.chords` events: the
same four-slot cycle twice. The cycle is requested harmonic intent even when
the generated waveform deviates from it.

`generation.progression` preserves the resolution context:

| Field | Meaning |
|---|---|
| `catalogId`, `catalogVersion` | Stable preset identity and catalog grammar version. |
| `key`, `mode` | Selected display key and matching major/minor mode. |
| `mood`, `formula`, `selection` | Catalog labels used by the prompt builder. |
| `cycleBars` | Always `4` in v1. |
| `cycle` | Exactly four rich steps, numbered by `slot` from 1 through 4. |
| `events` | The cycle expanded across all requested bars, one event per bar at beat 1. |

Every `cycle` step contains `slot`, `roman`, `chord`, `symbol`,
`formulaOffsets`, `bass`, and `bassOffset`. Every progression `events` item
contains the same fields except `slot`, plus `bar` and `beat`. The expanded
`generation.progression.events` and `musical.chords` must agree exactly on their
musical fields. `generation.prompt.conditioned` may describe the locked cycle,
but remains a generation request rather than analysis evidence.

### Roblox harmony adapter

The current Roblox harmony bus uses a numeric payload rather than contract
tokens. Ingest must parse each token into:

```luau
type HarmonyEvent = {
    root: number,      -- pitch class, C=0 through B=11
    quality: string,
    degrees: {number},
    bass: number?,     -- resolved pitch class when the sidecar has a slash bass
    bassOffset: number?,
}
```

Pitch classes:

```text
c=0 db=1 d=2 eb=3 e=4 f=5 gb=6 g=7 ab=8 a=9 bb=10 b=11
```

Degree sets, expressed as semitone offsets:

| Quality | Degrees |
|---|---|
| `maj` | `{0, 4, 7}` |
| `min` | `{0, 3, 7}` |
| `dim` | `{0, 3, 6}` |
| `aug` | `{0, 4, 8}` |
| `sus2` | `{0, 2, 7}` |
| `sus4` | `{0, 5, 7}` |
| `maj6` | `{0, 4, 7, 9}` |
| `min6` | `{0, 3, 7, 9}` |
| `maj7` | `{0, 4, 7, 11}` |
| `min7` | `{0, 3, 7, 10}` |
| `dom7` | `{0, 4, 7, 10}` |
| `dim7` | `{0, 3, 6, 9}` |
| `aug7` | `{0, 4, 8, 10}` |
| `maj9` | `{0, 4, 7, 11, 14}` |
| `min9` | `{0, 3, 7, 10, 14}` |
| `dom9` | `{0, 4, 7, 10, 14}` |
| `min11` | `{0, 3, 7, 10, 14, 17}` |
| `dom11` | `{0, 4, 7, 10, 14, 17}` |
| `dom13` | `{0, 4, 7, 10, 14, 17, 21}` |
| `min13` | `{0, 3, 7, 10, 14, 17, 21}` |
| `majadd9` | `{0, 4, 7, 14}` |
| `minadd9` | `{0, 3, 7, 14}` |
| `majadd11` | `{0, 4, 7, 17}` |
| `minadd11` | `{0, 3, 7, 17}` |
| `dimaddaug5` | `{0, 3, 6, 8}` |
| `min7aug5` | `{0, 3, 8, 10}` |

The list is explicit so the Roblox adapter never has to guess the meaning of a
syntactically possible chord. Preserve `chord`, `roman`, `symbol`,
`formulaOffsets`, `bass`, and `bassOffset` alongside the numeric form so a
future grammar version can be re-read without loss.

## 8. Slicer maps

Slicer locations are calculated from the **final waveform**. Prompt text and
declared instrument type never determine slice positions.

### `beatGrid`

For a loop with `N` validated beats and `F` final frames, beat `i` starts at:

```text
round(i * F / N), for i = 0 .. N-1
```

Every point contains `id`, `kind`, `sample`, `seconds`, `bar`, and `beat`.
The first point is always sample frame zero. Dividing the actual frame count
rather than repeatedly adding a rounded samples-per-beat value prevents drift
at the loop boundary.

One-shots have an empty `beatGrid` because they have no tempo contract.

### `transients`

The v1 detector is intentionally deterministic and lightweight:

1. Convert the finished waveform to float32 CPU audio.
2. Take absolute amplitude and average all channels to mono.
3. Divide it into 10 ms windows and keep each window's peak amplitude.
4. Compute positive spectral-free flux: `max(currentPeak - previousPeak, 0)`.
5. Across all flux windows, including quiet windows, compute the threshold as
   the greater of:
   - `median(flux) + 3 * MAD(flux)`, and
   - the 95th percentile of flux.
   Zero-flux windows are never candidates. Including them in the noise-floor
   estimate keeps every isolated hit in an increasing-intensity sheet visible,
   while the high percentile suppresses dense low-level motion.
6. Keep threshold-crossing local maxima.
7. Merge competing attacks inside an 80 ms refractory window, retaining the
   stronger candidate.
8. Store at most 128 points as `tx_1`, `tx_2`, and so on.

Each transient carries its normalized detection `strength`. Strength is useful
for ranking or UI display; it is not a loudness unit and must not be compared
across separately mastered files.

### `preferred`

`preferred` is a list of **internal cut boundaries**, not a list of pads or
complete regions. Every preferred sample must satisfy
`0 < sample < audio.frames`; consumers supply the implicit start boundary `0`
and terminal boundary `audio.frames`.

For the current 16-pad Roblox deck:

- If at least two reliable transients were detected, choose the 15 strongest
  internal transient boundaries and restore chronological order.
- Otherwise choose up to 15 evenly distributed internal beat boundaries.
- Store at most 15 preferred boundaries. Fifteen internal cuts plus the two
  implicit endpoints produce at most 16 adjacent playable regions.
- Sample frame zero and `audio.frames` are excluded because both are implicit
  boundaries.

This fallback keeps sustained pads and quiet melodic loops sliceable even when
onset detection finds too little structure, and guarantees at most 16 playable
regions. The full-resolution `beatGrid` and `transients` catalogs remain
available for consumers with paging or dynamic pads.

### Building slice regions

Stored points are **cut boundaries**. They are not independent samples and they
do not identify region ends by themselves. A transient map will normally begin
at the first detected attack rather than sample zero, so every consumer must
add the two implicit boundaries `0` and `audio.frames`. Sort and deduplicate all
boundaries, then build adjacent half-open ranges:

```text
boundaries = unique(sort([0] + point samples + [audio.frames]))
regions = [boundaries[i], boundaries[i + 1])
```

This preserves any pickup before the first detected attack. `audio.frames` is
the terminal boundary, not a playable cue: never emit or seek to it as a point,
because the last valid sample frame is `audio.frames - 1`.

### Luau consumer sketch

```luau
export type SlicePoint = {
    id: string,
    kind: "beat" | "transient",
    sample: number,
    seconds: number,
    strength: number?,
    bar: number?,
    beat: number?,
}

local function buildRegions(points: {SlicePoint}, frameCount: number, sampleRate: number)
    local seen = {[0] = true, [frameCount] = true}
    local boundaries = {0, frameCount}
    for _, point in points do
        if point.sample > 0 and point.sample < frameCount and not seen[point.sample] then
            seen[point.sample] = true
            table.insert(boundaries, point.sample)
        end
    end
    table.sort(boundaries)

    local regions = {}
    for index = 1, #boundaries - 1 do
        local startSample = boundaries[index]
        local endExclusive = boundaries[index + 1]
        table.insert(regions, {
            startSample = startSample,
            endSampleExclusive = endExclusive,
            startSeconds = startSample / sampleRate,
            endSeconds = endExclusive / sampleRate,
        })
    end
    return regions
end
```

Roblox playback ultimately seeks in seconds, so use the supplied `seconds` or
divide sample frames by `audio.sampleRate`. Keep sample-frame values in baked
data for deterministic regeneration and validation.

## 9. Embedded WAV projection

The WAV remains useful when separated from its sidecar. LoopMaster writes
metadata chunks before `data` and mirrors these fields:

### Canonical `acid` chunk

The payload is exactly 24 bytes, little-endian `<IHHfIHHf>`:

| Offset | Type | Meaning |
|---:|---|---|
| 0 | `u32` | Flags; bit 0 loop, bit 1 root note present |
| 4 | `u16` | MIDI root note, or `0xffff` when absent |
| 6 | `u16` | Reserved, zero |
| 8 | `f32` | Reserved, zero |
| 12 | `u32` | Beat count; zero for one-shots |
| 16 | `u16` | Meter denominator, 4 |
| 18 | `u16` | Meter numerator, 4 |
| 20 | `f32` | BPM; zero for one-shots |

Readers should continue tolerating the old LoopMaster layout during migration,
but all newly produced files use the canonical layout above.

### `cue ` plus `LIST adtl`

All `beatGrid` and `transients` points are embedded as sample-position cues.
Labels are exactly `beat_N` and `tx_N`. The sidecar remains richer because it
also provides seconds, bar/beat positions, strength, grouping, and preferred
fallback selection.

### `smpl`

Loops contain one forward region:

```text
start = 0
end inclusive = audio.frames - 1
```

One-shots do not contain a LoopMaster-authored `smpl` loop.

### `LIST INFO`

| Entry | Value |
|---|---|
| `INAM` | Canonical asset ID |
| `ICMT` | Composed generation prompt/source description |
| `ISFT` | Generator identity and loop BPM |
| `ICRD` | ISO creation timestamp |
| `ICOP` | License/provenance posture |
| `IKEY` | Display key, such as `Gb minor`, when known |

### `cKUP` portable cache

The custom UTF-8 JSON `cKUP` chunk mirrors all portable, non-chord metadata from
the sidecar: identity, kind, metadata filename, naming, physical audio facts,
musical grid/key, loop region, 64 peaks, complete slice catalogs, non-harmony
generation inputs, and provenance. Its compact payload starts with:

```json
{ "v": 1, "schema": "com.loopmaster.loop-cache" }
```

The structured chord timeline is sidecar-only. `cKUP` always omits
`musical.chords`, `musical.chordSource`, `musical.chordsVerified`, and
`generation.progression`, and always redacts the `harmony`, `progressionKey`,
`progressionId`, `progression`, and `chordTrack` prompt section fields —
regardless of whether the asset used the chord progressor or a manually
supplied chord map. For a progressor asset it additionally redacts the
chord-bearing prompt projections `prompt.composed`, `prompt.conditioned`, and
`prompt.enhanced`. It preserves `prompt.negative`, `prompt.userNegative`,
every non-harmony prompt section, and all other non-chord generation and
provenance fields.

This redaction removes parseable progressions and chord-bearing prompt text
without throwing away portable metadata that remains useful when the WAV is
separated from its sidecar. The only other omissions are `audio.sha256` and
`audio.bytes`, because a WAV cannot contain its own final digest or size without
creating a circular value. Unknown RIFF chunks are safe for normal DAWs to
skip. `LIST INFO` `ICMT` remains descriptive source text, not a structured or
authoritative chord timeline.

The sidecar remains authoritative. `cKUP` is the richest fallback when the WAV
has been separated from it; standard ACID/cue/smpl/INFO fields remain the
widest-interoperability fallback.

## 10. Generation and provenance

The normal loop writer records enough data to reproduce or audit a render:

- Job, result, track, variant slot, and take identity.
- Actual model identifier and local quality tier.
- Requested seed and resolved seed. `requestedSeed: -1` means the user asked
  for random; `seed` is the actual random value chosen before generation.
- Variant seed derivation (`variantSeed = seed + seedOffset`).
- Step count, CFG scale, requested duration, and padding.
- Exact composed prompt, model-enhanced prompt, effective model negative
  prompt, user-authored negative override, and every structured prompt section.
- For progressor renders, the stable catalog ID/version, selected key/mode,
  mood/formula labels, four-slot rich cycle, and bar-expanded rich event list.
- Remix mode and source parameters when applicable.
- UTC creation time, generator identity, and license posture.

Fields describe authored/requested inputs and provenance; they are not
acoustic-analysis claims. In particular, selecting one of the 62 progressions,
resolving its symbols, and conditioning the model do not verify the waveform.
Current progressor renders therefore use `chordSource: "prompt"` and
`chordsVerified: false` until a separate analysis or human confirmation step
explicitly establishes otherwise.

## 11. Pack manifest

LoopMaster ZIP export includes each WAV, each adjacent `.meta.json`, and one
`manifest.json`. The manifest is an index, not a replacement for per-file
metadata. Each item includes at least:

```json
{
  "file": "cookout_smokerise_140bpm_fmin_8bar_a1.wav",
  "metadataFile": "cookout_smokerise_140bpm_fmin_8bar_a1.meta.json",
  "sha256": "...",
  "kind": "loop",
  "bpm": 140,
  "beats": 32,
  "bars": 8,
  "key": "f_min",
  "chords": [],
  "slices": { "preferred": [] }
}
```

An importer should enumerate manifest items, validate every file pair, then
ingest the full sidecar. It should not use manifest summaries as authoritative
when the referenced sidecar is available.

## 12. Roblox ingest mapping

The current Roblox runtime does not parse WAV chunks or JSON sidecars. The bake
step must read this sidecar, upload/copy the audio, then emit static Luau data.

Minimum mapping for the existing loop deck:

| Runtime field | Sidecar/source |
|---|---|
| `id` | Local stable ID; retain `sidecar.id` as `sourceId` |
| `name` | `sidecar.id` or a separate display label |
| `nativeBpm` | `musical.bpm` |
| `beats` | `musical.beats` |
| `assetId` | Roblox upload result; not knowable at render time |
| `peaks` | `waveform.peaks` |
| `duration` | `audio.durationSeconds` |
| `sampleRate` | `audio.sampleRate` |
| `slicePoints` | `slices.preferred` |
| `key` | `musical.key.token`, when present |
| `chords` | Adapted `musical.chords` events, retaining all rich source fields |

Required consumer changes:

1. Discover and copy `.meta.json` beside each WAV.
2. Remove the current 40-character source-name truncation. A runtime alias may
   be short, but `sourceId` must remain complete.
3. Validate schema/version, filenames, hash, PCM16 facts, grid invariants, and
   duplicated embedded fields before upload.
4. Route `kind: "oneshot"` to the instrument/one-shot pipeline instead of the
   tempo-loop importer.
5. Bake `duration` and preferred slicer points for the SlicerBoard.
6. Convert chord tokens through the explicit harmony adapter rather than
   passing strings directly to the current numeric `Scale.HarmonyEvent` bus.
7. Update the CookOut local file server to allow adjacent JSON metadata and add
   a sidecar loader; it currently exposes audio files only.
8. Prefer the explicit `NNNbpm` filename token for legacy fallback. Never treat
   a descriptor number such as `808` as tempo.

For the current 16-pad slicer, `slices.preferred` already contains at most 15
internal boundaries. Convert each with `fraction = sample / audio.frames` and
require `0 < fraction < 1`; SlicerMachine supplies implicit `0` and `1`
boundaries. Retain the complete `beatGrid` and `transients` catalogs separately
for later paging or a larger deck.

Do not wire this data into the live Roblox Boot path until the U-SLICER work
order's validation, persistence, and scheduled-client playback requirements are
complete. The safe first handoff is importer/catalog generation and fixtures.
The current runtime shallow-clones disks, so nested `peaks`, `sliceMarkers`,
`key`, and `chords` must be deep-copied/frozen or held in an immutable catalog
keyed by `sourceId`.

Suggested baked Luau shape:

```luau
{
    id = "rbx-upload-key",
    sourceId = "cookout_serenepiano_120bpm_cmaj_8bar_a1",
    name = "serene piano",
    nativeBpm = 120,
    beats = 32,
    duration = 16,
    sampleRate = 44100,
    assetId = "rbxassetid://0000000000",
    peaks = { -- exactly 64 numbers
    },
    slicePoints = {
        { id = "tx_1", kind = "transient", sample = 17640, seconds = 0.4, strength = 0.1842 },
    },
    key = { token = "c_maj", root = 0, quality = "maj" },
    chords = {
        {
            bar = 3,
            beat = 1,
            token = "g_maj",
            root = 7,
            quality = "maj",
            degrees = {0, 4, 7},
            roman = "V/vi",
            symbol = "G/A",
            formulaOffsets = {0, 4, 7},
            bass = 9,
            bassToken = "a",
            bassOffset = 2,
        },
    },
}
```

## 13. Validation checklist

A conforming importer rejects an asset when any required check fails:

- JSON parses and validates against the v1 schema.
- Schema identifier/version are supported.
- Sidecar/WAV names and SHA-256 agree.
- Filename grammar and `naming`/`musical` values agree.
- WAV is RIFF/WAVE, PCM16, and 44.1 or 48 kHz.
- WAV physical frame count/rate/channels agree with `audio`.
- Loop duration/BPM resolves to an integer beat grid within 0.03 beats.
- Loop beats, bars, meter, region, and ACID values agree.
- One-shot loop fields are null and embedded loop tempo/flag are clear.
- Key representations normalize to the same pitch class and quality.
- Chords are ordered, unique, in range, and begin at bar 1 beat 1.
- Every supplied rich chord field is canonical; `bass` and `bassOffset` are
  both null or both present and agree.
- A progressor record names one of the 62 catalog entries at its declared
  version, has exactly four cycle slots, matches the selected key/mode, and
  expands to one beat-1 event per loop bar. Its `generation.progression.events`
  and `musical.chords` agree.
- Progressor output remains `chordSource: "prompt"` and
  `chordsVerified: false`; catalog resolution is not acoustic verification.
- Exactly 64 peaks exist and all are in `0..1`.
- Every slice sample is an integer in `0 .. audio.frames-1`.
- Slice seconds agree with `sample / audio.sampleRate` within floating-point
  tolerance.
- Preferred slices equal the documented transient-or-grid choice.
- Preferred slices contain at most 15 strictly internal cut boundaries; `0`
  and `audio.frames` remain implicit.
- Embedded cue and `smpl` positions agree with the sidecar.
- `cKUP` contains the non-chord portable projection but no structured chord
  timeline, progression object, chord-bearing prompt section fields
  (`harmony`, `progressionKey`, `progressionId`, `progression`, `chordTrack`
  — for any asset, progressor or manual), or progressor chord-bearing prompt
  projections.
- License and creation provenance are nonempty.

Do not downgrade contract failures to warnings during pack creation. Failing
early is safer than shipping a loop that drifts, points at the wrong audio, or
announces the wrong harmony.

## 14. Versioning and forward compatibility

- `schema` names the contract family; `version` selects its major grammar.
- Producers may add source-specific properties only where the schema permits
  them (`generation` and `provenance` in v1).
- A breaking field or semantic change requires version 2 and a new schema.
- Consumers must reject unsupported major versions, not parse them as v1.
- Consumers should retain unknown future chord tokens as source text when
  migrating, but must not send an unknown token onto the live harmony bus.
- Pack manifests should preserve the sidecar filename and hash so assets can be
  revalidated after copying or upload.

## 15. Legacy LoopMaster outputs

The v1 writer applies to newly published assets. Existing LoopMaster folders do
not become conforming merely by adding JSON: legacy files may be IEEE float32,
use the old ACID field layout, have noncanonical names, and lack the structured
prompt/key/chord facts needed by this schema.

A migration must therefore create a new pair rather than mutate provenance in
place:

1. Decode the legacy WAV.
2. Re-encode PCM16 at 44.1 or 48 kHz.
3. Obtain/confirm pack, descriptor, key, kind, bars, variation, and any chord
   map; do not fabricate unknown values.
4. Write canonical ACID/cue/smpl/INFO/cKUP chunks.
5. Write and validate the adjacent v1 sidecar against the finalized WAV.
6. Preserve the original relative path and original SHA-256 in
   `generation.legacySource` or provenance.

Until that migration exists, a pack exporter should report “legacy output has
no v1 sidecar” and leave the source untouched. It must not silently publish an
incomplete v1 record.

## 16. Current implementation locations

- Canonical names, keys/chords, waveform analysis, slicer maps, and sidecar
  validation: [asset_contract.py](../loopmaster/loopmaster-app/asset_contract.py)
- Curated catalog resolution and rich chord events:
  [chord_progressions.py](../loopmaster/loopmaster-app/chord_progressions.py)
  with [chord_progressions.json](../loopmaster/loopmaster-app/static/chord_progressions.json)
- Embedded ACID/cue/smpl/LIST/cKUP writer:
  [wav_metadata.py](../loopmaster/loopmaster-app/wav_metadata.py)
- Atomic WAV-plus-sidecar publication:
  [app_server.py](../loopmaster/loopmaster-app/app_server.py)
- Machine-readable JSON Schema:
  [loopmaster-sidecar-schema-v1.json](loopmaster-sidecar-schema-v1.json)

This document supersedes the earlier sidecar-free recommendation in
[plan-loop-metadata-contract-2026-08-20.md](plan-loop-metadata-contract-2026-08-20.md).
The portable WAV fields remain
important, but the adjacent v1 sidecar is now the complete integration record.
