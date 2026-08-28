"""In-memory registry of network scenarios created through the API.

Labs built from JSON keep their content (startup commands, in-memory filesystem, metadata)
only in the ``Lab`` object; that state cannot be fully recovered from the backend. The registry
retains those objects for their lifetime. Operations on labs that exist in the backend but not
in the registry (e.g. after an API restart) fall back to reconstruction via the Kathara facade.

The registry also tracks, per lab, which devices have been written to (via the offline lab
filesystem, ``services.kathara_service``'s ``fs_*_offline`` methods) since their last (re)deploy —
just *which* machines changed, never their content. A machine's actual queued files/dirs/startup
live only on the real on-disk filesystem (``lab.fs``/``machine.fs``); there is deliberately no
second, in-memory copy of that content to keep in sync (an earlier design did keep one, and it
repeatedly drifted from disk — see the "ROOT_MACHINE" history in kathara_service.py).

The registry is process-local; the server therefore must run with a single worker.
"""

import threading
from typing import Optional

from Kathara.model.Lab import Lab


class LabRegistry:
    """Thread-safe mapping of lab name -> Lab object (+ per-lab dirty-machine tracking)."""

    def __init__(self) -> None:
        self._labs: dict[str, Lab] = {}
        self._dirty: dict[str, set[str]] = {}
        self._lock = threading.RLock()

    def add(self, lab: Lab) -> None:
        with self._lock:
            self._labs[lab.name] = lab

    def add_if_absent(self, lab: Lab) -> bool:
        """Add ``lab`` only if name is not already present."""
        with self._lock:
            if lab.name in self._labs:
                return False
            self._labs[lab.name] = lab
            return True

    def get(self, name: str) -> Optional[Lab]:
        with self._lock:
            return self._labs.get(name)

    def remove(self, name: str) -> Optional[Lab]:
        with self._lock:
            self._dirty.pop(name, None)
            return self._labs.pop(name, None)

    def names(self) -> list[str]:
        with self._lock:
            return list(self._labs.keys())

    def all(self) -> list[Lab]:
        with self._lock:
            return list(self._labs.values())

    # -- dirty-machine tracking -------------------------------------------------

    def mark_dirty(self, lab_name: str, machine_name: str) -> None:
        """Record that ``machine_name`` was written to (via the offline lab fs) since its last
        (re)deploy — the redeploy path uses this to decide which already-running devices are
        worth live-pushing into, without caching what actually changed."""
        with self._lock:
            self._dirty.setdefault(lab_name, set()).add(machine_name)

    def pop_dirty_machines(self, lab_name: str, machine_names: set[str]) -> set[str]:
        """Return the subset of ``machine_names`` marked dirty for ``lab_name``, and clear them —
        so an already-running machine that hasn't changed since its last push isn't redundantly
        live-pushed (and its startup script re-executed) on every subsequent redeploy."""
        with self._lock:
            dirty = self._dirty.get(lab_name)
            if not dirty:
                return set()
            touched = dirty & machine_names
            dirty -= touched
            return touched
