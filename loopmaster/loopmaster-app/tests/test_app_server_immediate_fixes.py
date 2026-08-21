import os
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import app_server


@pytest.mark.parametrize(
    "unsafe_path",
    [
        "../outside.wav",
        r"..\outside.wav",
        r"session/..\../outside.wav",
        r"C:outside.wav",
        r"C:\outside.wav",
        r"\\server\share\outside.wav",
        "//server/share/outside.wav",
    ],
)
def test_resolve_output_path_rejects_escape_forms(monkeypatch, tmp_path, unsafe_path):
    monkeypatch.setattr(app_server, "OUTPUT_DIR", str(tmp_path))

    with pytest.raises(ValueError, match="Invalid file path"):
        app_server.resolve_output_path(unsafe_path)


def test_resolve_output_path_accepts_mixed_separators_inside_root(monkeypatch, tmp_path):
    monkeypatch.setattr(app_server, "OUTPUT_DIR", str(tmp_path))

    resolved = app_server.resolve_output_path(r"session_1\track_1/variant.wav")

    assert Path(resolved) == tmp_path / "session_1" / "track_1" / "variant.wav"


def test_resolve_output_path_rejects_symlink_escape(monkeypatch, tmp_path):
    output_dir = tmp_path / "outputs"
    outside_dir = tmp_path / "outside"
    output_dir.mkdir()
    outside_dir.mkdir()
    link = output_dir / "linked"
    try:
        link.symlink_to(outside_dir, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"directory symlinks are unavailable: {error}")
    monkeypatch.setattr(app_server, "OUTPUT_DIR", str(output_dir))

    with pytest.raises(ValueError, match="Invalid file path"):
        app_server.resolve_output_path("linked/secret.wav")


@pytest.mark.parametrize(
    ("endpoint", "request_kwargs"),
    [
        (
            "/api/generate",
            {"json": {"prompt": "test", "init_audio_path": r"session_1\..\..\secret.wav"}},
        ),
        (
            "/api/delete_variant",
            {"json": {"file_path": r"C:secret.wav"}},
        ),
        (
            "/api/convert",
            {"data": {"file_path": r"\\server\share\secret.wav", "format": "wav"}},
        ),
    ],
)
def test_file_routes_share_strict_path_validation(endpoint, request_kwargs):
    client = app_server.app.test_client()

    response = client.post(endpoint, **request_kwargs)

    assert response.status_code == 400
    assert "Invalid" in response.get_json()["error"]


def test_blend_indices_cap_seed_longer_than_generated_audio():
    blend_len, indices = app_server._normalize_blend_indices(
        8,
        12,
        2,
        4,
        7,
        12,
    )

    assert blend_len == 8
    assert indices == (2, 4, 7, 8)
    assert blend_len - indices[-1] == 0


def test_structured_prompt_accepts_free_text_and_separate_drums():
    assert app_server.validate_prompt_sections(
        {
            "freePrompt": "my own unrestricted prompt",
            "instrument": "electric guitar",
            "drums": "909 drum machine",
            "harmony": "A minor",
        }
    ) == {
        "freePrompt": "my own unrestricted prompt",
        "instrument": "electric guitar",
        "drums": "909 drum machine",
        "harmony": "A minor",
    }
    assert app_server.validate_prompt_sections({"freePrompt": "x" * 2000}) == {
        "freePrompt": "x" * 2000
    }


def test_server_composes_structured_prompt_like_client():
    sections = {
        "freePrompt": "  my   riff  ",
        "mood": "hypnotic",
        "genre": "techno",
        "electric": "electric guitar",
        "drums": "909 drum machine",
        "sourceChoice": "electric",
        "style": "arpeggiated",
        "harmony": "A minor",
        "production": "tape saturated",
        "modifiers": "four bar loop",
        "negativePrompt": "vocals",
    }

    assert app_server.compose_prompt_sections(sections) == (
        "my riff, hypnotic techno electric guitar "
        "arpeggiated in A minor, tape saturated, four bar loop"
    )


def test_server_prompt_modes_do_not_join_manual_and_assembled_text():
    sections = {
        "freePrompt": "exact manual prompt",
        "promptMode": "manual",
        "mood": "hypnotic",
        "genre": "techno",
        "electric": "analog synthesizer",
        "sourceChoice": "electric",
        "harmony": "C minor",
    }

    assert app_server.compose_prompt_sections(sections) == "exact manual prompt"
    sections["freePrompt"] = "line one  line two\nline three"
    assert app_server.compose_prompt_sections(sections) == (
        "line one  line two\nline three"
    )
    sections["freePrompt"] = "exact manual prompt"
    sections["promptMode"] = "assembled"
    assert app_server.compose_prompt_sections(sections) == (
        "hypnotic techno analog synthesizer in C minor"
    )


def test_server_rejects_unknown_prompt_mode():
    with pytest.raises(ValueError, match="promptMode"):
        app_server.validate_prompt_sections({"promptMode": "prefix"})


def test_server_composes_chord_progressor_phrase_like_client():
    sections = {
        "freePrompt": "hook",
        "electric": "analog polysynth",
        "sourceChoice": "electric",
        "genre": "house",
        "harmony": "Use Chord Progressor",
        "progressionKey": "C major",
        "progression": "I-V-vi-IV: Hopeful",
        "mood": "bright",
        "characterChoice": "mood",
        "modifiers": "ignored while mood is selected",
    }

    assert app_server.compose_prompt_sections(sections) == (
        "hook, bright house analog polysynth in C major, "
        "hopeful four-chord I-V-vi-IV progression"
    )


def test_local_quality_routing_caps_draft_and_bulk_work_only():
    assert app_server.route_local_inference_steps(24, "draft") == 8
    assert app_server.route_local_inference_steps(24, "final") == 24
    assert app_server.route_local_inference_steps(24, "final", bulk=True) == 8


def test_generation_rejects_prompt_that_disagrees_with_sections():
    response = app_server.app.test_client().post("/api/generate", json={
        "prompt": "different prompt",
        "prompt_sections": {"freePrompt": "structured prompt"},
    })

    assert response.status_code == 400
    assert "does not match" in response.get_json()["error"]


def test_atomic_variant_keeps_old_file_when_tagging_fails(monkeypatch, tmp_path):
    old_path = tmp_path / "old.wav"
    final_path = tmp_path / "loopmaster_loop_120bpm_nokey_2bar_a1.wav"
    old_path.write_bytes(b"known-good")
    waveform = app_server.torch.zeros((1, 176_400))
    events = []

    def fake_save(path, _waveform, _sample_rate, **kwargs):
        events.append("save")
        assert kwargs == {"encoding": "PCM_S", "bits_per_sample": 16}
        Path(path).write_bytes(b"R" * 44)

    def failing_tag(*_args, **_kwargs):
        events.append("tag")
        assert old_path.read_bytes() == b"known-good"
        raise RuntimeError("tagging failed")

    replace = Mock()
    monkeypatch.setattr(app_server.torchaudio, "save", fake_save)
    monkeypatch.setattr(app_server, "acidize_wav_file", failing_tag)
    monkeypatch.setattr(app_server.os, "replace", replace)

    with pytest.raises(RuntimeError, match="tagging failed"):
        app_server._save_variant_atomically(
            str(final_path), waveform, 44_100, 120, 4.0, True, "prompt", str(old_path)
        )

    assert events == ["save", "tag"]
    replace.assert_not_called()
    assert old_path.read_bytes() == b"known-good"
    assert not final_path.exists()
    assert not list(tmp_path.glob("*.tmp.wav"))


def test_atomic_variant_publishes_before_removing_old_file(monkeypatch, tmp_path):
    old_path = tmp_path / "old.wav"
    final_path = tmp_path / "loopmaster_loop_120bpm_nokey_2bar_a1.wav"
    old_path.write_bytes(b"known-good")
    waveform = app_server.torch.zeros((1, 176_400))
    events = []
    real_replace = os.replace
    real_remove = os.remove

    def fake_save(path, _waveform, _sample_rate, **kwargs):
        events.append("save")
        assert kwargs == {"encoding": "PCM_S", "bits_per_sample": 16}
        Path(path).write_bytes(b"R" * 44)

    def fake_tag(path, *_args, **_kwargs):
        events.append("tag")
        assert old_path.exists()
        with open(path, "ab") as output:
            output.write(b"-tagged")

    def tracked_replace(source, destination):
        events.append("replace")
        assert old_path.exists()
        real_replace(source, destination)

    def tracked_remove(path):
        if os.path.abspath(path) == os.path.abspath(old_path):
            events.append("remove-old")
            assert final_path.read_bytes() == (b"R" * 44) + b"-tagged"
        real_remove(path)

    monkeypatch.setattr(app_server.torchaudio, "save", fake_save)
    monkeypatch.setattr(app_server, "acidize_wav_file", fake_tag)
    monkeypatch.setattr(app_server.os, "replace", tracked_replace)
    monkeypatch.setattr(app_server.os, "remove", tracked_remove)

    app_server._save_variant_atomically(
        str(final_path), waveform, 44_100, 120, 4.0, True, "prompt", str(old_path)
    )

    assert events == ["save", "tag", "replace", "replace", "remove-old"]
    assert final_path.read_bytes() == (b"R" * 44) + b"-tagged"
    assert (tmp_path / "loopmaster_loop_120bpm_nokey_2bar_a1.meta.json").exists()
    assert not old_path.exists()


def test_prompt_config_supports_etag_revalidation():
    client = app_server.app.test_client()

    first = client.get("/static/prompt_options.json")

    assert first.status_code == 200
    assert first.headers.get("ETag")
    cached = client.get(
        "/static/prompt_options.json",
        headers={"If-None-Match": first.headers["ETag"]},
    )
    assert cached.status_code == 304
