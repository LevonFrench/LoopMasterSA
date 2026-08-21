import json
import os
from pathlib import Path
import struct
import sys
import wave

import pytest
import torch

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from asset_contract import (
    analyze_waveform,
    build_asset_filename,
    build_sidecar_document,
    derive_descriptor,
    finalize_sidecar_for_wav,
    normalize_key,
    parse_chord_track,
    sidecar_path_for,
    validate_sidecar,
    write_sidecar,
)
from chord_progressions import (
    canonical_chord_events,
    condition_prompt,
    resolve_progression,
)
from generation_executor import ProgressionProvenance
from wav_metadata import acidize_wav_file
import generate_variants


def riff_chunks(path):
    content = Path(path).read_bytes()
    assert content[:4] == b"RIFF"
    assert content[8:12] == b"WAVE"
    chunks = []
    offset = 12
    while offset + 8 <= len(content):
        chunk_id = content[offset:offset + 4]
        size = struct.unpack_from("<I", content, offset + 4)[0]
        payload = content[offset + 8:offset + 8 + size]
        chunks.append((chunk_id, payload, offset))
        offset += 8 + size + (size % 2)
    return chunks


def make_pcm16_wav(path, waveform, sample_rate=44_100):
    samples = waveform.clamp(-1, 1).mul(32767).to(torch.int16)
    interleaved = samples.transpose(0, 1).contiguous().numpy().tobytes()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(samples.shape[0])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(interleaved)


def info_fields(payload):
    assert payload[:4] == b"INFO"
    fields = {}
    offset = 4
    while offset + 8 <= len(payload):
        tag = payload[offset:offset + 4]
        size = struct.unpack_from("<I", payload, offset + 4)[0]
        value = payload[offset + 8:offset + 8 + size].rstrip(b"\x00").decode("latin-1")
        fields[tag] = value
        offset += 8 + size + (size % 2)
    return fields


def test_canonical_filename_uses_flats_and_does_not_apply_roblox_length_limit():
    key = normalize_key("F# minor")
    descriptor = "an intentionally very long smoke rise descriptor for a complete pack"

    filename = build_asset_filename(
        pack="Cook Out",
        descriptor=descriptor,
        bpm=140,
        key=key,
        bars=8,
        variation="a1",
    )

    assert key == {
        "token": "gb_min",
        "filename": "gbmin",
        "display": "Gb minor",
        "rootMidi": 66,
    }
    assert filename.startswith("cookout_anintentionallyverylongsmokerisedescriptor")
    assert filename.endswith("_140bpm_gbmin_8bar_a1.wav")
    assert len(Path(filename).stem) > 40
    assert set(Path(filename).stem) <= set("abcdefghijklmnopqrstuvwxyz0123456789_")
    assert build_asset_filename(
        pack="Cook Out",
        descriptor="Stab Hit",
        bpm=None,
        key="F# minor",
        bars=None,
        variation="b2",
        kind="oneshot",
    ) == "cookout_stabhit_oneshot_gbmin_b2.wav"


def test_chords_are_only_recorded_when_explicitly_authored():
    chords = parse_chord_track("Cmin@1:1, Abmaj7@3:1", bars=4)
    assert chords == [
        {"bar": 1, "beat": 1, "chord": "c_min"},
        {"bar": 3, "beat": 1, "chord": "ab_maj7"},
    ]
    with pytest.raises(ValueError, match="first chord"):
        parse_chord_track("ab_maj@2:1", bars=4)

    waveform = torch.zeros((1, 44_100 * 8))
    document = build_sidecar_document(
        file_name="cookout_keys_120bpm_cmin_4bar_a1.wav",
        waveform=waveform,
        sample_rate=44_100,
        bpm=120,
        kind="loop",
        pack="cookout",
        descriptor="keys",
        variation="a1",
        key="C minor",
        chords=[],
    )
    assert document["musical"]["key"]["token"] == "c_min"
    assert document["musical"]["chords"] == []
    assert document["musical"]["chordSource"] is None
    assert document["musical"]["chordsVerified"] is False


def test_full_sidecar_ships_beat_and_transient_slicer_points(tmp_path):
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate * 8))
    for seconds in (0.2, 1.2, 2.2, 3.2):
        start = int(seconds * sample_rate)
        waveform[:, start:start + 512] = 0.95
    filename = "cookout_smokerise_120bpm_cmin_4bar_a1.wav"
    wav_path = tmp_path / filename
    make_pcm16_wav(wav_path, waveform, sample_rate)
    chords = parse_chord_track("c_min@1:1, ab_maj@3:1", bars=4)
    document = build_sidecar_document(
        file_name=filename,
        waveform=waveform,
        sample_rate=sample_rate,
        bpm=120,
        kind="loop",
        pack="cookout",
        descriptor="smokerise",
        variation="a1",
        key="C minor",
        chords=chords,
        generation={
            "jobId": "job123",
            "model": "medium",
            "seed": 1234,
            "steps": 20,
            "prompt": {
                "composed": "smoke rise synth in C minor",
                "negative": "clipping",
                "sections": {"instrument": "synth lead", "harmony": "C minor"},
            },
        },
        created_at="2026-08-21T01:02:03Z",
    )
    acidize_wav_file(
        wav_path,
        120,
        8.0,
        True,
        "smoke rise synth in C minor",
        metadata_document=document,
    )
    document = finalize_sidecar_for_wav(document, wav_path)
    metadata_path = Path(sidecar_path_for(str(wav_path)))
    write_sidecar(metadata_path, document)
    validate_sidecar(document, str(wav_path))

    persisted = json.loads(metadata_path.read_text(encoding="utf-8"))
    assert persisted["$schema"] == "https://schemas.loopmaster.app/loop-meta/v1.json"
    assert persisted["schema"] == "com.loopmaster.loop-meta"
    assert persisted["audio"]["frames"] == sample_rate * 8
    assert persisted["audio"]["bitDepth"] == 16
    assert len(persisted["waveform"]["peaks"]) == 64
    assert len(persisted["slices"]["beatGrid"]) == 16
    assert len(persisted["slices"]["transients"]) >= 2
    assert persisted["slices"]["preferred"] == [
        point for point in persisted["slices"]["transients"] if point["sample"] > 0
    ][:15]
    assert persisted["musical"]["chords"] == chords
    assert persisted["musical"]["chordSource"] == "user"
    assert persisted["musical"]["chordsVerified"] is False
    assert persisted["generation"]["seed"] == 1234

    chunks = riff_chunks(wav_path)
    ids = [chunk_id for chunk_id, _payload, _offset in chunks]
    assert ids.index(b"acid") < ids.index(b"data")
    assert ids.index(b"cue ") < ids.index(b"data")
    assert ids.index(b"smpl") < ids.index(b"data")
    assert ids.index(b"cKUP") < ids.index(b"data")
    acid = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"acid")
    assert struct.unpack("<IHHfIHHf", acid) == (3, 60, 0, 0.0, 16, 4, 4, 120.0)
    cue = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"cue ")
    assert struct.unpack_from("<I", cue, 0)[0] == (
        len(persisted["slices"]["beatGrid"]) + len(persisted["slices"]["transients"])
    )
    smpl = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"smpl")
    assert struct.unpack_from("<I", smpl, 28)[0] == 1
    assert struct.unpack_from("<I", smpl, 48)[0] == sample_rate * 8 - 1
    info = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"LIST" and payload[:4] == b"INFO")
    fields = info_fields(info)
    assert fields[b"INAM"] == Path(filename).stem
    assert fields[b"IKEY"] == "C minor"
    assert "smoke rise synth" in fields[b"ICMT"]
    assert fields[b"ICOP"].startswith("sa3-generated")
    ckup = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"cKUP")
    cache = json.loads(ckup.decode("utf-8"))
    assert cache["schema"] == "com.loopmaster.loop-cache"
    assert cache["waveform"] == persisted["waveform"]
    assert cache["slices"] == persisted["slices"]
    assert "chords" not in cache["musical"]
    assert "chordSource" not in cache["musical"]
    assert "chordsVerified" not in cache["musical"]
    assert "sha256" not in cache["audio"]
    assert cache["generation"]["prompt"] == persisted["generation"]["prompt"]

    # Retagging is idempotent: no duplicate standardized chunks are appended.
    acidize_wav_file(wav_path, 120, 8.0, True, metadata_document=document)
    retagged = riff_chunks(wav_path)
    assert sum(chunk_id == b"acid" for chunk_id, _payload, _offset in retagged) == 1
    assert sum(chunk_id == b"smpl" for chunk_id, _payload, _offset in retagged) == 1
    assert sum(chunk_id == b"cKUP" for chunk_id, _payload, _offset in retagged) == 1
    assert sum(chunk_id == b"LIST" and payload[:4] == b"INFO" for chunk_id, payload, _offset in retagged) == 1


def test_progressor_sidecar_preserves_slash_bass_but_ckup_redacts_harmony(
    tmp_path,
):
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate * 8))
    filename = "cookout_keys_120bpm_cmaj_4bar_a1.wav"
    wav_path = tmp_path / filename
    make_pcm16_wav(wav_path, waveform, sample_rate)
    resolution = resolve_progression("major_serene_01", "C major", bars=4)
    conditioned = condition_prompt("serene piano loop", resolution)
    progression = ProgressionProvenance.from_resolution(resolution).as_dict()
    document = build_sidecar_document(
        file_name=filename,
        waveform=waveform,
        sample_rate=sample_rate,
        bpm=120,
        kind="loop",
        pack="cookout",
        descriptor="keys",
        variation="a1",
        key="C major",
        chords=canonical_chord_events(resolution),
        chord_source="prompt",
        generation={
            "jobId": "job-progression",
            "progression": progression,
            "prompt": {
                "composed": "serene piano loop in C major",
                "conditioned": conditioned,
                "enhanced": conditioned + ", high quality",
                "negative": "noise",
                "userNegative": "vocals",
                "sections": {
                    "freePrompt": "serene piano loop",
                    "genre": "ambient",
                    "harmony": "Use Chord Progressor",
                    "progressionId": "major_serene_01",
                    "progressionKey": "C major",
                    "progression": "I-II-V/vi-vi: Serene",
                    "chordTrack": resolution["chordTrack"],
                },
            },
        },
    )
    acidize_wav_file(
        wav_path,
        120,
        8,
        True,
        "serene piano loop in C major",
        metadata_document=document,
    )
    document = finalize_sidecar_for_wav(document, wav_path)
    metadata_path = Path(sidecar_path_for(str(wav_path)))
    write_sidecar(metadata_path, document)
    persisted = json.loads(metadata_path.read_text(encoding="utf-8"))

    slash_event = persisted["musical"]["chords"][2]
    assert slash_event == {
        "bar": 3,
        "beat": 1,
        "chord": "g_maj",
        "roman": "V/vi",
        "symbol": "G/A",
        "formulaOffsets": [0, 4, 7],
        "bass": "a",
        "bassOffset": 2,
    }
    assert persisted["musical"]["chordSource"] == "prompt"
    assert persisted["musical"]["chordsVerified"] is False
    assert persisted["generation"]["progression"]["catalogId"] == (
        "major_serene_01"
    )
    assert persisted["generation"]["prompt"]["conditioned"] == conditioned

    ckup_payload = next(
        payload for chunk_id, payload, _offset in riff_chunks(wav_path)
        if chunk_id == b"cKUP"
    )
    cache = json.loads(ckup_payload.decode("utf-8"))
    serialized_cache = json.dumps(cache, sort_keys=True)
    assert "chords" not in cache["musical"]
    assert "chordSource" not in cache["musical"]
    assert "chordsVerified" not in cache["musical"]
    assert "progression" not in cache["generation"]
    assert cache["generation"]["prompt"] == {
        "negative": "noise",
        "userNegative": "vocals",
        "sections": {
            "freePrompt": "serene piano loop",
            "genre": "ambient",
        },
    }
    assert "major_serene_01" not in serialized_cache
    assert "G/A" not in serialized_cache
    assert "V/vi" not in serialized_cache
    assert "bass" not in serialized_cache
    assert "chordTrack" not in serialized_cache
    assert "conditioned" not in serialized_cache


def test_descriptor_uses_only_the_active_source_row_with_legacy_fallback():
    sections = {
        "acoustic": "felt piano",
        "electric": "analog polysynth",
        "drums": "breakbeat kit",
        "sourceChoice": "electric",
        "instrument": "legacy guitar",
    }
    assert derive_descriptor("", sections, "fallback") == "analogpolysynth"
    assert derive_descriptor(
        "", {"instrument": "legacy guitar"}, "fallback"
    ) == "legacyguitar"


def test_oneshot_has_zero_tempo_and_transient_cues_but_no_sampler_loop(tmp_path):
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate))
    waveform[:, 4_000:4_400] = 1
    waveform[:, 20_000:20_400] = 0.8
    filename = "cookout_stabhit_oneshot_nokey_a1.wav"
    wav_path = tmp_path / filename
    make_pcm16_wav(wav_path, waveform, sample_rate)
    document = build_sidecar_document(
        file_name=filename,
        waveform=waveform,
        sample_rate=sample_rate,
        bpm=140,
        kind="oneshot",
        pack="cookout",
        descriptor="stabhit",
        variation="a1",
    )
    acidize_wav_file(wav_path, 140, 1.0, False, metadata_document=document)

    chunks = riff_chunks(wav_path)
    acid = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"acid")
    flags, root, _reserved, _reserved_float, beats, denominator, numerator, tempo = struct.unpack(
        "<IHHfIHHf", acid
    )
    assert (flags, root, beats, denominator, numerator, tempo) == (0, 0xFFFF, 0, 4, 4, 0.0)
    assert not any(chunk_id == b"smpl" for chunk_id, _payload, _offset in chunks)
    assert any(chunk_id == b"cue " for chunk_id, _payload, _offset in chunks)
    assert document["musical"]["bpm"] is None
    assert document["loopRegion"] is None


def test_explicit_null_sidecar_key_does_not_fall_back_to_prompt_text(tmp_path):
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate * 2))
    filename = "cookout_piano_120bpm_nokey_1bar_a1.wav"
    wav_path = tmp_path / filename
    make_pcm16_wav(wav_path, waveform, sample_rate)
    document = build_sidecar_document(
        file_name=filename,
        waveform=waveform,
        sample_rate=sample_rate,
        bpm=120,
        kind="loop",
        pack="cookout",
        descriptor="piano",
        variation="a1",
        key=None,
    )

    acidize_wav_file(
        wav_path,
        120,
        2.0,
        True,
        "piano in C minor",
        metadata_document=document,
    )

    chunks = riff_chunks(wav_path)
    acid = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"acid")
    flags, root = struct.unpack_from("<IH", acid, 0)
    assert flags == 1
    assert root == 0xFFFF
    info = next(payload for chunk_id, payload, _offset in chunks if chunk_id == b"LIST" and payload[:4] == b"INFO")
    assert b"IKEY" not in info_fields(info)


def test_preferred_slicer_map_fits_sixteen_pad_roblox_deck():
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate * 4))
    for index in range(24):
        start = int((0.05 + index * 0.16) * sample_rate)
        waveform[:, start:start + 128] = 0.8

    analysis = analyze_waveform(waveform, sample_rate, beat_count=32)

    assert len(analysis["slices"]["transients"]) > 15
    assert len(analysis["slices"]["preferred"]) == 15
    preferred_samples = [point["sample"] for point in analysis["slices"]["preferred"]]
    assert preferred_samples == sorted(preferred_samples)
    assert all(0 < sample < waveform.shape[-1] for sample in preferred_samples)

    beat_fallback = analyze_waveform(torch.zeros_like(waveform), sample_rate, beat_count=32)
    assert len(beat_fallback["slices"]["beatGrid"]) == 32
    assert len(beat_fallback["slices"]["preferred"]) == 15
    assert all(point["sample"] > 0 for point in beat_fallback["slices"]["preferred"])


def test_waveform_analysis_matches_pcm_clip_and_rejects_nonfinite_audio():
    clipped = analyze_waveform(torch.full((1, 32), 1.25), 44_100)
    assert clipped["peaks"] == [1.0] * 64

    invalid = torch.zeros((1, 64))
    invalid[0, 10] = float("nan")
    with pytest.raises(ValueError, match="NaN or infinity"):
        analyze_waveform(invalid, 44_100)


def test_increasing_intensity_hit_sheet_still_produces_slice_boundaries():
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate * 8))
    for second, amplitude in zip((0.5, 1.5, 2.5, 3.5, 4.5, 5.5), (0.2, 0.35, 0.5, 0.65, 0.8, 0.95)):
        start = int(second * sample_rate)
        waveform[:, start:start + 256] = amplitude

    analysis = analyze_waveform(waveform, sample_rate)

    assert len(analysis["slices"]["transients"]) == 6
    assert len(analysis["slices"]["preferred"]) == 6


def test_draft_sidecar_cannot_be_persisted_before_wav_integrity_is_finalized(tmp_path):
    filename = "cookout_pad_120bpm_cmin_1bar_a1.wav"
    draft = build_sidecar_document(
        file_name=filename,
        waveform=torch.zeros((1, 44_100 * 2)),
        sample_rate=44_100,
        bpm=120,
        kind="loop",
        pack="cookout",
        descriptor="pad",
        variation="a1",
        key="C minor",
    )

    with pytest.raises(ValueError, match="finalized WAV SHA-256"):
        write_sidecar(tmp_path / "draft.meta.json", draft)
    with pytest.raises(ValueError, match="positive BPM"):
        build_asset_filename(
            pack="cookout",
            descriptor="pad",
            bpm=120.5,
            key="C minor",
            bars=1,
            variation="a1",
        )
    with pytest.raises(ValueError, match="Unsupported chord quality"):
        parse_chord_track("c_dommaj7@1:1", bars=1)


def test_standalone_generator_publishes_the_same_wav_sidecar_contract(monkeypatch, tmp_path):
    waveform = torch.zeros((1, 44_100 * 2))
    file_path = tmp_path / "cookout_pad_120bpm_cmin_1bar_a1.wav"

    monkeypatch.setattr(
        generate_variants.torchaudio,
        "save",
        lambda path, audio, sample_rate, **_kwargs: make_pcm16_wav(
            path, audio, sample_rate
        ),
    )
    document = generate_variants.publish_variant_pair(
        str(file_path),
        waveform,
        44_100,
        bpm=120,
        is_loop=True,
        prompt="soft pad in C minor",
        pack="cookout",
        descriptor="pad",
        variation="a1",
        key="C minor",
        chords=[],
        generation={},
        provenance={"generator": "LoopMaster SA3 CLI"},
    )

    metadata_path = file_path.with_suffix(".meta.json")
    assert file_path.exists()
    assert metadata_path.exists()
    validate_sidecar(document, str(file_path))
    assert any(chunk_id == b"cKUP" for chunk_id, _payload, _offset in riff_chunks(file_path))
