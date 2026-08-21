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
        self._output_dir = os.path.abspath(output_dir)
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

    def record(
        self, file, kind, prompt="", bpm=None, duration=None, session=None,
        metadata_file=None,
    ):
        """Add or replace one entry, keyed by relative file path."""
        entry = {
            "file": file,
            "metadataFile": metadata_file,
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
            self._write_locked(data)
        return entry

    def remove(self, file):
        """Remove one relative audio path from the registry."""
        with self._lock:
            data = self._load_locked()
            kept = [entry for entry in data["entries"] if entry.get("file") != file]
            if len(kept) == len(data["entries"]):
                return False
            data["entries"] = kept
            self._write_locked(data)
            return True

    def remove_prefix(self, prefix):
        """Remove all entries below one relative session/track directory."""
        normalized = str(prefix).replace("\\", "/").rstrip("/") + "/"
        with self._lock:
            data = self._load_locked()
            kept = [
                entry for entry in data["entries"]
                if not str(entry.get("file", "")).replace("\\", "/").startswith(normalized)
            ]
            removed = len(data["entries"]) - len(kept)
            if removed:
                data["entries"] = kept
                self._write_locked(data)
            return removed

    def _write_locked(self, data):
        temp_path = self._path + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as metadata_file:
            json.dump(data, metadata_file, indent=2)
        os.replace(temp_path, self._path)

    def snapshot(self):
        with self._lock:
            data = self._load_locked()
            kept = []
            for entry in data["entries"]:
                relative = str(entry.get("file", "")).replace("/", os.sep)
                metadata_relative = str(entry.get("metadataFile") or "").replace("/", os.sep)
                if not relative or not os.path.isfile(os.path.join(self._output_dir, relative)):
                    continue
                if metadata_relative and not os.path.isfile(
                    os.path.join(self._output_dir, metadata_relative)
                ):
                    continue
                kept.append(entry)
            if len(kept) != len(data["entries"]):
                data["entries"] = kept
                self._write_locked(data)
            return data
