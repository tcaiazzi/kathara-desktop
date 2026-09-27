"""The official Kathara images last listed from Docker Hub, kept on disk across restarts.

Listing them is a fan-out of a few dozen requests to Docker Hub (``docker_hub``), and the list
changes rarely, so ``KatharaService._official_images`` keeps what it last fetched in a file of the
backend's state directory (``ApiSettings.state_dir``): a restarted app serves it straight away
instead of fetching again, and an app with no network still has a list to offer. With no state
directory configured, nothing is written and the in-memory cache is all there is.

This module only reads and writes the file; how old a copy may be before it is fetched again is
the service's decision.
"""

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import NamedTuple, Optional

logger = logging.getLogger("kathara_api")

OFFICIAL_IMAGES_FILENAME = "official_images.json"
_FORMAT_VERSION = 1


class StoredImages(NamedTuple):
    images: list[str]
    # Seconds since the epoch — wall-clock time, since the copy has to outlive the process.
    fetched_at: float


class OfficialImagesFile:
    """The on-disk copy of the official image list, or nothing when ``path`` is ``None``."""

    def __init__(self, path: Optional[Path]) -> None:
        self._path = path

    def load(self) -> Optional[StoredImages]:
        """The stored list, or ``None`` when there is none or it can't be used.

        A truncated or hand-edited file only costs a fetch, so it is logged and ignored; the next
        successful fetch overwrites it.
        """
        if self._path is None or not self._path.is_file():
            return None
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != _FORMAT_VERSION:
                raise ValueError("unknown format")
            images, fetched_at = data["images"], data["fetched_at"]
            if not isinstance(images, list) or not all(isinstance(i, str) for i in images):
                raise ValueError("`images` is not a list of names")
            if isinstance(fetched_at, bool) or not isinstance(fetched_at, (int, float)):
                raise ValueError("`fetched_at` is not a time")
            return StoredImages(list(images), float(fetched_at))
        except (OSError, ValueError, KeyError):
            logger.warning("Ignoring unreadable %s", self._path, exc_info=True)
            return None

    def save(self, images: list[str], fetched_at: float) -> None:
        """Write the list atomically (tmp file + ``os.replace``). A failure is logged and
        otherwise ignored: the list is still served from memory, it just won't survive a restart."""
        if self._path is None:
            return
        body = {"version": _FORMAT_VERSION, "fetched_at": fetched_at, "images": images}
        tmp: Optional[str] = None
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            # A fresh temporary name every time, not a fixed one: a leftover from a crash —
            # possibly root-owned, written by an elevated backend — must not block every later save.
            fd, tmp = tempfile.mkstemp(dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(body, indent=2) + "\n")
            os.replace(tmp, self._path)
        except OSError:
            logger.warning("Could not save the official image list to %s", self._path, exc_info=True)
            if tmp is not None and os.path.exists(tmp):
                os.unlink(tmp)
