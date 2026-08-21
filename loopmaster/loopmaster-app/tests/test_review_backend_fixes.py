"""Regression tests for the 2026-08-21 backend review fixes (#5, #10, #11, #15, #16, #20)."""

import hashlib
import json
import os
import struct
import sys
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import torch

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import app_server
import generation_executor
from asset_contract import (
    build_sidecar_document,
    finalize_sidecar_for_wav,
    sidecar_path_for,
    validate_sidecar,
    write_sidecar,
)
from generation_executor import GenerationTask, _publish_variants
from wav_metadata import acidize_wav_file, create_ckup_chunk


def make_pcm16_wav(path, waveform, sample_rate=44_100):
    samples = waveform.clamp(-1, 1).mul(32767).to(torch.int16)
    interleaved = samples.transpose(0, 1).contiguous().numpy().tobytes()
    with wave.open(str(path), "wb") as output:
        output.setnchannels(samples.shape[0])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(interleaved)


@pytest.fixture
def api_env(monkeypatch, tmp_path):
    """Isolated job registry, durable history, queue, and session directory."""
    jobs = {}
    history = Mock()
    submit = Mock()
    monkeypatch.setattr(app_server, "jobs", jobs)
    monkeypatch.setattr(app_server, "job_history", history)
    monkeypatch.setattr(app_server, "SESSION_DIR", str(tmp_path))
    monkeypatch.setattr(app_server, "rate_limit_generation_request", lambda: None)
    monkeypatch.setattr(app_server.generation_queue, "submit", submit)
    return SimpleNamespace(
        jobs=jobs,
        history=history,
        submit=submit,
        client=app_server.app.test_client(),
        session_dir=tmp_path,
    )


# ---------------------------------------------------------------------------
# 5. api_regenerate honors num_variants instead of hardcoding 4
# ---------------------------------------------------------------------------

def test_regenerate_accepts_num_variants_up_to_eight(api_env):
    response = api_env.client.post("/api/regenerate", json={
        "prompt": "test tone",
        "track_num": 3,
        "num_variants": 8,
        "unlocked_indices": [4, 7],
    })

    assert response.status_code == 202
    task = api_env.submit.call_args[0][1]
    assert task.num_variants == 8
    assert task.unlocked_indices == (4, 7)


def test_regenerate_rejects_unlocked_indices_beyond_variant_count(api_env):
    response = api_env.client.post("/api/regenerate", json={
        "prompt": "test tone",
        "track_num": 3,
        "unlocked_indices": [4],
    })

    assert response.status_code == 400
    assert "between 0 and 3" in response.get_json()["error"]
    api_env.submit.assert_not_called()


def test_regenerate_defaults_num_variants_to_slots_on_disk(api_env):
    track_dir = api_env.session_dir / "track_5"
    track_dir.mkdir()
    # Slot f (index 5) exists on disk, so the track was generated with >= 6.
    (track_dir / "loopmaster_loop_120bpm_nokey_4bar_f3.wav").write_bytes(b"wav")

    response = api_env.client.post("/api/regenerate", json={
        "prompt": "test tone",
        "track_num": 5,
        "unlocked_indices": [5],
    })

    assert response.status_code == 202
    task = api_env.submit.call_args[0][1]
    assert task.num_variants == 6
    rejected = api_env.client.post("/api/regenerate", json={
        "prompt": "test tone",
        "track_num": 5,
        "unlocked_indices": [7],
    })
    assert rejected.status_code == 400


# ---------------------------------------------------------------------------
# 10. Published WAVs are not fully re-read to compute digest/size
# ---------------------------------------------------------------------------

def test_acidize_returns_digest_and_size_of_written_bytes(tmp_path):
    wav_path = tmp_path / "loopmaster_loop_120bpm_nokey_1bar_a1.wav"
    make_pcm16_wav(wav_path, torch.zeros((1, 88_200)), 44_100)

    info = acidize_wav_file(str(wav_path), 120, 2.0, True, "test prompt")

    content = wav_path.read_bytes()
    assert info["sha256"] == hashlib.sha256(content).hexdigest()
    assert info["bytes"] == len(content)


def test_finalize_sidecar_prefers_precomputed_digest_and_size(tmp_path):
    wav_path = tmp_path / "x.wav"
    wav_path.write_bytes(b"abc")
    document = {"audio": {"sha256": None, "bytes": None}}

    precomputed = finalize_sidecar_for_wav(
        document, str(wav_path), sha256="f" * 64, size_bytes=7
    )
    assert precomputed["audio"]["sha256"] == "f" * 64
    assert precomputed["audio"]["bytes"] == 7

    computed = finalize_sidecar_for_wav(document, str(wav_path))
    assert computed["audio"]["sha256"] == hashlib.sha256(b"abc").hexdigest()
    assert computed["audio"]["bytes"] == 3


def test_precomputed_digest_agrees_with_the_published_wav(tmp_path):
    sample_rate = 44_100
    waveform = torch.zeros((1, sample_rate * 4))
    filename = "cookout_keys_120bpm_nokey_2bar_a1.wav"
    wav_path = tmp_path / filename
    make_pcm16_wav(wav_path, waveform, sample_rate)
    document = build_sidecar_document(
        file_name=filename,
        waveform=waveform,
        sample_rate=sample_rate,
        bpm=120,
        kind="loop",
        pack="cookout",
        descriptor="keys",
        variation="a1",
    )
    info = acidize_wav_file(
        str(wav_path), 120, 4.0, True, "keys", metadata_document=document
    )

    document = finalize_sidecar_for_wav(
        document, str(wav_path), sha256=info["sha256"], size_bytes=info["bytes"]
    )
    write_sidecar(str(tmp_path / sidecar_path_for(filename)), document)

    # validate_sidecar re-hashes from disk; the in-memory digest must agree.
    validate_sidecar(document, str(wav_path))


# ---------------------------------------------------------------------------
# 11. Status polls stay slim while active, complete once terminal
# ---------------------------------------------------------------------------

def test_status_poll_slims_active_jobs_and_keeps_full_terminal_record(api_env):
    api_env.jobs["job-active"] = {
        "status": "generating",
        "progress": "Running diffusion model…",
        "error": None,
        "elapsed": None,
        "files": None,
        "prompt": "big prompt",
        "prompt_sections": {"freePrompt": "big prompt"},
        "asset": {"chords": [{"bar": bar, "beat": 1, "chord": "c_min"} for bar in range(1, 76)]},
        "track_num": 2,
        "queue_position": None,
    }

    active = api_env.client.get("/api/status/job-active").get_json()
    assert active["status"] == "generating"
    assert active["progress"] == "Running diffusion model…"
    assert active["track_num"] == 2
    assert "asset" not in active
    assert "prompt_sections" not in active
    assert "prompt" not in active
    assert "queue_depth" in active
    assert "queue_capacity" in active

    api_env.jobs["job-done"] = {
        "status": "done",
        "progress": None,
        "error": None,
        "elapsed": 12.5,
        "files": ["session/track_2/a.wav"],
        "metadata_files": ["session/track_2/a.meta.json"],
        "partial_errors": [],
        "kit": None,
        "prompt": "big prompt",
        "prompt_sections": {"freePrompt": "big prompt"},
        "asset": {"chords": []},
        "track_num": 2,
        "queue_position": None,
    }

    done = api_env.client.get("/api/status/job-done").get_json()
    assert done["files"] == ["session/track_2/a.wav"]
    assert done["metadata_files"] == ["session/track_2/a.meta.json"]
    assert done["partial_errors"] == []
    assert done["asset"] == {"chords": []}
    assert done["prompt_sections"] == {"freePrompt": "big prompt"}


# ---------------------------------------------------------------------------
# 15. No phantom "queued" job survives a failed submit window
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("endpoint", "payload"),
    [
        ("/api/generate", {"prompt": "test tone"}),
        (
            "/api/regenerate",
            {"prompt": "test tone", "track_num": 3, "unlocked_indices": [0]},
        ),
        ("/api/generate_kit", {"style": "acoustic drum kit", "pieces": ["kick"]}),
    ],
)
def test_failed_submit_rolls_back_registered_job_and_reraises(
    api_env, endpoint, payload
):
    api_env.submit.side_effect = RuntimeError("generation queue is stopping")

    response = api_env.client.post(endpoint, json=payload)

    assert response.status_code == 500
    assert api_env.jobs == {}
    registered_job_id = api_env.history.record.call_args[0][0]
    api_env.history.remove.assert_called_once_with(registered_job_id)


def test_queue_full_rollback_still_returns_429(api_env):
    api_env.submit.side_effect = app_server.GenerationQueueFull()

    response = api_env.client.post("/api/generate", json={"prompt": "test tone"})

    assert response.status_code == 429
    assert api_env.jobs == {}


# ---------------------------------------------------------------------------
# 16. Local publication runs without a fanout timeout; sidecar replace retries
# ---------------------------------------------------------------------------

def test_publish_variants_uses_no_timeout_for_local_publication(
    monkeypatch, tmp_path
):
    session_dir = tmp_path / "session_test"
    session_dir.mkdir()

    def save_variant(path, *_args, asset_metadata=None, **_kwargs):
        Path(path).write_bytes(b"wav")
        Path(path).with_suffix(".meta.json").write_text("{}", encoding="utf-8")

    runtime = SimpleNamespace(
        session_dir=str(session_dir),
        session_dir_name="session_test",
        model=SimpleNamespace(model=SimpleNamespace(sample_rate=44_100)),
        save_variant_atomically=save_variant,
    )
    task = GenerationTask(
        job_id="job-fanout",
        prompt="stab",
        bpm=120,
        duration=1,
        loop=False,
        steps=8,
        cfg_scale=1,
        track_num=1,
        num_variants=1,
    )
    captured = {}
    real_fanout = generation_executor.run_parallel_fanout

    def spying_fanout(items, request_fn, **kwargs):
        captured.update(kwargs)
        return real_fanout(items, request_fn, **kwargs)

    monkeypatch.setattr(generation_executor, "run_parallel_fanout", spying_fanout)

    files, _metadata_files, errors = _publish_variants(
        task,
        runtime,
        torch.zeros((1, 1, 44_100)),
        target_indices=[0],
        is_drum=False,
        prompts=["enhanced stab prompt"],
    )

    assert errors == []
    assert files[0]
    assert captured["timeout_seconds"] is None


def test_atomic_variant_retries_sidecar_replace_on_permission_error(
    monkeypatch, tmp_path
):
    final_path = tmp_path / "loopmaster_loop_120bpm_nokey_2bar_a1.wav"
    waveform = app_server.torch.zeros((1, 176_400))
    real_replace = os.replace
    sidecar_failures = []
    sleeps = []

    def fake_save(path, _waveform, _sample_rate, **_kwargs):
        Path(path).write_bytes(b"R" * 44)

    def flaky_replace(source, destination):
        if destination.endswith(".meta.json") and len(sidecar_failures) < 2:
            sidecar_failures.append(destination)
            raise PermissionError("destination held open by a reader")
        real_replace(source, destination)

    monkeypatch.setattr(app_server.torchaudio, "save", fake_save)
    monkeypatch.setattr(app_server, "acidize_wav_file", lambda *_a, **_k: None)
    monkeypatch.setattr(app_server.os, "replace", flaky_replace)
    monkeypatch.setattr(app_server.time, "sleep", lambda s: sleeps.append(s))

    app_server._save_variant_atomically(
        str(final_path), waveform, 44_100, 120, 4.0, True, "prompt"
    )

    assert len(sidecar_failures) == 2
    assert sleeps == [0.3, 0.3]
    assert final_path.exists()
    assert (tmp_path / "loopmaster_loop_120bpm_nokey_2bar_a1.meta.json").exists()


# ---------------------------------------------------------------------------
# 20. cKUP redacts manual chord maps too — chords are sidecar-only, period
# ---------------------------------------------------------------------------

def test_ckup_redacts_manual_chord_track_without_a_progression():
    document = {
        "id": "cookout_keys_120bpm_cmin_4bar_a1",
        "kind": "loop",
        "generation": {
            "prompt": {
                "composed": "keys",
                "enhanced": "keys, enhanced",
                "negative": "noise",
                "userNegative": "vocals",
                "sections": {
                    "chordTrack": "c_min@1:1, ab_maj@3:1",
                    "harmony": "C minor",
                    "genre": "house",
                },
            },
        },
    }

    chunk = create_ckup_chunk(document)

    assert chunk[:4] == b"cKUP"
    size = struct.unpack_from("<I", chunk, 4)[0]
    payload = json.loads(chunk[8:8 + size].decode("utf-8"))
    assert payload["generation"]["prompt"] == {
        "composed": "keys",
        "enhanced": "keys, enhanced",
        "negative": "noise",
        "userNegative": "vocals",
        "sections": {"genre": "house"},
    }
    serialized = json.dumps(payload, sort_keys=True)
    assert "chordTrack" not in serialized
    assert "c_min@1:1" not in serialized
    assert "C minor" not in serialized
