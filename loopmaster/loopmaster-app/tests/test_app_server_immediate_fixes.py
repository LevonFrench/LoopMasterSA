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


def test_atomic_variant_keeps_old_file_when_tagging_fails(monkeypatch, tmp_path):
    old_path = tmp_path / "old.wav"
    final_path = tmp_path / "new.wav"
    old_path.write_bytes(b"known-good")
    waveform = Mock()
    events = []

    def fake_save(path, _waveform, _sample_rate):
        events.append("save")
        Path(path).write_bytes(b"new-audio")

    def failing_tag(*_args):
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
    final_path = tmp_path / "new.wav"
    old_path.write_bytes(b"known-good")
    waveform = Mock()
    events = []
    real_replace = os.replace
    real_remove = os.remove

    def fake_save(path, _waveform, _sample_rate):
        events.append("save")
        Path(path).write_bytes(b"new-audio")

    def fake_tag(path, *_args):
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
            assert final_path.read_bytes() == b"new-audio-tagged"
        real_remove(path)

    monkeypatch.setattr(app_server.torchaudio, "save", fake_save)
    monkeypatch.setattr(app_server, "acidize_wav_file", fake_tag)
    monkeypatch.setattr(app_server.os, "replace", tracked_replace)
    monkeypatch.setattr(app_server.os, "remove", tracked_remove)

    app_server._save_variant_atomically(
        str(final_path), waveform, 44_100, 120, 4.0, True, "prompt", str(old_path)
    )

    assert events == ["save", "tag", "replace", "remove-old"]
    assert final_path.read_bytes() == b"new-audio-tagged"
    assert not old_path.exists()
