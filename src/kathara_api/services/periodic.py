"""A background thread that calls one function every so often, for as long as it is running.

Every poll the backend runs on its own — the disk watcher (``services/lab_watch.py``), the check for
labs started or stopped outside the app (``KatharaService.check_running_labs``) — gets one of its
own, started and stopped by the app's lifespan (``main._lifespan``). One each rather than one for
all: a poll that blocks — a Docker call to a daemon that accepts the connection but never answers
has no timeout (Kathara builds its client with ``timeout=None``) — then only holds up itself.
"""

import logging
import threading
from typing import Callable, Optional

logger = logging.getLogger("kathara_api")


class Periodic:
    """Calls ``tick`` every ``interval`` seconds on a daemon thread named ``name``, from ``start``
    until ``stop``. A failing ``tick`` is logged and the next one still runs."""

    def __init__(self, tick: Callable[[], object], interval: float, name: str) -> None:
        self._tick = tick
        self._interval = interval
        self._name = name
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name=self._name, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop, waiting a bounded time for the tick in progress: one stuck in a call that never
        returns is left behind, which as a daemon thread keeps no process from exiting."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval + 5)
            self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._tick()
            except Exception:
                logger.warning("Background poll `%s` failed", self._name, exc_info=True)
