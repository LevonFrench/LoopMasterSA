import threading
import time

from fanout import run_parallel_fanout


def test_fanout_retries_with_exponential_backoff_and_forwards_timeout():
    attempts = []
    sleeps = []

    def request(item, timeout_seconds):
        attempts.append((item, timeout_seconds))
        if len(attempts) < 3:
            raise TimeoutError("temporary")
        return "ok"

    results = run_parallel_fanout(
        ["draft"],
        request,
        timeout_seconds=1.25,
        retries=2,
        backoff_seconds=0.5,
        sleeper=sleeps.append,
    )

    assert results[0].ok
    assert results[0].attempts == 3
    assert attempts == [("draft", 1.25)] * 3
    assert sleeps == [0.5, 1.0]


def test_fanout_surfaces_partial_results_in_input_order():
    def request(item, _timeout_seconds):
        if item == "bad":
            raise RuntimeError("provider unavailable")
        return item.upper()

    results = run_parallel_fanout(
        ["first", "bad", "last"],
        request,
        retries=1,
        sleeper=lambda _: None,
    )

    assert [result.item for result in results] == ["first", "bad", "last"]
    assert results[0].value == "FIRST"
    assert not results[1].ok
    assert results[1].attempts == 2
    assert results[2].value == "LAST"


def test_fanout_returns_timeout_without_waiting_for_uncooperative_request():
    request_started = threading.Event()
    release_request = threading.Event()
    request_threads_are_daemon = []

    def request(_item, _timeout_seconds):
        request_threads_are_daemon.append(threading.current_thread().daemon)
        request_started.set()
        release_request.wait(timeout=2.0)
        return "too late"

    started_at = time.monotonic()
    try:
        results = run_parallel_fanout(
            ["slow"],
            request,
            timeout_seconds=0.03,
            retries=0,
            max_workers=1,
        )
        elapsed = time.monotonic() - started_at
    finally:
        release_request.set()

    assert request_started.is_set()
    assert request_threads_are_daemon == [True]
    assert elapsed < 0.5
    assert not results[0].ok
    assert results[0].attempts == 1
    assert "timed out after 0.030 seconds" in results[0].error.lower()
