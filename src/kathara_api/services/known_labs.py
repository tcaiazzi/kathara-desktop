"""The lab directories opened from outside the labs root, persisted across restarts.

A lab under the labs root needs no record: every subdirectory there is a lab
(``LabStore.lab_dirs``). A lab opened from anywhere else (``KatharaService.open_lab``) is only
known because someone opened it, so this module remembers it — most recently opened first, the
order a "recent labs" list shows them in.

The file lives in the backend's state directory (``ApiSettings.state_dir``), never inside a lab:
it lists *which* directories this app may read and write, so it must not travel with any one of
them. With no state directory configured, the list lives in memory only, which is what every
deployment that cannot open a folder by path (no shell token, see ``dependencies``) amounts to.
"""

import json
import logging
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger("kathara_api")

KNOWN_LABS_FILENAME = "known_labs.json"
_FORMAT_VERSION = 1


class KnownLabs:
    """Thread-safe, ordered set of lab directories, written through to a JSON file."""

    def __init__(self, path: Optional[Path]) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._dirs: list[Path] = self._load()

    def dirs(self) -> list[Path]:
        """Every known directory, most recently opened first."""
        with self._lock:
            return list(self._dirs)

    def add(self, directory: Path) -> None:
        """Record ``directory`` as the most recently opened one (moving it up if already known)."""
        with self._lock:
            self._dirs = [directory, *(d for d in self._dirs if d != directory)]
            self._save()

    def remove(self, directory: Path) -> None:
        with self._lock:
            kept = [d for d in self._dirs if d != directory]
            if len(kept) != len(self._dirs):
                self._dirs = kept
                self._save()

    def replace(self, old: Path, new: Path) -> None:
        """Swap ``old`` for ``new`` in place — a rename keeps the lab where it was in the list."""
        with self._lock:
            self._dirs = [new if d == old else d for d in self._dirs]
            self._save()

    # -- persistence -------------------------------------------------------------

    def _load(self) -> list[Path]:
        """The persisted list, or an empty one when there is no file or it can't be used.

        A hand-edited or truncated file must not stop the backend from starting, so it is logged
        and treated as empty; the next change overwrites it with a valid one.
        """
        if self._path is None or not self._path.is_file():
            return []
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            entries = data["labs"] if isinstance(data, dict) else None
            if not isinstance(entries, list):
                raise ValueError("`labs` is not a list")
            dirs: list[Path] = []
            for entry in entries:
                path = entry.get("path") if isinstance(entry, dict) else None
                if isinstance(path, str) and os.path.isabs(path):
                    candidate = Path(path)
                    if candidate not in dirs:
                        dirs.append(candidate)
            return dirs
        except (OSError, ValueError, KeyError):
            logger.warning("Ignoring unreadable %s", self._path, exc_info=True)
            return []

    def _save(self) -> None:
        """Write the list atomically (tmp file + ``os.replace``), so a crash never truncates it."""
        if self._path is None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        body = {"version": _FORMAT_VERSION, "labs": [{"path": str(d)} for d in self._dirs]}
        # A fresh temporary name every time, not a fixed one: a leftover from a crash — possibly
        # root-owned, written by an elevated backend — must not block every later save.
        fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(body, indent=2) + "\n")
            os.replace(tmp, self._path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
