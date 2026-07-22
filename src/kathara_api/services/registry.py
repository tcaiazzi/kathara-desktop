"""In-memory registry of network scenarios created through the API.

Labs built from JSON keep their content (startup commands, in-memory filesystem, metadata)
only in the ``Lab`` object; that state cannot be fully recovered from the backend. The registry
retains those objects for their lifetime. Operations on labs that exist in the backend but not
in the registry (e.g. after an API restart) fall back to reconstruction via the Kathara facade.

The registry also holds each lab's "pending" file-import state (see ``services.lab_import``):
files/dirs/startup scripts queued per machine, applied on (every) deploy. Keeping this
server-side means it survives a page reload instead of being lost for labs that were imported
but not yet deployed.

The registry is process-local; the server therefore must run with a single worker.
"""

import threading
from typing import Optional

from Kathara.model.Lab import Lab

from ..schemas.lab_import import PendingMachineFiles


class LabRegistry:
    """Thread-safe mapping of lab name -> Lab object (+ pending import state)."""

    def __init__(self) -> None:
        self._labs: dict[str, Lab] = {}
        self._pending: dict[str, dict[str, PendingMachineFiles]] = {}
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
            self._pending.pop(name, None)
            return self._labs.pop(name, None)

    def names(self) -> list[str]:
        with self._lock:
            return list(self._labs.keys())

    def all(self) -> list[Lab]:
        with self._lock:
            return list(self._labs.values())

    # -- pending import state --------------------------------------------------

    def set_pending(self, lab_name: str, pending: dict[str, PendingMachineFiles]) -> None:
        """Replace the whole pending map for a lab (used right after import)."""
        with self._lock:
            self._pending[lab_name] = dict(pending)

    def get_pending(self, lab_name: str) -> dict[str, PendingMachineFiles]:
        with self._lock:
            return dict(self._pending.get(lab_name, {}))

    def update_pending_machine(
        self,
        lab_name: str,
        machine_name: str,
        files: Optional[dict[str, str]] = None,
        dirs: Optional[list[str]] = None,
        startup: Optional[str] = None,
    ) -> PendingMachineFiles:
        """Merge new files/dirs/startup into one machine's queued pending state."""
        with self._lock:
            lab_pending = self._pending.setdefault(lab_name, {})
            machine_pending = lab_pending.setdefault(machine_name, PendingMachineFiles())
            if files:
                machine_pending.files = {**machine_pending.files, **files}
            if dirs:
                machine_pending.dirs = sorted(set(machine_pending.dirs) | set(dirs))
            if startup is not None:
                machine_pending.startup = startup
            return machine_pending
