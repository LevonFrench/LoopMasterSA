"""Bounded, single-worker FIFO queue for GPU generation jobs."""

from collections import deque
from enum import Enum
import threading


class GenerationQueueFull(Exception):
    """Raised when every waiting slot in the generation queue is occupied."""


class GenerationCancelResult(Enum):
    """Outcome of an atomic attempt to remove a pending generation job."""

    CANCELLED = "cancelled"
    RUNNING = "running"
    NOT_PENDING = "not_pending"


class GenerationQueue:
    """Run generation jobs one at a time while bounding pending work.

    ``capacity`` counts waiting jobs, not the currently running job. This keeps
    the GPU workload serialized while still allowing a small, explicit backlog.
    """

    def __init__(self, handler, capacity=4, on_error=None, thread_factory=threading.Thread):
        if capacity < 1:
            raise ValueError("capacity must be at least 1")
        self._handler = handler
        self._capacity = capacity
        self._on_error = on_error
        self._thread_factory = thread_factory
        self._pending = deque()
        self._active_job_id = None
        self._condition = threading.Condition()
        self._started = False
        self._stopping = False

    @property
    def capacity(self):
        return self._capacity

    def start(self):
        with self._condition:
            if self._started:
                return
            self._started = True
            worker = self._thread_factory(
                target=self._run,
                name="generation-worker",
                daemon=True,
            )
            self._worker = worker
            worker.start()

    def submit(self, job_id, task):
        """Append a job atomically, preserving FIFO order."""
        with self._condition:
            if self._stopping:
                raise RuntimeError("generation queue is stopping")
            if len(self._pending) >= self._capacity:
                raise GenerationQueueFull("generation queue is full")
            self._pending.append((job_id, task))
            self._condition.notify()

    def snapshot(self):
        """Return immutable queue state suitable for status responses."""
        with self._condition:
            queued_job_ids = tuple(job_id for job_id, _ in self._pending)
            return {
                "active_job_id": self._active_job_id,
                "queued_job_ids": queued_job_ids,
                "queue_depth": len(queued_job_ids),
                "capacity": self._capacity,
            }

    def position(self, job_id):
        """Return a one-based waiting position, zero when running, or None."""
        with self._condition:
            if self._active_job_id == job_id:
                return 0
            for index, (queued_job_id, _) in enumerate(self._pending, start=1):
                if queued_job_id == job_id:
                    return index
            return None

    def cancel(self, job_id):
        """Remove a waiting job without ever interrupting active work.

        The active-job check and pending removal share the worker condition,
        making the result deterministic at the dequeue boundary: either this
        method removes the job, or the worker already owns it.
        """
        with self._condition:
            if self._active_job_id == job_id:
                return GenerationCancelResult.RUNNING
            for index, (queued_job_id, _) in enumerate(self._pending):
                if queued_job_id == job_id:
                    del self._pending[index]
                    self._condition.notify_all()
                    return GenerationCancelResult.CANCELLED
            return GenerationCancelResult.NOT_PENDING

    def stop(self, wait=True):
        """Stop after queued jobs finish. Primarily intended for clean tests."""
        with self._condition:
            self._stopping = True
            self._condition.notify_all()
            worker = getattr(self, "_worker", None)
        if wait and worker is not None:
            worker.join()

    def _run(self):
        while True:
            with self._condition:
                while not self._pending and not self._stopping:
                    self._condition.wait()
                if self._stopping and not self._pending:
                    return
                job_id, task = self._pending.popleft()
                self._active_job_id = job_id

            try:
                self._handler(task)
            except Exception as error:
                if self._on_error is not None:
                    try:
                        self._on_error(job_id, error)
                    except Exception:
                        # Error reporting must not terminate the sole worker.
                        pass
            finally:
                with self._condition:
                    self._active_job_id = None
                    self._condition.notify_all()
