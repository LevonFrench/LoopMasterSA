from pathlib import Path
import sys


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

from sliceable_registry import SliceableRegistry


def test_registry_tracks_sidecar_pairs_and_prunes_missing_files(tmp_path):
    registry = SliceableRegistry(tmp_path)
    audio = tmp_path / "session_a" / "track_1" / "loop.wav"
    metadata = audio.with_suffix(".meta.json")
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"wav")
    metadata.write_text("{}", encoding="utf-8")

    registry.record(
        file="session_a/track_1/loop.wav",
        metadata_file="session_a/track_1/loop.meta.json",
        kind="loop",
    )
    assert len(registry.snapshot()["entries"]) == 1

    metadata.unlink()
    assert registry.snapshot()["entries"] == []


def test_registry_remove_and_remove_prefix_are_persistent(tmp_path):
    registry = SliceableRegistry(tmp_path)
    for relative in (
        "session_a/track_1/a.wav",
        "session_a/track_1/b.wav",
        "session_a/track_2/c.wav",
    ):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"wav")
        registry.record(file=relative, kind="loop")

    assert registry.remove("session_a/track_1/a.wav") is True
    assert registry.remove_prefix("session_a/track_1") == 1
    assert [entry["file"] for entry in registry.snapshot()["entries"]] == [
        "session_a/track_2/c.wav"
    ]
