"""In-memory registry of network scenarios created through the API.

Labs built from JSON keep their content (startup commands, in-memory filesystem, metadata)
only in the ``Lab`` object; that state cannot be fully recovered from the backend. The registry
retains those objects for their lifetime. Operations on labs that exist in the backend but not
in the registry (e.g. after an API restart) fall back to reconstruction via the Kathara facade.

The registry also tracks, per lab, which devices have been written to (via the offline lab
filesystem, ``services.kathara_service``'s ``fs_*_offline`` methods) since their last (re)deploy —
just *which* machines changed, never their content. A machine's actual queued files/dirs/startup
live only on the real on-disk filesystem (``lab.fs``/``machine.fs``): a second, in-memory copy would
have to be kept in sync with every write, and drifts silently the moment one is missed, so there
deliberately is none. Reads resolve through ``KatharaService._offline_fs_owner`` and ``_fs_for``
instead.

It also keeps each lab's last deploy failure, so a lab left partly running by one can say why —
see ``set_deploy_failure`` — and its draft collision domains, see ``add_draft``.

The registry is process-local; the server therefore must run with a single worker.
"""

import threading
from pathlib import Path
from typing import NamedTuple, Optional

from Kathara.model.Lab import Lab


class DeployFailure(NamedTuple):
    """Why a lab's last deploy failed, and which devices it was meant to start: the ones among
    them still stopped are the ones the message explains."""

    message: str
    machines: frozenset[str]


class LabRegistry:
    """Thread-safe mapping of lab id -> Lab object and its directory (+ per-lab dirty-machine
    tracking).

    Keyed by ``lab.hash``, which *is* the lab's id (see ``lab_store.lab_id_for``): the key and the
    identity Kathara labels the lab's containers with can then never disagree. The directory is
    kept beside the ``Lab`` because nothing on the ``Lab`` itself says where it lives on disk.
    """

    def __init__(self) -> None:
        self._labs: dict[str, Lab] = {}
        self._dirs: dict[str, Path] = {}
        self._dirty: dict[str, set[str]] = {}
        self._deploy_failures: dict[str, DeployFailure] = {}
        self._drafts: dict[str, set[str]] = {}
        self._lock = threading.RLock()

    def add(self, lab: Lab, directory: Path) -> None:
        with self._lock:
            self._labs[lab.hash] = lab
            self._dirs[lab.hash] = directory

    def add_if_absent(self, lab: Lab, directory: Path) -> bool:
        """Add ``lab`` only if its id is not already present."""
        with self._lock:
            if lab.hash in self._labs:
                return False
            self.add(lab, directory)
            return True

    def get(self, lab_id: str) -> Optional[Lab]:
        with self._lock:
            return self._labs.get(lab_id)

    def directory(self, lab_id: str) -> Optional[Path]:
        with self._lock:
            return self._dirs.get(lab_id)

    def remove(self, lab_id: str) -> Optional[Lab]:
        with self._lock:
            self._dirty.pop(lab_id, None)
            self._deploy_failures.pop(lab_id, None)
            self._drafts.pop(lab_id, None)
            self._dirs.pop(lab_id, None)
            return self._labs.pop(lab_id, None)

    def directories(self) -> dict[str, Path]:
        """Every registered lab's id and directory."""
        with self._lock:
            return dict(self._dirs)

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._labs.keys())

    def all(self) -> list[Lab]:
        with self._lock:
            return list(self._labs.values())

    # -- last deploy failure ----------------------------------------------------

    def set_deploy_failure(self, lab_id: str, failure: DeployFailure) -> None:
        """Record why the last deploy of ``lab_id`` failed. Kathara starts a lab's devices side by
        side, so a failure on one does not stop the others: the lab can be left partly running,
        and this is what explains the devices that are not."""
        with self._lock:
            self._deploy_failures[lab_id] = failure

    def clear_deploy_failure(self, lab_id: str) -> None:
        with self._lock:
            self._deploy_failures.pop(lab_id, None)

    def deploy_failure(self, lab_id: str) -> Optional[DeployFailure]:
        with self._lock:
            return self._deploy_failures.get(lab_id)

    # -- draft collision domains ------------------------------------------------

    def add_draft(self, lab_id: str, link_name: str) -> None:
        """Record a collision domain added with no device on it. lab.conf has no way to write such a
        domain down — domains exist there only through the interfaces that name them — so this is
        the only place it lives: it survives the lab being rebuilt from lab.conf
        (``KatharaService._reload_lab_from_disk``), not a backend restart or a rename."""
        with self._lock:
            self._drafts.setdefault(lab_id, set()).add(link_name)

    def discard_draft(self, lab_id: str, link_name: str) -> None:
        with self._lock:
            names = self._drafts.get(lab_id)
            if names is not None:
                names.discard(link_name)

    def drafts(self, lab_id: str) -> set[str]:
        with self._lock:
            return set(self._drafts.get(lab_id, ()))

    # -- dirty-machine tracking -------------------------------------------------

    def mark_dirty(self, lab_id: str, machine_name: str) -> None:
        """Record that ``machine_name`` was written to (via the offline lab fs) since its last
        (re)deploy — the redeploy path uses this to decide which already-running devices are
        worth live-pushing into, without caching what actually changed."""
        with self._lock:
            self._dirty.setdefault(lab_id, set()).add(machine_name)

    def pop_dirty_machines(self, lab_id: str, machine_names: set[str]) -> set[str]:
        """Return the subset of ``machine_names`` marked dirty for ``lab_id``, and clear them —
        so an already-running machine that hasn't changed since its last push isn't redundantly
        live-pushed (and its startup script re-executed) on every subsequent redeploy."""
        with self._lock:
            dirty = self._dirty.get(lab_id)
            if not dirty:
                return set()
            touched = dirty & machine_names
            dirty -= touched
            return touched
