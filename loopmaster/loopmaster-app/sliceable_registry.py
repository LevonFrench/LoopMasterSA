"""Registry of generated files the (upcoming) slicer can consume.

One JSON file at OUTPUT_DIR/sliceable.json. Hit sheets, breaks, and any
loop generated with the `sliceable` flag are recorded here, so the slicer
reads a single list instead of scanning output folders.
"""

import json
import os
import threading
import time


class SliceableRegistry:
    def __init__(self, output_dir):
        self._path = os.path.join(output_dir, "sliceable.json")
        self._lock = threading.Lock()

    def _load_locked(self):
        try:
            with open(self._path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("entries"), list):
                return data
        except (OSError, ValueError):
            pass
        return {"version": 1, "entries": []}

    def record(self, file, kind, prompt="", bpm=None, duration=None, session=None):
        """Add or replace one entry, keyed by relative file path."""
        entry = {
            "file": file,
            "kind": kind,
            "prompt": prompt,
            "bpm": bpm,
            "duration": duration,
            "session": session,
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        with self._lock:
            data = self._load_locked()
            data["entries"] = [e for e in data["entries"] if e.get("file") != file]
            data["entries"].append(entry)
            temp_path = self._path + ".tmp"
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            os.replace(temp_path, self._path)
        return entry

    def snapshot(self):
        with self._lock:
            return self._load_locked()
