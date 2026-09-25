"""Fan-out of lab events — changes to labs made outside this app — to every open event stream.

Events are published from a plain thread (the disk watcher, ``services/lab_watch.py``) and
consumed on the event loop (``GET /api/events``, ``routers/events.py``), so each subscriber is an
``asyncio.Queue`` bound to the loop that created it, fed with ``call_soon_threadsafe``: publishing
never blocks, and no worker thread is parked per open stream.

Best-effort by design. A subscriber that stops reading (a stalled tab) has its queue fill up, and
further events for it are dropped rather than buffered without bound; the frontend treats an event
as a hint to re-read, never as the only copy of the state it describes.
"""

import asyncio
import logging
import threading
from typing import Any

logger = logging.getLogger("kathara_api")

# Plenty for a burst (one event per changed file per poll); a queue this full belongs to a stream
# nobody is reading.
_QUEUE_SIZE = 256


class LabEvents:
    """Thread-safe publish/subscribe of lab event dicts."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> asyncio.Queue:
        """A new queue receiving every event published from now on, on ``loop``."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_SIZE)
        with self._lock:
            self._subscribers[queue] = loop
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers.pop(queue, None)

    def publish(self, event: dict[str, Any]) -> None:
        """Hand ``event`` to every subscriber; callable from any thread."""
        with self._lock:
            targets = list(self._subscribers.items())
        for queue, loop in targets:
            try:
                loop.call_soon_threadsafe(self._offer, queue, event)
            except RuntimeError:
                # The loop is closed: its stream is gone, and so is the subscription.
                self.unsubscribe(queue)

    @staticmethod
    def _offer(queue: asyncio.Queue, event: dict[str, Any]) -> None:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.debug("Dropping a lab event for a stream that is not being read")
