"""Bounded parallel fan-out with partial results and exponential-backoff retries."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from queue import Empty, Queue
import threading
import time


@dataclass(frozen=True)
class FanoutResult:
    item: object
    ok: bool
    value: object = None
    error: str | None = None
    attempts: int = 1


class FanoutTimeoutError(TimeoutError):
    """Raised when one fan-out attempt exceeds its configured deadline."""


def _call_with_timeout(item, request_fn, timeout_seconds):
    """Run one request attempt without letting an uncooperative call block forever.

    Python cannot safely terminate a running thread. The attempt therefore runs in
    a daemon thread: after the deadline the caller can return a timeout result while
    the abandoned attempt finishes in the background. Request adapters should still
    honor ``timeout_seconds`` themselves and must be idempotent because a retry can
    overlap an attempt that ignored its deadline.
    """
    if timeout_seconds is None:
        return request_fn(item, None)

    timeout_seconds = float(timeout_seconds)
    if timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be greater than zero or None")

    outcome = Queue(maxsize=1)

    def invoke():
        try:
            outcome.put_nowait((True, request_fn(item, timeout_seconds)))
        except BaseException as error:
            outcome.put_nowait((False, error))

    attempt = threading.Thread(
        target=invoke,
        name="fanout-request",
        daemon=True,
    )
    attempt.start()

    try:
        succeeded, value = outcome.get(timeout=timeout_seconds)
    except Empty as error:
        raise FanoutTimeoutError(
            f"Request timed out after {timeout_seconds:.3f} seconds"
        ) from error

    if succeeded:
        return value
    raise value


def _run_with_retry(item, request_fn, timeout_seconds, retries, backoff_seconds, sleeper):
    attempts = 0
    while True:
        attempts += 1
        try:
            value = _call_with_timeout(item, request_fn, timeout_seconds)
            return FanoutResult(item=item, ok=True, value=value, attempts=attempts)
        except Exception as error:  # isolated: one failed item must not fail the batch
            if attempts > retries:
                return FanoutResult(
                    item=item,
                    ok=False,
                    error=str(error),
                    attempts=attempts,
                )
            sleeper(backoff_seconds * (2 ** (attempts - 1)))


def run_parallel_fanout(
    items,
    request_fn,
    *,
    timeout_seconds=30.0,
    retries=2,
    backoff_seconds=0.1,
    max_workers=4,
    sleeper=time.sleep,
):
    """Run all items concurrently and return one success/failure record per item."""
    materialized = list(items)
    if not materialized:
        return []
    workers = max(1, min(int(max_workers), len(materialized)))
    indexed_results = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="fanout") as executor:
        futures = {
            executor.submit(
                _run_with_retry,
                item,
                request_fn,
                timeout_seconds,
                max(0, int(retries)),
                max(0.0, float(backoff_seconds)),
                sleeper,
            ): index
            for index, item in enumerate(materialized)
        }
        for future in as_completed(futures):
            indexed_results[futures[future]] = future.result()
    return [indexed_results[index] for index in range(len(materialized))]
