import sys
import threading
import time
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import app_server
from generation_executor import GenerationTask
from generation_queue import (
    GenerationCancelResult,
    GenerationQueue,
    GenerationQueueFull,
)


def wait_until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("condition was not reached before timeout")


def test_queue_executes_jobs_in_fifo_order():
    first_started = threading.Event()
    release_first = threading.Event()
    completed = []

    def handler(task):
        if task == "first":
            first_started.set()
            assert release_first.wait(2)
        completed.append(task)

    queue = GenerationQueue(handler, capacity=2)
    queue.start()
    queue.submit("job-1", "first")
    assert first_started.wait(2)
    queue.submit("job-2", "second")
    queue.submit("job-3", "third")

    assert queue.position("job-1") == 0
    assert queue.position("job-2") == 1
    assert queue.position("job-3") == 2
    release_first.set()
    wait_until(lambda: completed == ["first", "second", "third"])
    queue.stop()


def test_queue_rejects_work_beyond_waiting_capacity():
    first_started = threading.Event()
    release_first = threading.Event()

    def handler(_task):
        first_started.set()
        assert release_first.wait(2)

    queue = GenerationQueue(handler, capacity=1)
    queue.start()
    queue.submit("running", object())
    assert first_started.wait(2)
    queue.submit("waiting", object())

    with pytest.raises(GenerationQueueFull):
        queue.submit("rejected", object())

    snapshot = queue.snapshot()
    assert snapshot["active_job_id"] == "running"
    assert snapshot["queued_job_ids"] == ("waiting",)
    assert snapshot["queue_depth"] == 1
    release_first.set()
    queue.stop()


def test_worker_survives_one_job_failure():
    completed = threading.Event()
    errors = []

    def handler(task):
        if task == "broken":
            raise RuntimeError("expected failure")
        completed.set()

    queue = GenerationQueue(
        handler,
        capacity=2,
        on_error=lambda job_id, error: errors.append((job_id, str(error))),
    )
    queue.start()
    queue.submit("job-1", "broken")
    queue.submit("job-2", "healthy")

    assert completed.wait(2)
    assert errors == [("job-1", "expected failure")]
    queue.stop()


def test_cancel_removes_pending_job_and_compacts_positions():
    first_started = threading.Event()
    release_first = threading.Event()
    completed = []

    def handler(task):
        if task == "first":
            first_started.set()
            assert release_first.wait(2)
        completed.append(task)

    queue = GenerationQueue(handler, capacity=3)
    queue.start()
    queue.submit("job-1", "first")
    assert first_started.wait(2)
    queue.submit("job-2", "second")
    queue.submit("job-3", "third")
    queue.submit("job-4", "fourth")

    assert queue.cancel("job-3") is GenerationCancelResult.CANCELLED
    assert queue.position("job-2") == 1
    assert queue.position("job-3") is None
    assert queue.position("job-4") == 2
    assert queue.snapshot()["queued_job_ids"] == ("job-2", "job-4")

    release_first.set()
    wait_until(lambda: completed == ["first", "second", "fourth"])
    queue.stop()


def test_cancel_loses_cleanly_once_worker_owns_job():
    started = threading.Event()
    release = threading.Event()

    def handler(_task):
        started.set()
        assert release.wait(2)

    queue = GenerationQueue(handler, capacity=1)
    queue.start()
    queue.submit("job-1", object())
    assert started.wait(2)

    assert queue.cancel("job-1") is GenerationCancelResult.RUNNING
    assert queue.position("job-1") == 0
    release.set()
    queue.stop()
    assert queue.cancel("job-1") is GenerationCancelResult.NOT_PENDING


def test_cancel_wins_before_dequeue_and_handler_never_sees_job():
    first_started = threading.Event()
    release_first = threading.Event()
    completed = []

    def handler(task):
        first_started.set()
        if task == "first":
            assert release_first.wait(2)
        completed.append(task)

    queue = GenerationQueue(handler, capacity=1)
    queue.start()
    queue.submit("job-1", "first")
    assert first_started.wait(2)
    queue.submit("job-2", "second")

    assert queue.cancel("job-2") is GenerationCancelResult.CANCELLED
    release_first.set()
    wait_until(lambda: completed == ["first"])
    queue.stop()


class SaturatedQueue:
    capacity = 3

    def submit(self, _job_id, _task):
        raise GenerationQueueFull()


@pytest.mark.parametrize(
    ("endpoint", "payload"),
    [
        ("/api/generate", {"prompt": "test loop"}),
        (
            "/api/regenerate",
            {
                "prompt": "test loop",
                "track_num": 1,
                "unlocked_indices": [0],
            },
        ),
    ],
)
def test_generation_routes_return_429_without_ghost_job(
    monkeypatch, endpoint, payload
):
    monkeypatch.setattr(app_server, "generation_queue", SaturatedQueue())
    with app_server.jobs_lock:
        app_server.jobs.clear()

    response = app_server.app.test_client().post(endpoint, json=payload)

    assert response.status_code == 429
    assert response.get_json() == {
        "error": "Generation queue is full. Try again after a job finishes.",
        "queue_capacity": 3,
    }
    with app_server.jobs_lock:
        assert app_server.jobs == {}


class RecordingQueue:
    capacity = 4

    def __init__(self):
        self.submissions = []

    def submit(self, job_id, task):
        self.submissions.append((job_id, task))

    def position(self, job_id):
        return 1 if any(item[0] == job_id for item in self.submissions) else None

    def snapshot(self):
        return {
            "active_job_id": None,
            "queued_job_ids": tuple(item[0] for item in self.submissions),
            "queue_depth": len(self.submissions),
            "capacity": self.capacity,
        }


class CancelQueue:
    capacity = 4

    def __init__(self, result):
        self.result = result
        self.cancelled_job_ids = []

    def cancel(self, job_id):
        self.cancelled_job_ids.append(job_id)
        return self.result

    def position(self, _job_id):
        return None

    def snapshot(self):
        return {
            "active_job_id": None,
            "queued_job_ids": (),
            "queue_depth": 0,
            "capacity": self.capacity,
        }


def test_generate_route_enqueues_typed_task_and_reports_queue_state(monkeypatch):
    queue = RecordingQueue()
    monkeypatch.setattr(app_server, "generation_queue", queue)
    monkeypatch.setattr(app_server, "get_next_track_index", lambda: 7)
    with app_server.jobs_lock:
        app_server.jobs.clear()

    client = app_server.app.test_client()
    response = client.post("/api/generate", json={"prompt": "deep bass loop"})

    assert response.status_code == 202
    body = response.get_json()
    assert body["status"] == "queued"
    assert body["queue_position"] == 1
    assert len(queue.submissions) == 1
    job_id, task = queue.submissions[0]
    assert job_id == body["job_id"]
    assert isinstance(task, GenerationTask)
    assert task.track_num == 7
    assert task.prompt == "deep bass loop"

    status = client.get(f"/api/status/{job_id}")
    assert status.status_code == 200
    status_body = status.get_json()
    assert status_body["status"] == "queued"
    assert status_body["queue_position"] == 1
    assert status_body["queue_depth"] == 1
    assert status_body["queue_capacity"] == 4
    with app_server.jobs_lock:
        app_server.jobs.clear()


def test_cancel_route_marks_removed_job_cancelled_and_status_remains_queryable(monkeypatch):
    queue = CancelQueue(GenerationCancelResult.CANCELLED)
    monkeypatch.setattr(app_server, "generation_queue", queue)
    with app_server.jobs_lock:
        app_server.jobs.clear()
        app_server.jobs["waiting"] = {
            "status": "queued",
            "progress": "Waiting",
            "error": None,
        }

    client = app_server.app.test_client()
    response = client.post("/api/cancel/waiting")

    assert response.status_code == 200
    assert response.get_json() == {
        "job_id": "waiting",
        "status": "cancelled",
        "cancelled": True,
    }
    status = client.get("/api/status/waiting")
    assert status.status_code == 200
    assert status.get_json()["status"] == "cancelled"
    assert status.get_json()["queue_position"] is None
    with app_server.jobs_lock:
        app_server.jobs.clear()


@pytest.mark.parametrize("status", ["done", "error"])
def test_cancel_route_never_claims_terminal_job_was_cancelled(monkeypatch, status):
    queue = CancelQueue(GenerationCancelResult.NOT_PENDING)
    monkeypatch.setattr(app_server, "generation_queue", queue)
    with app_server.jobs_lock:
        app_server.jobs.clear()
        app_server.jobs["terminal"] = {"status": status}

    response = app_server.app.test_client().post("/api/cancel/terminal")

    assert response.status_code == 409
    assert response.get_json()["cancelled"] is False
    assert response.get_json()["status"] == status
    with app_server.jobs_lock:
        assert app_server.jobs["terminal"]["status"] == status
        app_server.jobs.clear()


def test_cancel_route_rejects_running_and_unknown_jobs(monkeypatch):
    queue = CancelQueue(GenerationCancelResult.RUNNING)
    monkeypatch.setattr(app_server, "generation_queue", queue)
    with app_server.jobs_lock:
        app_server.jobs.clear()
        app_server.jobs["running"] = {"status": "generating"}

    client = app_server.app.test_client()
    running = client.post("/api/cancel/running")
    unknown = client.post("/api/cancel/missing")

    assert running.status_code == 409
    assert running.get_json()["cancelled"] is False
    assert running.get_json()["status"] == "generating"
    assert unknown.status_code == 404
    assert unknown.get_json()["cancelled"] is False
    assert queue.cancelled_job_ids == ["running"]
    with app_server.jobs_lock:
        app_server.jobs.clear()


def test_cancel_route_is_idempotent_without_claiming_second_cancellation(monkeypatch):
    queue = CancelQueue(GenerationCancelResult.NOT_PENDING)
    monkeypatch.setattr(app_server, "generation_queue", queue)
    with app_server.jobs_lock:
        app_server.jobs.clear()
        app_server.jobs["cancelled"] = {"status": "cancelled"}

    response = app_server.app.test_client().post("/api/cancel/cancelled")

    assert response.status_code == 200
    assert response.get_json() == {
        "job_id": "cancelled",
        "status": "cancelled",
        "cancelled": False,
        "reason": "already_cancelled",
    }
    with app_server.jobs_lock:
        app_server.jobs.clear()


def test_terminal_pruning_includes_cancelled_jobs():
    with app_server.jobs_lock:
        app_server.jobs.clear()
        for index in range(52):
            app_server.jobs[f"cancelled-{index}"] = {"status": "cancelled"}
        app_server.jobs["active"] = {"status": "generating"}

        app_server._prune_terminal_jobs_locked(retain=50)

        assert "cancelled-0" not in app_server.jobs
        assert "cancelled-1" not in app_server.jobs
        assert "cancelled-2" in app_server.jobs
        assert app_server.jobs["active"]["status"] == "generating"
        app_server.jobs.clear()
