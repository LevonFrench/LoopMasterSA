"""Canonical LoopMaster filenames and adjacent per-audio metadata.

The ``.meta.json`` file is the complete, versioned source of truth.  WAV chunks
duplicate only the fields that existing DAWs and samplers understand.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
import os
import re
import unicodedata

import torch


SCHEMA_ID = "com.loopmaster.loop-meta"
SCHEMA_VERSION = 1
SIDECAR_SCHEMA_URL = "https://schemas.loopmaster.app/loop-meta/v1.json"
SIDECAR_SUFFIX = ".meta.json"
DEFAULT_PACK = "loopmaster"
DEFAULT_DESCRIPTOR = "loop"
DEFAULT_LICENSE = (
    "sa3-generated; license per Stable Audio terms; local-test until reviewed"
)
GENERATOR_NAME = "LoopMaster SA3"

_FLAT_ROOTS = ("c", "db", "d", "eb", "e", "f", "gb", "g", "ab", "a", "bb", "b")
_PITCH_CLASS = {root: index for index, root in enumerate(_FLAT_ROOTS)}
_SHARP_TO_FLAT = {
    "c#": "db",
    "d#": "eb",
    "f#": "gb",
    "g#": "ab",
    "a#": "bb",
}
_KEY_PATTERN = re.compile(
    r"(?i)\b([a-g])\s*(#|b|♯|♭|sharp|flat)?\s*(major|minor|maj|min)\b"
)
_VARIATION_PATTERN = re.compile(r"^[a-z][1-9][0-9]*$")
CHORD_INTERVALS = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "dim": (0, 3, 6),
    "aug": (0, 4, 8),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
    "maj6": (0, 4, 7, 9),
    "min6": (0, 3, 7, 9),
    "maj7": (0, 4, 7, 11),
    "min7": (0, 3, 7, 10),
    "dom7": (0, 4, 7, 10),
    "dim7": (0, 3, 6, 9),
    "aug7": (0, 4, 8, 10),
    "maj9": (0, 4, 7, 11, 14),
    "min9": (0, 3, 7, 10, 14),
    "dom9": (0, 4, 7, 10, 14),
    "min11": (0, 3, 7, 10, 14, 17),
    "dom11": (0, 4, 7, 10, 14, 17),
    "dom13": (0, 4, 7, 10, 14, 17, 21),
    "min13": (0, 3, 7, 10, 14, 17, 21),
    "majadd9": (0, 4, 7, 14),
    "minadd9": (0, 3, 7, 14),
    "majadd11": (0, 4, 7, 17),
    "minadd11": (0, 3, 7, 17),
    "dimaddaug5": (0, 3, 6, 8),
    "min7aug5": (0, 3, 8, 10),
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sidecar_path_for(wav_path: str) -> str:
    stem, _extension = os.path.splitext(wav_path)
    return stem + SIDECAR_SUFFIX


def slug_token(value, fallback: str, limit: int = 64) -> str:
    """Collapse one logical filename field to an unambiguous ASCII token."""
    text = "" if value is None else str(value)
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    token = re.sub(r"[^a-z0-9]+", "", ascii_text.lower())[:limit]
    if token:
        return token
    fallback_token = re.sub(r"[^a-z0-9]+", "", fallback.lower())[:limit]
    return fallback_token or "asset"


def _flat_root(letter: str, accidental: str | None = None) -> str:
    accidental = (accidental or "").lower()
    if accidental in {"sharp", "♯"}:
        accidental = "#"
    elif accidental in {"flat", "♭"}:
        accidental = "b"
    spelled = letter.lower() + accidental
    if spelled in _SHARP_TO_FLAT:
        return _SHARP_TO_FLAT[spelled]
    if spelled in _PITCH_CLASS:
        return spelled
    # Cb/Fb/E#/B# are uncommon but valid input. Normalize by pitch class.
    natural_pc = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}[letter.lower()]
    delta = 1 if accidental == "#" else (-1 if accidental == "b" else 0)
    return _FLAT_ROOTS[(natural_pc + delta) % 12]


def normalize_key(value) -> dict | None:
    """Return filename, machine, display, and MIDI forms for a major/minor key."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() in {"none", "skip", "nokey", "unknown"}:
        return None
    match = _KEY_PATTERN.search(text)
    if not match:
        return None
    root = _flat_root(match.group(1), match.group(2))
    quality = match.group(3).lower()
    quality = "maj" if quality in {"major", "maj"} else "min"
    quality_display = "major" if quality == "maj" else "minor"
    root_display = root[0].upper() + root[1:]
    return {
        "token": f"{root}_{quality}",
        "filename": f"{root}{quality}",
        "display": f"{root_display} {quality_display}",
        "rootMidi": 60 + _PITCH_CLASS[root],
    }


def normalize_chord_token(value) -> str:
    """Normalize a user chord such as ``F#min7`` to ``gb_min7``."""
    text = str(value).strip().lower()
    match = re.match(r"^([a-g])\s*(#|b|♯|♭|sharp|flat)?[\s_-]*(.+?)\s*$", text)
    if not match:
        raise ValueError(f"Invalid chord '{value}'")
    root = _flat_root(match.group(1), match.group(2))
    quality = re.sub(r"[\s_-]+", "", match.group(3))
    quality = quality.replace("major", "maj").replace("minor", "min")
    quality = quality.replace("dominant", "dom")

    if quality not in CHORD_INTERVALS:
        raise ValueError(f"Unsupported chord quality in '{value}'")
    return f"{root}_{quality}"


def parse_chord_track(value, bars: int | None, meter_numerator: int = 4) -> list[dict]:
    """Parse ``c_min@1:1, ab_maj@3:1`` into a validated musical timeline."""
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        raw_entries = value
    elif isinstance(value, str):
        raw_entries = [entry.strip() for entry in re.split(r"[,;\n]+", value) if entry.strip()]
    else:
        raise ValueError("chord_track must be text or a list")

    parsed = []
    detail_keys = {
        "roman", "symbol", "formulaOffsets", "bass", "bassOffset"
    }
    for raw in raw_entries:
        if isinstance(raw, dict):
            unknown = set(raw) - ({"bar", "beat", "chord"} | detail_keys)
            if unknown:
                raise ValueError(
                    f"Unknown chord event field '{sorted(unknown)[0]}'"
                )
            chord_value = raw.get("chord")
            bar_value = raw.get("bar")
            beat_value = raw.get("beat")
        else:
            match = re.match(r"^(.+?)\s*@\s*(\d+)\s*[:.]\s*(\d+)\s*$", str(raw))
            if not match:
                raise ValueError(
                    "Chord entries must use chord@bar:beat, for example c_min@1:1"
                )
            chord_value, bar_value, beat_value = match.groups()
        try:
            bar = int(bar_value)
            beat = int(beat_value)
        except (TypeError, ValueError):
            raise ValueError("Chord bar and beat positions must be integers") from None
        if bar < 1 or (bars is not None and bar > bars):
            raise ValueError(f"Chord bar {bar} is outside this {bars or 0}-bar asset")
        if beat < 1 or beat > meter_numerator:
            raise ValueError(f"Chord beat must be between 1 and {meter_numerator}")
        event = {
            "bar": bar,
            "beat": beat,
            "chord": normalize_chord_token(chord_value),
        }
        if isinstance(raw, dict):
            for text_field in ("roman", "symbol"):
                if text_field not in raw:
                    continue
                text_value = raw[text_field]
                if not isinstance(text_value, str) or not text_value.strip():
                    raise ValueError(
                        f"Chord event {text_field} must be non-empty text"
                    )
                event[text_field] = " ".join(text_value.split())
            if "formulaOffsets" in raw:
                offsets = raw["formulaOffsets"]
                if (
                    not isinstance(offsets, (list, tuple))
                    or len(offsets) < 3
                    or any(
                        isinstance(offset, bool)
                        or not isinstance(offset, int)
                        or offset < 0
                        for offset in offsets
                    )
                ):
                    raise ValueError(
                        "Chord event formulaOffsets must contain pitch intervals"
                    )
                event["formulaOffsets"] = list(offsets)
            if "bass" in raw:
                bass = raw["bass"]
                if bass is not None and (
                    not isinstance(bass, str) or bass.lower() not in _PITCH_CLASS
                ):
                    raise ValueError("Chord event bass must be a canonical flat root")
                event["bass"] = bass.lower() if isinstance(bass, str) else None
            if "bassOffset" in raw:
                bass_offset = raw["bassOffset"]
                if bass_offset is not None and (
                    isinstance(bass_offset, bool)
                    or not isinstance(bass_offset, int)
                    or not 0 <= bass_offset <= 11
                ):
                    raise ValueError(
                        "Chord event bassOffset must be between 0 and 11"
                    )
                event["bassOffset"] = bass_offset
            if (
                (event.get("bass") is None) !=
                (event.get("bassOffset") is None)
            ):
                raise ValueError("Chord event bass and bassOffset must agree")
        parsed.append(event)

    parsed.sort(key=lambda item: (item["bar"], item["beat"]))
    if parsed and (parsed[0]["bar"], parsed[0]["beat"]) != (1, 1):
        raise ValueError("The first chord entry must start at bar 1 beat 1")
    positions = [(item["bar"], item["beat"]) for item in parsed]
    if len(positions) != len(set(positions)):
        raise ValueError("Chord entries cannot share the same bar and beat")
    return parsed


def derive_descriptor(explicit, prompt_sections=None, prompt="") -> str:
    if explicit is not None and str(explicit).strip():
        return slug_token(explicit, DEFAULT_DESCRIPTOR)
    sections = prompt_sections if isinstance(prompt_sections, dict) else {}
    source_keys = ("acoustic", "electric", "drums")
    source_choice = sections.get("sourceChoice")
    if source_choice in source_keys:
        active_source = sections.get(source_choice)
        if isinstance(active_source, str) and active_source.strip():
            return slug_token(active_source, DEFAULT_DESCRIPTOR)
    else:
        populated_sources = [
            sections.get(key)
            for key in source_keys
            if isinstance(sections.get(key), str) and sections[key].strip()
        ]
        if len(populated_sources) == 1:
            return slug_token(populated_sources[0], DEFAULT_DESCRIPTOR)
    for key in ("instrument", "style", "genre", "mood"):
        value = sections.get(key)
        if isinstance(value, str) and value.strip():
            return slug_token(value, DEFAULT_DESCRIPTOR)
    words = " ".join(str(prompt).split()[:6])
    return slug_token(words, DEFAULT_DESCRIPTOR)


def musical_grid(frame_count: int, sample_rate: int, bpm: int | float, loop: bool) -> dict:
    if frame_count <= 0 or sample_rate <= 0:
        raise ValueError("Audio must contain at least one sample at a positive sample rate")
    duration = frame_count / float(sample_rate)
    if not loop:
        return {
            "bpm": None,
            "meter": {"numerator": 4, "denominator": 4},
            "beats": None,
            "bars": None,
            "gridErrorBeats": None,
            "durationSeconds": duration,
        }
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)):
        raise ValueError("Loop BPM must be a positive whole number")
    bpm_value = float(bpm)
    if not math.isfinite(bpm_value) or bpm_value <= 0 or not bpm_value.is_integer():
        raise ValueError("Loop BPM must be positive")
    bpm_value = int(bpm_value)
    exact_beats = duration * bpm_value / 60.0
    beats = int(round(exact_beats))
    error = abs(exact_beats - beats)
    if beats <= 0 or error > 0.03:
        raise ValueError(
            f"Audio length is off the {bpm_value} BPM grid by {error:.4f} beats (maximum 0.03)"
        )
    if beats % 4:
        raise ValueError("Loop length must be a whole number of 4/4 bars")
    return {
        "bpm": bpm_value,
        "meter": {"numerator": 4, "denominator": 4},
        "beats": beats,
        "bars": beats // 4,
        "gridErrorBeats": error,
        "durationSeconds": duration,
    }


def build_asset_filename(
    *, pack, descriptor, bpm, key, bars, variation, kind="loop"
) -> str:
    pack_token = slug_token(pack, DEFAULT_PACK)
    descriptor_token = slug_token(descriptor, DEFAULT_DESCRIPTOR)
    if not _VARIATION_PATTERN.fullmatch(str(variation)):
        raise ValueError("variation must look like a1, b2, or c12")
    key_info = normalize_key(key) if not isinstance(key, dict) else key
    key_token = key_info["filename"] if key_info else "nokey"
    if kind == "oneshot":
        return f"{pack_token}_{descriptor_token}_oneshot_{key_token}_{variation}.wav"
    if kind != "loop":
        raise ValueError("kind must be loop or oneshot")
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)):
        raise ValueError("Loop filenames require a positive whole-number BPM")
    bpm_value = float(bpm)
    if not math.isfinite(bpm_value) or bpm_value <= 0 or not bpm_value.is_integer():
        raise ValueError("Loop filenames require a positive BPM")
    if isinstance(bars, bool) or not isinstance(bars, int) or bars <= 0:
        raise ValueError("Loop filenames require a positive bar count")
    return (
        f"{pack_token}_{descriptor_token}_{int(bpm_value)}bpm_"
        f"{key_token}_{bars}bar_{variation}.wav"
    )


def variation_slot(index: int) -> str:
    if index < 0 or index >= 26:
        raise ValueError("variant index must be between 0 and 25")
    return chr(ord("a") + index)


def _preferred_slices(beat_points, transient_points, frame_count):
    source = transient_points if len(transient_points) >= 2 else beat_points
    internal = [deepcopy(point) for point in source if 0 < point["sample"] < frame_count]
    if len(internal) > 15 and source is transient_points:
        return sorted(
            sorted(internal, key=lambda point: (-point["strength"], point["sample"]))[:15],
            key=lambda point: point["sample"],
        )
    if len(internal) > 15:
        candidate_count = len(internal)
        return [
            internal[round(rank * (candidate_count + 1) / 16) - 1]
            for rank in range(1, 16)
        ]
    return internal


def analyze_waveform(waveform, sample_rate: int, beat_count: int | None = None) -> dict:
    """Return 64 display peaks plus beat and transient slicer points."""
    audio = waveform.detach().to(device="cpu", dtype=torch.float32)
    if audio.ndim == 1:
        audio = audio.unsqueeze(0)
    if audio.ndim != 2 or audio.shape[-1] <= 0:
        raise ValueError("waveform must have shape [channels, frames]")
    if not bool(torch.isfinite(audio).all()):
        raise ValueError("waveform contains NaN or infinity")
    # The WAV writer quantizes/clips to PCM16. Analyze the same bounded signal
    # so peaks and slicer strength describe the bytes consumers will receive.
    audio = audio.clamp(-1.0, 1.0)
    mono = audio.abs().mean(dim=0)
    frame_count = int(mono.numel())

    peak_values = []
    for index in range(64):
        start = min(frame_count - 1, (index * frame_count) // 64)
        end = min(frame_count, max(start + 1, ((index + 1) * frame_count) // 64))
        peak_values.append(round(float(mono[start:end].max().item()), 6))

    beat_points = []
    if beat_count:
        for index in range(int(beat_count)):
            sample = min(frame_count - 1, int(round(index * frame_count / beat_count)))
            beat_points.append({
                "id": f"beat_{index + 1}",
                "kind": "beat",
                "sample": sample,
                "seconds": sample / float(sample_rate),
                "bar": (index // 4) + 1,
                "beat": (index % 4) + 1,
            })

    # Lightweight onset detector: positive changes in short-window peak energy,
    # local-max filtered with an 80 ms refractory period.  It deliberately
    # favors a small useful map over dozens of nearly-identical markers.
    window = max(64, int(round(sample_rate * 0.01)))
    window_count = math.ceil(frame_count / window)
    padded_count = window_count * window
    if padded_count != frame_count:
        mono = torch.nn.functional.pad(mono, (0, padded_count - frame_count))
    envelope = mono.reshape(window_count, window).amax(dim=1)
    flux = torch.zeros_like(envelope)
    flux[0] = envelope[0]
    if envelope.numel() > 1:
        flux[1:] = torch.clamp(envelope[1:] - envelope[:-1], min=0)
    positive = flux[flux > 0]
    transient_points = []
    if positive.numel():
        # Estimate the floor over ALL windows, including quiet windows. Using
        # only positive attacks makes a rising six-hit sheet classify its soft
        # authored hits as noise. The 95th percentile still suppresses dense,
        # low-level motion in continuously active material.
        median = torch.median(flux)
        mad = torch.median(torch.abs(flux - median))
        threshold = max(float(median + 3.0 * mad), float(torch.quantile(flux, 0.95)))
        min_windows = max(1, int(round(0.08 * sample_rate / window)))
        last_index = -min_windows
        candidates = []
        for index in range(int(flux.numel())):
            value = float(flux[index])
            previous = float(flux[index - 1]) if index > 0 else float("-inf")
            following = float(flux[index + 1]) if index + 1 < flux.numel() else float("-inf")
            if value <= 0 or value < threshold or value < previous or value < following:
                continue
            if index - last_index < min_windows:
                if candidates and value > candidates[-1][1]:
                    candidates[-1] = (index, value)
                    last_index = index
                continue
            candidates.append((index, value))
            last_index = index
        for number, (index, strength) in enumerate(candidates[:128], start=1):
            sample = min(frame_count - 1, index * window)
            transient_points.append({
                "id": f"tx_{number}",
                "kind": "transient",
                "sample": sample,
                "seconds": sample / float(sample_rate),
                "strength": round(strength, 6),
            })

    # Roblox's current deck exposes 16 pads, so its ready-to-use map may carry
    # at most 15 INTERNAL boundaries. Full-resolution catalogs remain above.
    preferred = _preferred_slices(beat_points, transient_points, frame_count)
    return {
        "peaks": peak_values,
        "slices": {
            "unit": "samples",
            "beatGrid": beat_points,
            "transients": transient_points,
            "preferred": deepcopy(preferred),
        },
    }


def build_sidecar_document(
    *, file_name: str, waveform, sample_rate: int, bpm, kind: str,
    pack, descriptor, variation: str, key=None, chords=None,
    chord_source=None, generation=None, provenance=None, created_at=None,
) -> dict:
    if kind not in {"loop", "oneshot"}:
        raise ValueError("kind must be loop or oneshot")
    if int(sample_rate) not in {44_100, 48_000}:
        raise ValueError("LoopMaster assets must use a 44.1 kHz or 48 kHz sample rate")
    frame_count = int(waveform.shape[-1])
    grid = musical_grid(frame_count, sample_rate, bpm, kind == "loop")
    key_info = normalize_key(key) if not isinstance(key, dict) else deepcopy(key)
    chord_entries = parse_chord_track(chords or [], grid["bars"])
    resolved_chord_source = chord_source
    if chord_entries and resolved_chord_source is None:
        # Backward-compatible default for the legacy manual chord_track field.
        resolved_chord_source = "user"
    if resolved_chord_source not in {
        None, "user", "prompt", "analyzed", "imported"
    }:
        raise ValueError("chord_source is invalid")
    if not chord_entries and resolved_chord_source is not None:
        raise ValueError("Empty chord tracks cannot claim a chord source")
    if kind == "oneshot" and any(
        (entry["bar"], entry["beat"]) != (1, 1) for entry in chord_entries
    ):
        raise ValueError("One-shot chord metadata can only start at bar 1 beat 1")
    analysis = analyze_waveform(waveform, sample_rate, grid["beats"])
    created = created_at or utc_now_iso()
    stem = os.path.splitext(file_name)[0]
    metadata_name = stem + SIDECAR_SUFFIX
    channels = int(waveform.shape[0]) if waveform.ndim > 1 else 1
    loop_region = None
    if kind == "loop":
        loop_region = {
            "startSample": 0,
            "endSampleInclusive": frame_count - 1,
            "endSampleExclusive": frame_count,
            "startSeconds": 0.0,
            "endSeconds": frame_count / float(sample_rate),
        }
    document = {
        "$schema": SIDECAR_SCHEMA_URL,
        "schema": SCHEMA_ID,
        "version": SCHEMA_VERSION,
        "id": stem,
        "file": file_name,
        "metadataFile": metadata_name,
        "kind": kind,
        "naming": {
            "pack": slug_token(pack, DEFAULT_PACK),
            "descriptor": slug_token(descriptor, DEFAULT_DESCRIPTOR),
            "variation": variation,
        },
        "audio": {
            "format": "wav",
            "encoding": "pcm_s16le",
            "sampleRate": int(sample_rate),
            "channels": channels,
            "bitDepth": 16,
            "frames": frame_count,
            "durationSeconds": frame_count / float(sample_rate),
            "sha256": None,
            "bytes": None,
        },
        "musical": {
            "bpm": grid["bpm"],
            "meter": grid["meter"],
            "beats": grid["beats"],
            "bars": grid["bars"],
            "gridErrorBeats": grid["gridErrorBeats"],
            "key": key_info,
            "chords": chord_entries,
            "chordSource": resolved_chord_source,
            # Prompt-following is not acoustic verification. A future analyzer
            # may set this true after confirming the rendered harmony.
            "chordsVerified": False,
        },
        "loopRegion": loop_region,
        "waveform": {"peaks": analysis["peaks"]},
        "slices": analysis["slices"],
        "generation": deepcopy(generation or {}),
        "provenance": {
            "generator": GENERATOR_NAME,
            "createdAt": created,
            "license": DEFAULT_LICENSE,
            **deepcopy(provenance or {}),
        },
        "embedded": {
            "acid": True,
            "cue": bool(analysis["slices"]["beatGrid"] or analysis["slices"]["transients"]),
            "smpl": kind == "loop",
            "listInfo": True,
            "ckup": True,
        },
    }
    return document


def finalize_sidecar_for_wav(
    document: dict,
    wav_path: str,
    sha256: str | None = None,
    size_bytes: int | None = None,
) -> dict:
    """Stamp integrity fields, reusing a precomputed digest/size when supplied.

    Writers that already hold the final WAV bytes in memory (acidize_wav_file)
    pass both values to avoid re-reading the file they just wrote.
    """
    result = deepcopy(document)
    result["audio"]["sha256"] = sha256 if sha256 is not None else _sha256_file(wav_path)
    result["audio"]["bytes"] = (
        int(size_bytes) if size_bytes is not None else os.path.getsize(wav_path)
    )
    return result


def write_sidecar(path: str, document: dict) -> None:
    validate_sidecar(document)
    payload = json.dumps(
        document,
        indent=2,
        ensure_ascii=False,
        sort_keys=True,
        allow_nan=False,
    ) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as metadata_file:
        metadata_file.write(payload)


def validate_sidecar(document: dict, wav_path: str | None = None) -> None:
    if not isinstance(document, dict):
        raise ValueError("Metadata must be a JSON object")
    required = {
        "$schema", "schema", "version", "id", "file", "metadataFile", "kind",
        "naming", "audio", "musical", "loopRegion", "waveform", "slices",
        "generation", "provenance", "embedded",
    }
    if set(document) != required:
        raise ValueError("Metadata top-level fields do not match the v1 contract")
    if document.get("$schema") != SIDECAR_SCHEMA_URL:
        raise ValueError("Metadata does not reference the LoopMaster v1 schema")
    if document.get("schema") != SCHEMA_ID or document.get("version") != SCHEMA_VERSION:
        raise ValueError("Unsupported LoopMaster metadata schema")
    kind = document.get("kind")
    if kind not in {"loop", "oneshot"}:
        raise ValueError("Metadata kind must be loop or oneshot")
    file_name = document.get("file")
    if not isinstance(file_name, str) or not file_name.endswith(".wav"):
        raise ValueError("Metadata must reference one WAV file")
    stem = os.path.splitext(file_name)[0]
    if document.get("id") != stem:
        raise ValueError("Metadata id must equal the WAV stem")
    if document.get("metadataFile") != stem + SIDECAR_SUFFIX:
        raise ValueError("Metadata sidecar filename must equal the WAV stem")
    naming = document.get("naming") or {}
    if set(naming) != {"pack", "descriptor", "variation"}:
        raise ValueError("Metadata naming fields do not match the v1 contract")
    for field in ("pack", "descriptor"):
        token = naming.get(field)
        if (
            not isinstance(token, str)
            or not re.fullmatch(r"[a-z0-9]{1,64}", token)
            or slug_token(token, "invalid") != token
        ):
            raise ValueError(f"Metadata naming.{field} is not canonical")
    variation = naming.get("variation")
    if not isinstance(variation, str) or not _VARIATION_PATTERN.fullmatch(variation):
        raise ValueError("Metadata variation is not canonical")
    musical = document.get("musical") or {}
    if musical.get("meter") != {"numerator": 4, "denominator": 4}:
        raise ValueError("Metadata meter must be 4/4 in v1")
    key_info = musical.get("key")
    if key_info is not None:
        if not isinstance(key_info, dict):
            raise ValueError("Metadata key must be an object or null")
        canonical_key = normalize_key(key_info.get("display"))
        if canonical_key is None or key_info != canonical_key:
            raise ValueError("Metadata key representations disagree")
    expected_file = build_asset_filename(
        pack=naming.get("pack"),
        descriptor=naming.get("descriptor"),
        bpm=musical.get("bpm"),
        key=key_info,
        bars=musical.get("bars"),
        variation=variation,
        kind=kind,
    )
    if file_name != expected_file:
        raise ValueError("Metadata fields do not reconstruct the canonical filename")
    audio = document.get("audio") or {}
    if (
        audio.get("format") != "wav"
        or audio.get("bitDepth") != 16
        or audio.get("encoding") != "pcm_s16le"
    ):
        raise ValueError("LoopMaster assets must be PCM16 WAV files")
    if audio.get("sampleRate") not in {44_100, 48_000}:
        raise ValueError("LoopMaster assets must use a 44.1 kHz or 48 kHz sample rate")
    frame_count = audio.get("frames")
    if isinstance(frame_count, bool) or not isinstance(frame_count, int) or frame_count <= 0:
        raise ValueError("Metadata audio.frames must be a positive integer")
    channels = audio.get("channels")
    if isinstance(channels, bool) or not isinstance(channels, int) or not 1 <= channels <= 8:
        raise ValueError("Metadata audio.channels is invalid")
    duration = audio.get("durationSeconds")
    expected_duration = frame_count / float(audio["sampleRate"])
    if not _finite_number(duration) or not math.isclose(duration, expected_duration, abs_tol=1e-9):
        raise ValueError("Metadata audio duration does not match frames/sampleRate")
    if not isinstance(audio.get("sha256"), str) or not re.fullmatch(
        r"[a-f0-9]{64}", audio["sha256"]
    ):
        raise ValueError("Metadata must contain the finalized WAV SHA-256")
    if isinstance(audio.get("bytes"), bool) or not isinstance(audio.get("bytes"), int) or audio["bytes"] < 44:
        raise ValueError("Metadata must contain the finalized WAV byte size")
    peaks = (document.get("waveform") or {}).get("peaks")
    if not isinstance(peaks, list) or len(peaks) != 64 or any(
        not _finite_number(value) or value < 0 or value > 1
        for value in peaks
    ):
        raise ValueError("Metadata must contain exactly 64 waveform peaks in the 0..1 range")
    slices = document.get("slices") or {}
    if slices.get("unit") != "samples":
        raise ValueError("Metadata slicer unit must be sample frames")
    for group in ("beatGrid", "transients", "preferred"):
        points = slices.get(group)
        if not isinstance(points, list):
            raise ValueError(f"Metadata {group} slicer map must be a list")
        samples = []
        ids = []
        for point in points:
            if not isinstance(point, dict):
                raise ValueError(f"Invalid {group} slicer point")
            sample = point.get("sample")
            if isinstance(sample, bool) or not isinstance(sample, int) or sample < 0 or sample >= frame_count:
                raise ValueError(f"Invalid {group} slicer sample {sample}")
            seconds = point.get("seconds")
            if not _finite_number(seconds) or not math.isclose(
                seconds, sample / float(audio["sampleRate"]), abs_tol=1e-9
            ):
                raise ValueError(f"Invalid {group} slicer time")
            samples.append(sample)
            ids.append(point.get("id"))
        if samples != sorted(samples) or len(samples) != len(set(samples)):
            raise ValueError(f"Metadata {group} slicer points must be sorted and unique")
        if len(ids) != len(set(ids)) or any(not isinstance(point_id, str) for point_id in ids):
            raise ValueError(f"Metadata {group} slicer IDs must be unique strings")

    beat_grid = slices["beatGrid"]
    transients = slices["transients"]
    preferred = slices["preferred"]
    for index, point in enumerate(transients, start=1):
        if set(point) != {"id", "kind", "sample", "seconds", "strength"}:
            raise ValueError("Transient slicer point fields are not canonical")
        if point["id"] != f"tx_{index}" or point["kind"] != "transient":
            raise ValueError("Transient slicer IDs/kinds are not canonical")
        if not _finite_number(point["strength"]) or point["strength"] < 0:
            raise ValueError("Transient slicer strength is invalid")
    if len(preferred) > 15 or any(point["sample"] == 0 for point in preferred):
        raise ValueError("Preferred slicer map must contain at most 15 internal boundaries")
    if preferred != _preferred_slices(beat_grid, transients, frame_count):
        raise ValueError("Preferred slicer map does not match the v1 selection rule")

    loop_region = document.get("loopRegion")
    if kind == "loop":
        bpm = musical.get("bpm")
        beats = musical.get("beats")
        bars = musical.get("bars")
        if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in (bpm, beats, bars)):
            raise ValueError("Loop musical grid must use positive whole numbers")
        if beats != bars * 4 or len(beat_grid) != beats:
            raise ValueError("Loop beats, bars, and beat slicer grid disagree")
        grid_error = musical.get("gridErrorBeats")
        if not _finite_number(grid_error) or not 0 <= grid_error <= 0.03:
            raise ValueError("Loop grid error is outside the v1 tolerance")
        for index, point in enumerate(beat_grid):
            expected_sample = min(frame_count - 1, int(round(index * frame_count / beats)))
            if point != {
                "id": f"beat_{index + 1}",
                "kind": "beat",
                "sample": expected_sample,
                "seconds": expected_sample / float(audio["sampleRate"]),
                "bar": (index // 4) + 1,
                "beat": (index % 4) + 1,
            }:
                raise ValueError("Loop beat slicer grid is not canonical")
        if not isinstance(loop_region, dict) or loop_region != {
            "startSample": 0,
            "endSampleInclusive": frame_count - 1,
            "endSampleExclusive": frame_count,
            "startSeconds": 0.0,
            "endSeconds": expected_duration,
        }:
            raise ValueError("Loop region does not cover the finalized WAV")
    else:
        for field in ("bpm", "beats", "bars", "gridErrorBeats"):
            if musical.get(field) is not None:
                raise ValueError("One-shot musical grid fields must be null")
        if loop_region is not None or beat_grid:
            raise ValueError("One-shots cannot contain a loop region or beat grid")

    chords = musical.get("chords")
    if not isinstance(chords, list):
        raise ValueError("Metadata chord track must be a list")
    for entry in chords:
        required_chord_fields = {"bar", "beat", "chord"}
        allowed_chord_fields = required_chord_fields | {
            "roman", "symbol", "formulaOffsets", "bass", "bassOffset"
        }
        if (
            not isinstance(entry, dict)
            or not required_chord_fields.issubset(entry)
            or not set(entry).issubset(allowed_chord_fields)
        ):
            raise ValueError("Metadata chord event fields are not canonical")
        if any(
            isinstance(entry.get(field), bool) or not isinstance(entry.get(field), int)
            for field in ("bar", "beat")
        ):
            raise ValueError("Metadata chord positions must be integers")
    expected_chords = parse_chord_track(chords, musical.get("bars"))
    if chords != expected_chords:
        raise ValueError("Metadata chord track is not canonical")
    if kind == "oneshot" and any(
        (entry["bar"], entry["beat"]) != (1, 1) for entry in chords
    ):
        raise ValueError("One-shot chord metadata can only start at bar 1 beat 1")
    chord_source = musical.get("chordSource")
    chords_verified = musical.get("chordsVerified")
    if chords and chord_source not in {"user", "prompt", "analyzed", "imported"}:
        raise ValueError("Metadata chord source/verification flags disagree")
    if not chords and (chord_source is not None or chords_verified is not False):
        raise ValueError("Empty chord tracks cannot claim a source or verification")
    if not isinstance(chords_verified, bool):
        raise ValueError("Metadata chordsVerified must be boolean")

    embedded = document.get("embedded") or {}
    if set(embedded) != {"acid", "cue", "smpl", "listInfo", "ckup"}:
        raise ValueError("Metadata embedded fields do not match the v1 contract")
    if embedded.get("acid") is not True or embedded.get("listInfo") is not True or embedded.get("ckup") is not True:
        raise ValueError("Metadata embedded-chunk claims are incomplete")
    if embedded.get("smpl") is not (kind == "loop"):
        raise ValueError("Metadata smpl claim disagrees with asset kind")
    expected_cue = bool(beat_grid or transients)
    if embedded.get("cue") is not expected_cue:
        raise ValueError("Metadata cue claim disagrees with slicer catalogs")

    provenance = document.get("provenance") or {}
    if any(not isinstance(provenance.get(field), str) or not provenance[field] for field in ("generator", "createdAt", "license")):
        raise ValueError("Metadata provenance is incomplete")
    if wav_path is not None:
        if os.path.basename(wav_path) != file_name:
            raise ValueError("Metadata filename does not match the WAV")
        actual = _sha256_file(wav_path)
        if actual != audio.get("sha256"):
            raise ValueError("Metadata SHA-256 does not match the WAV")
        if os.path.getsize(wav_path) != audio.get("bytes"):
            raise ValueError("Metadata byte count does not match the WAV")


def _finite_number(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
