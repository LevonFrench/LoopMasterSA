"""Small in-memory sliding-window limiter for the local generation API."""

from collections import defaultdict, deque
import math
import threading
import time


class SlidingWindowRateLimiter:
    def __init__(self, limit, window_seconds, clock=time.monotonic):
        self.limit = max(1, int(limit))
        self.window_seconds = max(0.1, float(window_seconds))
        self._clock = clock
        self._events = defaultdict(deque)
        self._lock = threading.Lock()
        self._last_cleanup = None
        self._cleanup_interval = min(self.window_seconds, 60.0)

    def _prune_stale_identities(self, cutoff):
        for key, events in list(self._events.items()):
            while events and events[0] <= cutoff:
                events.popleft()
            if not events:
                del self._events[key]

    def allow(self, identity):
        now = self._clock()
        cutoff = now - self.window_seconds
        key = str(identity or "local")
        with self._lock:
            if (
                self._last_cleanup is None
                or now - self._last_cleanup >= self._cleanup_interval
            ):
                self._prune_stale_identities(cutoff)
                self._last_cleanup = now
            events = self._events[key]
            while events and events[0] <= cutoff:
                events.popleft()
            if len(events) >= self.limit:
                remaining = self.window_seconds - (now - events[0])
                return False, max(1, math.ceil(remaining))
            events.append(now)
            return True, 0
