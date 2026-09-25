"""Notices a lab's ``lab.conf`` and ``*.startup`` files changing on disk behind this app's back.

A lab is a folder the user may well be editing in another program — an editor, ``git pull``, a
script — and nothing else would tell the backend: the registry's model of a lab is built from
``lab.conf`` once and kept, so an outside edit to it would never reach the topology, and an outside
edit to a device's startup script would not reach an already-running device on redeploy (see
``registry.mark_dirty``). What to *do* about a change is ``KatharaService.handle_disk_change``'s
business; this only says which files changed.

Polls rather than subscribing to OS notifications. The only candidate, ``watchfiles``, is an
optional accelerator that some packaged builds ship without (services/desktop's
``vendor-python-deps.mjs``), native notifications don't reach network drives, and the watched set
changes whenever a lab is created, opened, renamed or closed. Each poll costs one directory
listing per lab, of its top level only — ``lab.conf``, ``<device>.startup`` and
``shared.startup`` all live there — and one ``stat`` per watched file.
"""

import logging
import os
import threading
from pathlib import Path
from typing import Callable

from ..lab_conf_options import LAB_CONF_FILENAME

logger = logging.getLogger("kathara_api")

STARTUP_SUFFIX = ".startup"

# (mtime in ns, size): cheap to take, and a real edit changes at least one of them.
_Signature = tuple[int, int]


def is_watched(name: str) -> bool:
    """Whether a file at a lab's top level is one this watcher reports."""
    return name == LAB_CONF_FILENAME or (name.endswith(STARTUP_SUFFIX) and len(name) > len(STARTUP_SUFFIX))


def snapshot(directory: Path) -> dict[str, _Signature]:
    """The signature of every watched file directly in ``directory``; empty if it can't be listed."""
    signatures: dict[str, _Signature] = {}
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return signatures
    for entry in entries:
        if not is_watched(entry.name):
            continue
        try:
            if not entry.is_file():
                continue
            stat = entry.stat()
        except OSError:
            continue
        signatures[entry.name] = (stat.st_mtime_ns, stat.st_size)
    return signatures


class LabWatcher:
    """Polls every lab ``labs()`` names, and calls ``on_change(lab_id, changed_names)``.

    ``changed_names`` covers files that appeared, changed or disappeared since the previous poll.
    A lab seen for the first time only sets the baseline — it was just loaded, so there is nothing
    to catch up on. ``on_change`` returns the names it could not deal with yet (the lab is
    mid-deploy, or deployed and its lab.conf has to wait): their baseline stays where it was, so
    the same change is offered again next poll instead of being lost, while every other name
    moves on and is not reported twice.
    """

    def __init__(
        self,
        labs: Callable[[], dict[str, Path]],
        on_change: Callable[[str, set[str]], set[str]],
        interval: float = 1.0,
    ) -> None:
        self._labs = labs
        self._on_change = on_change
        self._interval = interval
        self._seen: dict[str, dict[str, _Signature]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def poll_once(self) -> None:
        labs = self._labs()
        for lab_id in set(self._seen) - set(labs):
            del self._seen[lab_id]
        for lab_id, directory in labs.items():
            current = snapshot(directory)
            previous = self._seen.get(lab_id)
            if previous is None:
                self._seen[lab_id] = current
                continue
            changed = {name for name in previous.keys() | current.keys() if previous.get(name) != current.get(name)}
            if not changed:
                continue
            try:
                pending = self._on_change(lab_id, changed) & changed
            except Exception:
                # A bug in the reaction must not stop the watcher for every other lab; the change
                # counts as seen, or the same failure would repeat on every poll.
                logger.warning("Handling a change to lab `%s` on disk failed", lab_id, exc_info=True)
                pending = set()
            baseline = dict(current)
            for name in pending:
                if name in previous:
                    baseline[name] = previous[name]
                else:
                    baseline.pop(name, None)
            self._seen[lab_id] = baseline

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="lab-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval + 5)
            self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.poll_once()
            except Exception:
                logger.warning("Lab watcher poll failed", exc_info=True)
