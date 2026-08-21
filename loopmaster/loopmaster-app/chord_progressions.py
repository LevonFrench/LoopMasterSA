"""Versioned four-chord preset catalog and deterministic key resolver."""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
import re

from asset_contract import normalize_key


CATALOG_PATH = Path(__file__).resolve().parent / "static" / "chord_progressions.json"
FLAT_ROOTS = ("c", "db", "d", "eb", "e", "f", "gb", "g", "ab", "a", "bb", "b")
ROOT_TO_PC = {root: index for index, root in enumerate(FLAT_ROOTS)}
DEGREE_OFFSETS = (0, 2, 4, 5, 7, 9, 11)
ROMAN_DEGREES = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7}
STRICT_KEY_PATTERN = re.compile(
    r"^([a-g])\s*(#|b|♯|♭|sharp|flat)?\s*(major|minor|maj|min)$",
    re.IGNORECASE,
)
QUALITY_INTERVALS = {
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
QUALITY_DISPLAY = {
    "maj": "", "min": "m", "dim": "dim", "aug": "aug", "sus2": "sus2",
    "sus4": "sus4", "maj6": "6", "min6": "m6", "maj7": "M7",
    "min7": "m7", "dom7": "7", "dim7": "dim7", "aug7": "aug7",
    "maj9": "M9", "min9": "m9", "dom9": "9", "min11": "m11",
    "dom11": "11", "dom13": "13", "min13": "m13", "majadd9": "add9",
    "minadd9": "madd9", "majadd11": "add11", "minadd11": "madd11",
    "dimaddaug5": "dim(add#5)", "min7aug5": "m7#5",
}


def _modulo(value: int, divisor: int) -> int:
    return ((value % divisor) + divisor) % divisor


def _root_display(root: str) -> str:
    return root[0].upper() + root[1:]


def _normalize_roman_text(value) -> str:
    return re.sub(
        r"\s+",
        "",
        str(value).strip()
        .replace("♭", "b")
        .replace("♯", "#")
        .replace("△", "Δ")
        .replace("º", "°"),
    )


def _parse_degree_root(value: str) -> dict:
    match = re.fullmatch(r"([b#]*)([ivIV]+)(.*)", value)
    if not match:
        raise ValueError(f"Invalid Roman chord '{value}'")
    roman = match.group(2)
    degree = ROMAN_DEGREES.get(roman.upper())
    if degree is None:
        raise ValueError(f"Unsupported Roman degree in '{value}'")
    alter = sum(1 if accidental == "#" else -1 for accidental in match.group(1))
    return {
        "degree": degree,
        "alter": alter,
        "uppercase": roman == roman.upper(),
        "suffix": match.group(3),
    }


def _quality_for_suffix(suffix: str, uppercase: bool) -> str:
    if not suffix:
        return "maj" if uppercase else "min"
    exact = {
        "°": "dim",
        "°add#5": "dimaddaug5",
        "aug": "aug",
        "aug7": "aug7",
        "sus2": "sus2",
        "sus4": "sus4",
        "Δ": "maj7",
        "M7": "maj7",
        "Δ9": "maj9",
        "M9": "maj9",
    }
    if suffix in exact:
        return exact[suffix]
    if suffix == "add6":
        return "maj6" if uppercase else "min6"
    if suffix == "add9":
        return "majadd9" if uppercase else "minadd9"
    if suffix == "add11":
        return "majadd11" if uppercase else "minadd11"
    if suffix == "7#5":
        return "aug7" if uppercase else "min7aug5"
    if suffix == "7":
        return "dom7" if uppercase else "min7"
    if suffix == "9":
        return "dom9" if uppercase else "min9"
    if suffix == "11":
        return "dom11" if uppercase else "min11"
    if suffix == "13":
        return "dom13" if uppercase else "min13"
    raise ValueError(f"Unsupported chord extension '{suffix}'")


def parse_roman_step(value) -> dict:
    roman = " ".join(str(value).split())
    normalized = _normalize_roman_text(roman)
    slash_parts = normalized.split("/")
    if len(slash_parts) > 2 or not slash_parts[0]:
        raise ValueError(f"Invalid slash-bass chord '{roman}'")
    root = _parse_degree_root(slash_parts[0])
    quality = _quality_for_suffix(root["suffix"], root["uppercase"])
    if quality not in QUALITY_INTERVALS:
        raise ValueError(f"Unsupported chord quality '{quality}'")
    bass = None
    if len(slash_parts) == 2 and slash_parts[1]:
        bass = _parse_degree_root(slash_parts[1])
        if bass["suffix"]:
            raise ValueError(f"Slash bass must be a scale degree in '{roman}'")
    return {
        "roman": roman,
        "degree": root["degree"],
        "alter": root["alter"],
        "quality": quality,
        "bass": bass,
    }


def resolve_step(step, tonic_pitch_class: int) -> dict:
    parsed = parse_roman_step(step) if isinstance(step, str) else dict(step)
    root_pc = _modulo(
        tonic_pitch_class + DEGREE_OFFSETS[parsed["degree"] - 1] + parsed["alter"],
        12,
    )
    root = FLAT_ROOTS[root_pc]
    intervals = QUALITY_INTERVALS[parsed["quality"]]
    bass = None
    bass_offset = None
    if parsed.get("bass"):
        bass_spec = parsed["bass"]
        bass_pc = _modulo(
            tonic_pitch_class + DEGREE_OFFSETS[bass_spec["degree"] - 1] + bass_spec["alter"],
            12,
        )
        bass = FLAT_ROOTS[bass_pc]
        bass_offset = _modulo(bass_pc - root_pc, 12)
    suffix = QUALITY_DISPLAY[parsed["quality"]]
    return {
        "roman": parsed["roman"],
        "chord": f"{root}_{parsed['quality']}",
        "symbol": f"{_root_display(root)}{suffix}"
        + (f"/{_root_display(bass)}" if bass else ""),
        "formulaOffsets": list(intervals),
        "bass": bass,
        "bassOffset": bass_offset,
    }


def _validate_catalog(catalog: dict) -> dict:
    entries = catalog.get("progressions") if isinstance(catalog, dict) else None
    if not isinstance(entries, list):
        raise ValueError("Chord progression catalog is invalid")
    ids = set()
    for entry in entries:
        entry_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(entry_id, str) or not entry_id or entry_id in ids:
            raise ValueError("Chord progression IDs must be unique")
        ids.add(entry_id)
        if entry.get("mode") not in {"major", "minor"}:
            raise ValueError(f"Progression {entry_id} has an invalid mode")
        steps = entry.get("steps")
        if not isinstance(steps, list) or len(steps) != 4:
            raise ValueError(f"Progression {entry_id} must contain exactly four chord slots")
        for step in steps:
            parse_roman_step(step)
    return catalog


@lru_cache(maxsize=1)
def load_catalog() -> dict:
    with CATALOG_PATH.open(encoding="utf-8") as catalog_file:
        return _validate_catalog(json.load(catalog_file))


def progression_selection(entry: dict) -> str:
    return f"{entry['formula']}: {entry['mood']}"


def find_progression(catalog_id: str, catalog: dict | None = None) -> dict | None:
    source = catalog or load_catalog()
    return next(
        (entry for entry in source["progressions"] if entry["id"] == catalog_id),
        None,
    )


def resolve_progression(catalog_id: str, key_value, bars: int = 4) -> dict:
    catalog = load_catalog()
    entry = find_progression(catalog_id, catalog)
    if entry is None:
        raise ValueError("Choose a chord progression preset")
    key_text = " ".join(str(key_value or "").split())
    key_info = normalize_key(key_text) if STRICT_KEY_PATTERN.fullmatch(key_text) else None
    if key_info is None:
        raise ValueError("Choose a major or minor key for the chord progressor")
    key_mode = "major" if key_info["token"].endswith("_maj") else "minor"
    if key_mode != entry["mode"]:
        raise ValueError(
            f"{entry['mood']} is a {entry['mode']} progression; "
            f"choose a {entry['mode']} key"
        )
    if isinstance(bars, bool) or not isinstance(bars, int) or bars < 1:
        raise ValueError("bars must be a positive integer")
    tonic_root = key_info["token"].rsplit("_", 1)[0]
    tonic_pc = ROOT_TO_PC[tonic_root]
    parsed_steps = [parse_roman_step(step) for step in entry["steps"]]
    cycle = [
        {
            "slot": index + 1,
            **resolve_step(step, tonic_pc),
        }
        for index, step in enumerate(parsed_steps)
    ]
    events = []
    for index in range(bars):
        events.append({
            "bar": index + 1,
            "beat": 1,
            **resolve_step(parsed_steps[index % len(parsed_steps)], tonic_pc),
        })
    return {
        "catalogId": entry["id"],
        "catalogVersion": int(catalog.get("catalogVersion", 1)),
        "mode": entry["mode"],
        "mood": entry["mood"],
        "formula": entry["formula"],
        "selection": progression_selection(entry),
        "key": key_info["display"],
        "cycleBars": 4,
        "cycle": cycle,
        "events": events,
        "chordTrack": ", ".join(
            f"{event['chord']}@{event['bar']}:1" for event in events
        ),
    }


def condition_prompt(prompt: str, resolution: dict) -> str:
    """Append the server-resolved harmony instructions sent to the model.

    The UI-facing composed prompt deliberately remains unchanged.  This
    second prompt is generated only from the trusted catalog resolution so a
    client cannot substitute different chord symbols while retaining a valid
    catalog ID.
    """
    base_prompt = " ".join(str(prompt or "").split())
    cycle = resolution.get("cycle") or resolution.get("events", [])[:4]
    if len(cycle) != 4:
        raise ValueError("A conditioned chord progression requires four chord slots")
    symbols = " - ".join(str(event["symbol"]) for event in cycle)
    bar_count = len(resolution.get("events") or [])
    instruction = (
        f"harmonic progression locked to {symbols}, one chord per bar, "
        f"repeat this exact four-bar cycle through {bar_count} bars"
    )
    return ", ".join(filter(None, (base_prompt, instruction)))


def canonical_chord_events(resolution: dict) -> tuple[dict, ...]:
    return tuple(
        {
            "bar": event["bar"],
            "beat": event["beat"],
            "chord": event["chord"],
            "roman": event["roman"],
            "symbol": event["symbol"],
            "formulaOffsets": list(event["formulaOffsets"]),
            "bass": event["bass"],
            "bassOffset": event["bassOffset"],
        }
        for event in resolution.get("events", [])
    )
