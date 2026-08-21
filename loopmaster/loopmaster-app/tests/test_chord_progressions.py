from dataclasses import FrozenInstanceError

import pytest

from chord_progressions import (
    condition_prompt,
    parse_roman_step,
    resolve_progression,
)
from generation_executor import ProgressionProvenance


def test_catalog_resolution_repeats_exact_four_chord_cycle_to_requested_bars():
    resolution = resolve_progression(
        "major_hopeful_01",
        "F♯ major",
        bars=8,
    )

    assert resolution["key"] == "Gb major"
    assert resolution["cycleBars"] == 4
    assert len(resolution["cycle"]) == 4
    expected_cycle = ["gb_maj", "db_maj", "eb_min", "b_maj"]
    assert [event["chord"] for event in resolution["cycle"]] == expected_cycle
    assert [event["chord"] for event in resolution["events"]] == (
        expected_cycle + expected_cycle
    )
    assert [(event["bar"], event["beat"]) for event in resolution["events"]] == [
        (bar, 1) for bar in range(1, 9)
    ]


def test_conditioned_prompt_contains_authoritative_cycle_and_requested_length():
    resolution = resolve_progression("major_hopeful_01", "C major", bars=8)

    conditioned = condition_prompt("warm house piano", resolution)

    assert conditioned.startswith("warm house piano, harmonic progression locked to")
    assert "C - G - Am - F" in conditioned
    assert "one chord per bar" in conditioned
    assert "through 8 bars" in conditioned


def test_progression_provenance_is_deeply_immutable_and_round_trips():
    resolution = resolve_progression("minor_dark_01", "C minor", bars=4)
    provenance = ProgressionProvenance.from_resolution(resolution)

    with pytest.raises(FrozenInstanceError):
        provenance.catalog_id = "changed"
    with pytest.raises(TypeError):
        provenance.cycle[0][0] = 9

    restored = provenance.as_dict()
    assert restored["catalogId"] == "minor_dark_01"
    assert restored["cycle"] == resolution["cycle"]
    assert restored["events"] == [
        {
            key: event[key]
            for key in (
                "bar", "beat", "roman", "chord", "symbol",
                "formulaOffsets", "bass", "bassOffset"
            )
        }
        for event in resolution["events"]
    ]


def test_minor_thirteenth_and_unicode_flat_are_supported():
    assert parse_roman_step("i13")["quality"] == "min13"
    resolution = resolve_progression("minor_melancholic_01", "G♭ minor", bars=4)
    assert resolution["key"] == "Gb minor"


@pytest.mark.parametrize(
    ("catalog_id", "key", "message"),
    [
        ("missing", "C major", "Choose a chord progression preset"),
        ("major_hopeful_01", "", "Choose a major or minor key"),
        ("major_hopeful_01", "melody in C major", "Choose a major or minor key"),
        ("major_hopeful_01", "C minor", "choose a major key"),
    ],
)
def test_resolution_rejects_unknown_presets_missing_keys_and_mode_conflicts(
    catalog_id, key, message
):
    with pytest.raises(ValueError, match=message):
        resolve_progression(catalog_id, key, bars=4)
