"""Crash-safe, bounded persistence for generation job status records.

The history is deliberately a snapshot rather than an execution journal: GPU
work is never resumed after a restart.  Only meaningful status transitions are
published by the caller, keeping high-frequency progress updates off disk.
"""

from collections import OrderedDict
from copy import deepcopy
import json
import os
import threading
import time
import uuid


HISTORY_VERSION = 1
ACTIVE_STATUSES = frozenset({"queued", "generating"})
TERMINAL_STATUSES = frozenset({"done", "error", "cancelled"})
KNOWN_STATUSES = ACTIVE_STATUSES | TERMINAL_STATUSES
INTERRUPTED_ERROR = "Generation interrupted because the server restarted."


class JobHistory:
    """Persist recent jobs in one atomic JSON snapshot under ``output_dir``.

    Public operations intentionally fail soft.  Persistence trouble is exposed
    through ``last_error`` for diagnostics but never blocks server startup or a
    generation request.
    """

    def __init__(self, output_dir, max_terminal=50, clock=time.time):
        if max_terminal < 1:
            raise ValueError("max_terminal must be at least 1")
        self._state_dir = os.path.join(os.path.abspath(output_dir), ".loopmaster")
        self.path = os.path.join(self._state_dir, "job-history.json")
        self._max_terminal = max_terminal
        self._clock = clock
        self._lock = threading.Lock()
        self._records = OrderedDict()
        self.last_error = None

    def recover(self):
        """Load history and convert abandoned active work into terminal errors."""
        with self._lock:
            self._records = self._load_locked()
            changed = False
            for entry in self._records.values():
                job = entry["job"]
                if job.get("status") in ACTIVE_STATUSES:
                    job.update({
                        "status": "error",
                        "progress": None,
                        "error": INTERRUPTED_ERROR,
                        "queue_position": None,
                        "interrupted": True,
                    })
                    entry["updated_at"] = float(self._clock())
                    changed = True
            changed = self._trim_locked() or changed
            if changed:
                self._write_locked()
            return {
                job_id: deepcopy(entry["job"])
                for job_id, entry in self._records.items()
            }

    def record(self, job_id, job):
        """Publish one important state transition.

        The caller owns transition filtering.  Recording is synchronous so a
        successful return means the atomic snapshot was attempted; write errors
        remain non-fatal and are available in ``last_error``.
        """
        if not isinstance(job_id, str) or not job_id or not isinstance(job, dict):
            return False
        status = job.get("status")
        if status not in KNOWN_STATUSES:
            return False

        with self._lock:
            try:
                entry = {
                    "job": deepcopy(job),
                    "updated_at": float(self._clock()),
                }
            except Exception as error:
                self.last_error = f"Could not stage job history: {error}"
                return False
            self._records.pop(job_id, None)
            self._records[job_id] = entry
            self._trim_locked()
            return self._write_locked()

    def remove(self, job_id):
        """Forget a job that was rejected before it entered the queue."""
        with self._lock:
            if self._records.pop(job_id, None) is None:
                return True
            return self._write_locked()

    def _load_locked(self):
        if not os.path.exists(self.path):
            return OrderedDict()
        try:
            with open(self.path, "r", encoding="utf-8") as input_file:
                payload = json.load(input_file)
            return self._validate_payload(payload)
        except Exception as error:
            self.last_error = f"Could not load job history: {error}"
            self._quarantine_locked()
            return OrderedDict()

    def _validate_payload(self, payload):
        if not isinstance(payload, dict) or payload.get("version") != HISTORY_VERSION:
            raise ValueError("unsupported job history format")
        raw_records = payload.get("records")
        if not isinstance(raw_records, list):
            raise ValueError("job history records must be a list")

        records = OrderedDict()
        for raw_entry in raw_records:
            if not isinstance(raw_entry, dict):
                raise ValueError("invalid job history record")
            job_id = raw_entry.get("job_id")
            job = raw_entry.get("job")
            updated_at = raw_entry.get("updated_at")
            if (
                not isinstance(job_id, str)
                or not job_id
                or not isinstance(job, dict)
                or job.get("status") not in KNOWN_STATUSES
                or not isinstance(updated_at, (int, float))
            ):
                raise ValueError("invalid job history record")
            records.pop(job_id, None)
            records[job_id] = {
                "job": deepcopy(job),
                "updated_at": float(updated_at),
            }
        return records

    def _trim_locked(self):
        terminal_ids = [
            job_id
            for job_id, entry in self._records.items()
            if entry["job"].get("status") in TERMINAL_STATUSES
        ]
        removed = False
        for job_id in terminal_ids[:-self._max_terminal]:
            self._records.pop(job_id, None)
            removed = True
        return removed

    def _payload_locked(self):
        return {
            "version": HISTORY_VERSION,
            "records": [
                {
                    "job_id": job_id,
                    "updated_at": entry["updated_at"],
                    "job": entry["job"],
                }
                for job_id, entry in self._records.items()
            ],
        }

    def _write_locked(self):
        temp_path = None
        try:
            os.makedirs(self._state_dir, exist_ok=True)
            temp_path = os.path.join(
                self._state_dir,
                f".{os.path.basename(self.path)}.{uuid.uuid4().hex}.tmp",
            )
            with open(temp_path, "w", encoding="utf-8", newline="\n") as output:
                json.dump(
                    self._payload_locked(),
                    output,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, self.path)
            self.last_error = None
            return True
        except Exception as error:
            self.last_error = f"Could not save job history: {error}"
            return False
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except OSError:
                    pass

    def _quarantine_locked(self):
        try:
            os.makedirs(self._state_dir, exist_ok=True)
            quarantine_path = (
                f"{self.path}.corrupt-{int(self._clock())}-{uuid.uuid4().hex[:8]}"
            )
            os.replace(self.path, quarantine_path)
        except OSError:
            # An unreadable state file is safe to ignore; later atomic writes can
            # replace it if quarantine is unavailable.
            pass
