import sys
from pathlib import Path

import pytest


APP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP_DIR))

import app_server
from job_history import JobHistory


@pytest.fixture(autouse=True)
def isolate_app_job_history(monkeypatch, tmp_path):
    """Keep route tests from reading or writing the user's durable ledger."""
    isolated_history = JobHistory(tmp_path / "outputs")
    monkeypatch.setattr(app_server, "job_history", isolated_history)
    with app_server.jobs_lock:
        original_jobs = dict(app_server.jobs)
        app_server.jobs.clear()
    yield isolated_history
    with app_server.jobs_lock:
        app_server.jobs.clear()
        app_server.jobs.update(original_jobs)
