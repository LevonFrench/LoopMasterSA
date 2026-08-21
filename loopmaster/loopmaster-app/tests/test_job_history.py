import json
import os
import sys
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import app_server
from job_history import INTERRUPTED_ERROR, JobHistory


def terminal(status="done", prompt="loop"):
    return {
        "status": status,
        "prompt": prompt,
        "progress": None,
        "error": None,
        "files": ["session/track/file.wav"] if status == "done" else None,
    }


def test_atomic_snapshot_is_published_from_same_directory(monkeypatch, tmp_path):
    history = JobHistory(tmp_path / "outputs")
    real_replace = os.replace
    replacements = []

    def tracked_replace(source, destination):
        assert Path(source).parent == Path(destination).parent
        assert Path(source).name.endswith(".tmp")
        with open(source, "r", encoding="utf-8") as snapshot:
            assert json.load(snapshot)["version"] == 1
        replacements.append((source, destination))
        real_replace(source, destination)

    monkeypatch.setattr("job_history.os.replace", tracked_replace)

    assert history.record("job-1", terminal()) is True

    assert len(replacements) == 1
    assert Path(replacements[0][1]) == Path(history.path)
    assert not list(Path(history.path).parent.glob("*.tmp"))
    with open(history.path, "r", encoding="utf-8") as saved:
        assert json.load(saved)["records"][0]["job_id"] == "job-1"


def test_terminal_history_retention_is_bounded(tmp_path):
    history = JobHistory(tmp_path / "outputs", max_terminal=2)

    history.record("old", terminal(prompt="old"))
    history.record("middle", terminal("error", prompt="middle"))
    history.record("new", terminal("cancelled", prompt="new"))

    recovered = JobHistory(tmp_path / "outputs", max_terminal=2).recover()
    assert list(recovered) == ["middle", "new"]


def test_recovery_keeps_terminal_jobs_and_marks_active_work_interrupted(tmp_path):
    output_dir = tmp_path / "outputs"
    history = JobHistory(output_dir)
    history.record("waiting", {"status": "queued", "progress": "Waiting"})
    history.record("running", {"status": "generating", "progress": "Step 2"})
    history.record("complete", terminal())

    recovered = JobHistory(output_dir).recover()

    assert recovered["complete"]["status"] == "done"
    for job_id in ("waiting", "running"):
        assert recovered[job_id]["status"] == "error"
        assert recovered[job_id]["error"] == INTERRUPTED_ERROR
        assert recovered[job_id]["progress"] is None
        assert recovered[job_id]["queue_position"] is None
        assert recovered[job_id]["interrupted"] is True
    assert recovered["waiting"]["last_progress"] == "Waiting"
    assert recovered["running"]["last_progress"] == "Step 2"

    second_recovery = JobHistory(output_dir).recover()
    assert second_recovery["waiting"]["status"] == "error"
    assert second_recovery["running"]["status"] == "error"


def test_corrupt_or_truncated_state_is_quarantined_and_startup_continues(tmp_path):
    output_dir = tmp_path / "outputs"
    history = JobHistory(output_dir, clock=lambda: 1234)
    state_path = Path(history.path)
    state_path.parent.mkdir(parents=True)
    state_path.write_text('{"version":1,"records":[', encoding="utf-8")

    assert history.recover() == {}
    assert history.last_error is not None
    assert not state_path.exists()
    assert len(list(state_path.parent.glob("job-history.json.corrupt-1234-*"))) == 1

    assert history.record("after-corruption", terminal()) is True
    assert JobHistory(output_dir).recover()["after-corruption"]["status"] == "done"


def test_progress_only_mutations_do_not_rewrite_snapshot(monkeypatch, isolate_app_job_history):
    history = isolate_app_job_history
    writes = []
    original_record = history.record

    def tracked_record(job_id, job):
        writes.append((job_id, job["status"]))
        return original_record(job_id, job)

    monkeypatch.setattr(history, "record", tracked_record)
    app_server._register_job("job-1", {"status": "queued", "progress": "Waiting"})
    app_server._mutate_job("job-1", status="generating", progress="Preparing")
    app_server._mutate_job("job-1", progress="Step 1")
    app_server._mutate_job("job-1", progress="Step 2")
    app_server._mutate_job(
        "job-1", progress="Decoding VAE variant 1/4", _persist=True
    )
    app_server._mutate_job("job-1", status="done", progress=None, files=[])

    assert writes == [
        ("job-1", "queued"),
        ("job-1", "generating"),
        ("job-1", "generating"),
        ("job-1", "done"),
    ]


def test_recovered_terminal_job_is_visible_through_status_route(
    tmp_path, monkeypatch
):
    output_dir = tmp_path / "outputs"
    history = JobHistory(output_dir)
    history.record("remembered", terminal("error", prompt="failed loop"))
    recovered = JobHistory(output_dir).recover()
    with app_server.jobs_lock:
        app_server.jobs.clear()
        app_server.jobs.update(recovered)

    class EmptyQueue:
        capacity = 4

        def position(self, _job_id):
            return None

        def snapshot(self):
            return {
                "active_job_id": None,
                "queued_job_ids": (),
                "queue_depth": 0,
                "capacity": self.capacity,
            }

    monkeypatch.setattr(app_server, "generation_queue", EmptyQueue())

    response = app_server.app.test_client().get("/api/status/remembered")

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "error"
    assert body["prompt"] == "failed loop"
    assert body["queue_position"] is None
    assert body["queue_depth"] == 0
