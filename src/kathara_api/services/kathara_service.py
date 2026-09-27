"""Adapter that wraps the singleton Kathara facade for the REST API.

Design notes:
- The Kathara facade and ``Setting`` are process-wide singletons and Kathara is not safe for
  concurrent *independent* mutating calls, so state-changing operations on an existing lab are
  serialized behind a single re-entrant lock (``_mutate_lock``). Read-only operations (stats,
  exec, reconstruction) run concurrently.
- Lab *creation* is serialized per lab directory instead (``_claiming``), not globally: its
  critical section contains the on-disk write, so holding the global lock across a large .zip
  extraction would stall unrelated labs. Both are needed — see ``_claiming``.
- Every per-lab method takes a ``lab_id`` (``lab_store.lab_id_for``: Kathara's hash of the lab's
  absolute path), never a name. It is the registry key, the URL segment and the ``lab_hash`` every
  facade call is made with, so a lab is found the same way whichever of the three is asking.
- All facade calls block; routers invoke these methods from FastAPI's threadpool (sync handlers)
  or via ``iterate_in_threadpool`` for streams.
- Kathara settings live in ``kathara.conf``, the file the Kathara CLI uses too: read once at
  startup (``load_persisted_settings``), written by every ``update_settings``. Most are read
  fresh at the point of use by the framework itself, so ``update_settings`` can change them at
  any time. ``manager_type`` is the one exception: ``Kathara.get_instance()`` picks the concrete
  manager class exactly once and Kathara has no supported way to swap it out afterward for the
  life of the process, so changing it once the facade has been instantiated is rejected rather
  than silently doing nothing.
"""

import errno
import functools
import io
import logging
import os
import posixpath
import re
import shlex
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Callable, Generator, Optional, Union

import fs.copy
import fs.errors
import fs.path
from docker.errors import APIError, DockerException
from docker.models.containers import Container
from Kathara.exceptions import (
    DockerDaemonConnectionError,
    HTTPConnectionError,
    InvocationError,
    LabNotFoundError,
    MachineNotFoundError,
    MachineNotRunningError,
    MachineOptionError,
    PrivilegeError,
)
from Kathara.manager.docker.stats.DockerMachineStats import DockerMachineStats
from Kathara.manager.Kathara import Kathara
from Kathara.model.Lab import Lab
from Kathara.model.Link import Link
from Kathara.model.Machine import Machine
from Kathara.setting.Setting import Setting
from Kathara.utils import is_admin
from pydantic import ValidationError

from ..config import get_settings
from ..errors import (
    ApiError,
    BinaryFileError,
    InvalidSettingsError,
    LabAlreadyRegisteredError,
    LabCloseRefusedError,
    LabConfLockedError,
    LabDeleteRefusedError,
    LabFilePermissionError,
    LabRenameLockedError,
    LabTransitioningError,
    LinkInUseError,
    NotALabError,
    PathNotFoundError,
    SettingsFileInvalidError,
    SettingsLockedError,
    SettingsPersistError,
    UnsupportedOperationError,
    known_error_detail,
)
from ..lab_conf_options import LAB_CONF_FILENAME
from ..schemas.examples import ExampleSummary
from ..schemas.filesystem import FsEntry, FsSearchMatch
from ..schemas.gallery import GalleryCatalog, GalleryLabSummary
from ..schemas.images import AvailableImages, LabImagesStatus, LabImageStatus
from ..schemas.lab import LabConfView, LabCreate, LabLayout
from ..schemas.machine import MachineCreate, MachineUpdate
from . import (
    docker_hub,
    examples,
    image_pull,
    lab_builder,
    lab_conf_edit,
    lab_gallery,
    lab_import,
    lab_store,
    live_addresses,
    settings_store,
)
from .docker_tty import SHELL_PATHS
from .known_labs import KNOWN_LABS_FILENAME, KnownLabs
from .lab_events import LabEvents
from .lab_store import LabPlace, LabStore, is_within, lab_id_for
from .lab_watch import STARTUP_SUFFIX
from .official_images_cache import OFFICIAL_IMAGES_FILENAME, OfficialImagesFile
from .registry import DeployFailure, LabRegistry

logger = logging.getLogger("kathara_api")

# Reserved "machine name" for files/dirs directly under the lab root (no device) — the Lab
# Configuration tab's tree root. Structurally impossible for a real device to collide with: device
# names are validated against MACHINE_NAME_PATTERN (schemas/machine.py), which is lowercase-only.
ROOT_MACHINE = "ROOT"

# What Kathara's Docker manager calls itself — a `@staticmethod` returning this literal, so it holds
# whether or not a daemon is reachable. Named here because `system_info` reports it from two places
# (the active manager and the available-managers map) and they must not drift apart.
_DOCKER_MANAGER_LABEL = "Docker (Kathara)"

# A privileged device needs the backend itself running as root (Kathara's DockerMachine.create).
# Getting root restarts the backend, and only a whole-lab deploy picks up again after that restart
# (the desktop shell's `resumeDeploy`), so a single-device deploy that meets this refusal says so:
# the hint for the error the request answers with, the short form for what the lab keeps showing
# (LabSummary.deploy_error).
_PRIVILEGED_REFUSAL_RE = re.compile(r"^You must be root in order to start device `[^`]+` in privileged mode\.$")
PRIVILEGED_SINGLE_DEPLOY_HINT = (
    "Deploying a single privileged device isn't supported yet: "
    "deploy the whole lab to grant administrator privileges."
)
PRIVILEGED_ONLY_WITH_LAB = (
    "privileged devices start only with the whole lab (Deploy asks for administrator privileges)."
)


def _lab_not_found(lab_id: str) -> LabNotFoundError:
    """The 404 for an unknown ``lab_id``, worded the same by every lookup that raises it."""
    return LabNotFoundError(f"Lab `{lab_id}` not found.")


def _decode(output: Optional[bytes]) -> str:
    """A command's output stream as text: None (some backends' empty stream) as "", bytes that
    aren't UTF-8 replaced rather than failing the read."""
    return (output or b"").decode("utf-8", "replace")


def _privileged_device_refused(exc: Exception) -> bool:
    """Whether ``exc`` is Kathara refusing a privileged device to a backend that isn't root — and
    not one of its other PrivilegeErrors (external collision domains), which a whole-lab deploy
    would not fix either."""
    return isinstance(exc, PrivilegeError) and bool(_PRIVILEGED_REFUSAL_RE.match(str(exc)))


# Caps for fs_search_offline — module-level (not class-level) so _search_lines_in_text, a bare
# module-level helper, can use them without forward-referencing the class body. The per-file size
# cap is deliberately *not* here: it is ApiSettings.max_bytes_per_file, which PUT /settings can
# change at runtime, so fs_search_offline reads it live like every other consumer does.
_SEARCH_MAX_MATCHES_PER_FILE = 200
_SEARCH_MAX_TOTAL_MATCHES = 1000
_SEARCH_MAX_LINE_LENGTH = 300


def _search_lines_in_text(
    text: str, query: str, case_sensitive: bool, max_matches: int
) -> tuple[list[tuple[int, str]], bool]:
    """Line-by-line substring search over already-decoded text — the matching core behind
    ``fs_search_offline``, kept dependency-free so it's directly unit-testable. Returns
    ``(matches, capped)``; ``capped`` is True once ``max_matches`` was hit, meaning there may be
    more matches in ``text`` after the last one returned."""
    needle = query if case_sensitive else query.lower()
    matches: list[tuple[int, str]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        haystack = line if case_sensitive else line.lower()
        if needle in haystack:
            snippet = line if len(line) <= _SEARCH_MAX_LINE_LENGTH else line[:_SEARCH_MAX_LINE_LENGTH] + "…"
            matches.append((lineno, snippet))
            if len(matches) >= max_matches:
                return matches, True
    return matches, False


# -- symlink-safe tree operations for a lab's on-disk fs -------------------------------------------
#
# pyfilesystem's OSFS follows symbolic links everywhere: `removetree` deletes *through* a symlinked
# directory, `fs.copy.copy_dir` and `walk` copy and list whatever it points at. A lab opened from
# anywhere on the host (`open_lab`) may hold such a link, so these do the same jobs on the real
# paths without ever following one: a link is removed, copied or skipped as the link it is.
# `_confine` checks the path an operation is *given*; these keep everything *beneath* it in the lab.
# A path-less (in-memory) fs has no links, and keeps pyfilesystem's own behaviour.


def _sys_path(target_fs, path: str) -> Optional[str]:
    try:
        return target_fs.getsyspath(path)
    except fs.errors.NoSysPath:
        return None


def _remove_tree(target_fs, path: str) -> None:
    """``removetree`` that removes a symlinked directory's link, never what it points at."""
    real = _sys_path(target_fs, path)
    if real is None:
        target_fs.removetree(path)
    elif os.path.islink(real):
        os.unlink(real)
    else:
        shutil.rmtree(real)


def _copy_tree(src_fs, src: str, dst_fs, dst: str) -> None:
    """Copy a directory into ``dst`` (merging into one that exists), copying links as links."""
    src_real, dst_real = _sys_path(src_fs, src), _sys_path(dst_fs, dst)
    if src_real is None or dst_real is None:
        dst_fs.makedirs(dst, recreate=True)
        fs.copy.copy_dir(src_fs, src, dst_fs, dst)
        return
    shutil.copytree(src_real, dst_real, symlinks=True, dirs_exist_ok=True)


# -- permission failures on a lab's on-disk fs -----------------------------------------------------
#
# What turns a file the user can't change in a lab folder into a LabFilePermissionError naming it.


_PERMISSION_ERRNO_MARKS = (f"[Errno {errno.EACCES}]", f"[Errno {errno.EPERM}]")


def _permission_denied_path(exc: Exception) -> Optional[str]:
    """The real path a permission failure is about, ``""`` when it is one but names no path, or
    ``None`` when ``exc`` is some other failure. pyfilesystem's ``PermissionDenied`` keeps the
    ``OSError`` it wraps; ``shutil.copytree`` collects its failures as ``(src, dst, str(why))``,
    so only the message tells a permission failure apart there."""
    if isinstance(exc, fs.errors.PermissionDenied):
        filename = getattr(exc.exc, "filename", None)
        return os.fsdecode(filename) if filename is not None else ""
    if isinstance(exc, PermissionError):
        return os.fsdecode(exc.filename) if exc.filename is not None else ""
    if isinstance(exc, shutil.Error) and exc.args and isinstance(exc.args[0], list):
        for src, _dst, why in exc.args[0]:
            if any(mark in str(why) for mark in _PERMISSION_ERRNO_MARKS):
                return os.fsdecode(src)
    return None


def _lab_display_path(real: str, lab_dir: Optional[Path]) -> str:
    """``real`` as the offline API names it (``/shared/x``), or as it is when outside the lab."""
    if lab_dir is not None and real and is_within(Path(real), lab_dir):
        relative = Path(real).resolve().relative_to(lab_dir.resolve()).as_posix()
        return "/" if relative == "." else f"/{relative}"
    return real


def _owned_by_another_account(path: str) -> str:
    what = f"`{path}`" if path else "A file"
    return f"{what} is owned by another account (usually root: a running device wrote it)"


def _lab_file_permissions(method):
    """Decorates an offline fs operation taking ``lab_id`` first, so a file the user can't write
    — typically one a running device wrote as root into ``shared/`` — is reported by name as a
    LabFilePermissionError instead of an unhandled 500."""

    @functools.wraps(method)
    def wrapper(self: "KatharaService", lab_id: str, *args, **kwargs):
        try:
            return method(self, lab_id, *args, **kwargs)
        except (fs.errors.PermissionDenied, PermissionError, shutil.Error) as exc:
            denied = _permission_denied_path(exc)
            if denied is None:
                raise
            # Creating a file fails on the folder that would hold it, and names the file.
            if denied and not os.path.lexists(denied):
                denied = os.path.dirname(denied)
            path = _lab_display_path(denied, self._lab_dir(lab_id))
            raise LabFilePermissionError(
                f"{_owned_by_another_account(path)}, so the app can't change it."
            ) from exc

    return wrapper


# -- symlink-safe tree operations, continued -------------------------------------------------------


def _walk(target_fs, path: str = "/") -> Generator[tuple[str, bool], None, None]:
    """Every entry under ``path`` as ``(fs path, is_dir)``, without descending into a symlinked
    directory — which also keeps a link loop (``loop -> .``) from walking forever."""
    base = _sys_path(target_fs, "/")
    start = _sys_path(target_fs, path)
    if base is None or start is None:
        for dir_path in target_fs.walk.dirs(path=path):
            yield dir_path, True
        for file_path in target_fs.walk.files(path=path):
            yield file_path, False
        return
    for root, dirnames, filenames in os.walk(start):
        for name, is_dir in [*((d, True) for d in dirnames if not os.path.islink(os.path.join(root, d))),
                             *((f, False) for f in filenames)]:
            rel = os.path.relpath(os.path.join(root, name), base).replace(os.sep, "/")
            yield f"/{rel}", is_dir


class KatharaService:
    """Thread-safe wrapper around ``Kathara.get_instance()``."""

    # How long a fetched Docker Hub image list stays valid in memory before the next call looks
    # again. Listing it fans out one HTTP request per official image (~20-30) — fine for the CLI's
    # one-shot settings menu, too slow and too chatty to redo on every "Add device"/options-editor
    # open in a long-lived UI session.
    _IMAGES_CACHE_TTL = 300
    # How old the copy kept in the state directory (official_images_cache.py) may be and still be
    # served instead of fetching: the list changes rarely, so a restarted app need not fetch again
    # the same day. An older copy is still served when Docker Hub can't be reached.
    _IMAGES_FILE_TTL = 24 * 3600

    # How long a failed `Kathara.get_instance()` is remembered before the next call retries the
    # connection. Deliberately short: it exists so that opening the app costs *one* connection
    # attempt instead of one per read (see `_facade`), not to latch the process into an offline
    # mode. Anything longer would keep reporting a lab as not-running for that long after the
    # user starts Docker.
    _FACADE_FAILURE_TTL = 3.0

    def __init__(self, store: Optional[LabStore] = None, known: Optional[KnownLabs] = None) -> None:
        self._instance: Optional[Kathara] = None
        self._mutate_lock = threading.RLock()
        self._init_lock = threading.Lock()
        self._images_cache: Optional[list[str]] = None
        self._images_cache_at: float = 0.0
        self._images_cache_lock = threading.Lock()
        # The last `Kathara.get_instance()` failure and when it happened, so N reads during one app
        # open cost one connection attempt rather than N — see `_facade`. Guarded by `_init_lock`,
        # the same lock that serializes construction itself.
        self._facade_error: Optional[DockerDaemonConnectionError] = None
        self._facade_error_at: float = 0.0
        # Ids of labs currently inside deploy_lab/undeploy_lab — see _check_not_transitioning.
        # A separate, always-uncontended lock, deliberately not `_mutate_lock`: deploy_lab holds
        # that one for the whole (potentially slow) facade call, so checking membership through it
        # would block the check itself for just as long, defeating the point of a fast-fail guard.
        self._transitioning: set[str] = set()
        self._transitioning_lock = threading.Lock()
        # One lock per lab id, held across the "is this directory free?" check and the on-disk
        # write that claims it — see _claiming.
        self._claim_locks: dict[str, threading.Lock] = {}
        self._claim_locks_guard = threading.Lock()
        # One lock per lab id, held while its devices' interface slots are read or changed outside
        # `_mutate_lock`: across a refresh from Docker, which hides the empty ones for its length
        # (_empty_slots_hidden), and across a runtime connect or disconnect, whose interface
        # number Kathara derives from those very slots — see _slot_lock.
        self._slot_locks: dict[str, threading.RLock] = {}
        self._slot_locks_guard = threading.Lock()
        # Folders under the labs root that rescan_labs_root could not load, with what they looked
        # like then (_folder_signature): retried only once that changes, not on every poll.
        self._unadoptable: dict[Path, tuple[int, Optional[int]]] = {}
        self._unadoptable_lock = threading.Lock()
        self.registry = LabRegistry()
        self.store = store if store is not None else LabStore(get_settings().labs_dir_path())
        state_dir = get_settings().state_dir_path()
        # Lab directories opened from outside the store's root (open_lab) — see known_labs.py.
        if known is None:
            known = KnownLabs(state_dir / KNOWN_LABS_FILENAME if state_dir is not None else None)
        self.known = known
        # The official image list as last fetched, across restarts — see _official_images.
        self._images_file = OfficialImagesFile(
            state_dir / OFFICIAL_IMAGES_FILENAME if state_dir is not None else None
        )
        # Changes to labs made outside this app, for GET /api/events — see handle_disk_change —
        # the labs whose outside lab.conf edit is waiting for them to be undeployed, and the
        # deployed labs whose folder is gone, waiting the same way to be dropped from the list.
        self.events = LabEvents()
        self._conf_pending: set[str] = set()
        self._missing_pending: set[str] = set()
        # kathara.conf bookkeeping — see load_persisted_settings and update_settings. `_pinned`
        # holds the Kathara settings whose value this session did not take from the file (an
        # environment override, the forced Docker manager): a save leaves the file's own value for
        # them. `_conf_error` is why the file could not be read, which blocks saving over it;
        # `_conf_warnings` are the file's values this session ignores, keyed by setting.
        self._pinned: set[str] = set()
        self._conf_error: Optional[str] = None
        self._conf_warnings: dict[str, str] = {}
        # Repopulate the in-memory registry from any labs persisted on disk, so they survive a
        # restart. Safe at import time: builds model objects only (no facade/Docker), and reads
        # nothing if the storage root does not exist yet.
        self._reload_from_disk()

    # -- locks, transitions and the facade -------------------------------------

    def _begin_transition(self, lab_id: str) -> None:
        """Mark ``lab_id`` as inside ``deploy_lab``/``undeploy_lab`` until ``_end_transition``, so
        ``_check_not_transitioning`` refuses every other mutator at once instead of letting it wait on
        ``_mutate_lock`` for the whole transition."""
        with self._transitioning_lock:
            self._transitioning.add(lab_id)

    def _end_transition(self, lab_id: str) -> None:
        """Undo ``_begin_transition``; always from a ``finally``, so a failed transition never leaves the lab
        refusing every edit."""
        with self._transitioning_lock:
            self._transitioning.discard(lab_id)

    def _lab_dir(self, lab_id: str) -> Optional[Path]:
        """The directory of the lab ``lab_id``, or ``None`` when it has none on disk.

        The registry answers for every lab that loaded. The scan covers a known directory that did
        not — one whose ``lab.conf`` failed to parse at startup, or an opened folder that has since
        gone missing — so that its ``lab.conf`` can still be read and the lab undeployed, exported,
        closed or deleted like any other. ``None`` is what a reconstruct-only lab (running
        containers, no directory) and an unknown id both get.
        """
        directory = self.registry.directory(lab_id)
        if directory is not None:
            return directory
        for candidate in [*self.store.lab_dirs(), *self.known.dirs()]:
            if lab_id_for(candidate) == lab_id:
                return candidate
        return None

    def _existing_lab_dir(self, lab_id: str) -> Path:
        """``_lab_dir``, for callers with nothing to do without a directory: 404 when there is none."""
        directory = self._lab_dir(lab_id)
        if directory is None:
            raise _lab_not_found(lab_id)
        return directory

    def _lab_label(self, lab_id: str) -> str:
        """How to name ``lab_id`` in a message a person reads: its name when the lab is loaded."""
        lab = self.registry.get(lab_id)
        return lab.name if lab is not None and lab.name else lab_id

    @staticmethod
    def _has_running_device(lab: Lab) -> bool:
        """Whether any of ``lab``'s devices has a container, as the model last saw it — the test
        every "while it is deployed" gate uses."""
        return any(m.api_object is not None for m in lab.machines.values())

    def _assert_dir_free(self, directory: Path) -> None:
        """Refuse a lab directory already taken, in the registry or merely on disk.

        Both halves matter: a directory can exist without a registry entry (a lab dropped into the
        labs dir by hand, or one whose lab.conf failed to parse at startup), and overwriting it
        would destroy work this process never knew about.

        Called under `_claiming` on every create path, and a second time *before* the lock on the
        two install paths — a cheap 409 that avoids a download or a copy that is about to be
        thrown away.
        """
        if self.registry.get(lab_id_for(directory)) is not None or directory.exists():
            raise LabAlreadyRegisteredError(f"Lab `{directory.name}` already exists.")

    @contextmanager
    def _claiming(self, lab_id: str) -> Generator[None, None, None]:
        """Serialize everything that claims or releases the lab directory whose id is ``lab_id``.

        A creation path that checks ``_assert_dir_free`` and only *then* writes, holding nothing in
        between, lets two concurrent creates of the same directory both pass the check and both
        write — the loser's rollback then deletes the winner's freshly created directory, leaving
        the winner with its 201 and its registry entry and no files on disk. Every path that
        claims or releases a directory holds this instead: the four creation paths
        (``create_lab``, ``upload_lab``, and ``install_example`` and ``install_gallery_lab`` through
        ``_install_from``), ``open_lab`` for the folder it registers, ``rename_lab`` for the
        directory it moves to, and ``close_lab`` and ``delete_lab`` — unregistering (and, for a
        delete, removing the directory) is what *releases* it, so it races a concurrent create.

        Keyed by id rather than by name because the id *is* the directory (``lab_id_for``): a
        creation path claims the id of the directory it is about to write.

        Deliberately *not* ``_mutate_lock``, which every other mutator uses: the critical section
        here contains the on-disk write itself — extracting a large .zip, ``copytree``-ing a
        bundled example — and serializing that globally would stall unrelated labs' deploys for
        its whole duration. A per-lab lock serializes only the race that can actually corrupt
        anything: two operations fighting over one lab directory. Slow I/O that does not need the
        directory (a gallery download) stays outside, as ``install_gallery_lab`` documents.

        Entries are never removed from ``_claim_locks``: an empty ``Lock`` per lab the process has
        created is bounded and tiny, while removing one safely needs reference counting that would
        cost more complexity than it saves.
        """
        with self._claim_locks_guard:
            lock = self._claim_locks.setdefault(lab_id, threading.Lock())
        with lock:
            yield

    @contextmanager
    def _claiming_if_free(self, lab_id: str) -> Generator[bool, None, None]:
        """``_claiming`` without the wait: yields False, holding nothing, while another operation
        holds the directory — for a background pass that simply tries again later."""
        with self._claim_locks_guard:
            lock = self._claim_locks.setdefault(lab_id, threading.Lock())
        if not lock.acquire(blocking=False):
            yield False
            return
        try:
            yield True
        finally:
            lock.release()

    def _slot_lock(self, lab_id: str) -> threading.RLock:
        """The lock that keeps a refresh of ``lab_id`` from Docker and a runtime connect or
        disconnect on it from interleaving.

        A refresh runs on every read, outside ``_mutate_lock``, and hides each device's empty
        interface slots for its length (``_empty_slots_hidden``); a runtime connect counting
        those slots meanwhile would give the new interface the wrong number. Per lab, so a
        refresh of one lab never waits on another, and never held across anything slow but the
        Docker calls that need it. Never removed, like ``_claim_locks``.
        """
        with self._slot_locks_guard:
            return self._slot_locks.setdefault(lab_id, threading.RLock())

    def _is_transitioning(self, lab_id: str) -> bool:
        """Whether ``lab_id`` is inside ``deploy_lab``/``undeploy_lab`` right now."""
        with self._transitioning_lock:
            return lab_id in self._transitioning

    def _check_not_transitioning(self, lab_id: str) -> None:
        """Fail fast — without ever touching `_mutate_lock` — if `lab_id` is mid deploy/undeploy.

        Must be the first thing a guarded method does, before it acquires `_mutate_lock` itself:
        calling this *after* taking that lock would just wait out the very hang it exists to
        avoid (deploy_lab/undeploy_lab hold `_mutate_lock` for their whole duration).
        """
        if self._is_transitioning(lab_id):
            raise LabTransitioningError(
                f"Lab `{self._lab_label(lab_id)}` is being deployed or undeployed. Try again once it finishes."
            )

    def _facade(self) -> Kathara:
        """The Kathara facade, built on first use under ``_init_lock``.

        Raises ``DockerDaemonConnectionError`` (503) when the daemon can't be reached, and raises that same
        failure again without reconnecting for ``_FACADE_FAILURE_TTL`` seconds.
        """
        if self._instance is None:
            with self._init_lock:
                if self._instance is None:
                    # Re-raise a recent failure instead of reconnecting. Kathara builds its Docker
                    # client with `timeout=None` (DockerManager.__init__), so a daemon that accepts
                    # the connection but never answers — Docker Desktop mid-start, or systemd
                    # socket activation with docker.service stopped — makes this call hang with no
                    # bound. Caching only success would make every read pay that again; the TTL is
                    # what still lets a recovered daemon be picked up.
                    cached = self._facade_error
                    if cached is not None:
                        if time.monotonic() - self._facade_error_at < self._FACADE_FAILURE_TTL:
                            raise cached
                        self._facade_error = None
                    try:
                        self._instance = Kathara.get_instance()
                    except DockerDaemonConnectionError as exc:
                        self._facade_error = exc
                        self._facade_error_at = time.monotonic()
                        # Logged here rather than in `_facade_or_offline` so it fires once per
                        # `_FACADE_FAILURE_TTL` window instead of once per request — this file is
                        # what the desktop app invites users to share when reporting a problem.
                        logger.info("Docker daemon unreachable (%s); serving lab state from disk.", exc)
                        raise
        return self._instance

    def _facade_or_offline(self) -> Optional[Kathara]:
        """The facade, or ``None`` when the Docker daemon can't be reached. **Reads only.**

        A lab's configuration lives on disk and needs no daemon to be described, so a stopped
        Docker should cost the live "what is running?" overlay — not the whole response. Without
        this, the three read paths turn a stopped daemon into a 503 that leaves the UI with nothing
        at all: the frontend's whole dock area only mounts once a lab detail loads, so `lab.conf`,
        the file editor and the topology — none of which involve Docker — go down with it.

        Everything that genuinely needs Docker (deploy/undeploy, exec, stats, the runtime
        filesystem, image pulls) keeps calling `_facade` directly and keeps failing loudly with
        the 503 that `errors.py` maps `DockerDaemonConnectionError` to.
        """
        try:
            return self._facade()
        except DockerDaemonConnectionError:
            return None

    def _offline_lab_state(self, lab: Lab) -> Lab:
        """Present ``lab`` as "nothing is running", for when the daemon can't be asked.

        Necessary rather than a no-op: Kathara never clears ``api_object`` itself, and both
        ``deployed`` and ``running`` are derived from it (``serializers._n_running`` /
        ``machine_to_detail``) — so a lab that was up before the daemon went away would keep
        claiming to be up. ``_clear_undeployed_state`` is the routine undeploy already uses for
        exactly this reason. On a freshly started process it changes nothing, because
        ``_reload_from_disk`` builds machines with no ``api_object`` to begin with.
        """
        self._clear_undeployed_state(lab, set(lab.machines))
        return lab

    # -- settings and system info ----------------------------------------------

    def load_persisted_settings(self) -> None:
        """Load the saved settings from ``kathara.conf`` (``settings_store.conf_path``) at startup.

        No file means Kathara's defaults, and no file is created: the first Settings save writes
        it, as the CLI's own first run does. A file that is not JSON also means the defaults —
        the app must still start — and blocks saving until it is fixed (``update_settings``).

        A value Kathara would refuse is ignored in favour of the default, with a warning on the
        Settings page; the next save replaces it with a valid one. A manager other than Docker is
        ignored the same way, but never replaced: this app drives Docker only, while the file is
        also the Kathara CLI's, which may well be using Kubernetes.
        """
        path = settings_store.conf_path()
        with self._mutate_lock:
            try:
                values = settings_store.read_conf(path)
            except SettingsFileInvalidError as exc:
                logger.warning("Using Kathara's default settings: %s", exc)
                self._conf_error = str(exc)
                return
            if values is None:
                return
            values = dict(values)
            for key, reason in settings_store.invalid_settings(values).items():
                logger.warning("Ignoring `%s` in %s: %s", key, path, reason)
                self._conf_warnings[key] = (
                    f"{key} in Kathara's settings file is ignored: {reason} Saving settings replaces it."
                )
                del values[key]
            manager = values.get("manager_type", "docker")
            if manager != "docker":
                logger.warning("%s sets manager_type=%r; Kathara Desktop uses Docker.", path, manager)
                self._conf_warnings["manager_type"] = (
                    f"Kathara's settings file sets the manager to {manager}, which Kathara Desktop "
                    "does not support yet: the app uses Docker anyway. The file keeps its value, so "
                    "the Kathara CLI is not affected."
                )
                self._pinned.add("manager_type")
                values["manager_type"] = "docker"
            Setting.get_instance().load_from_dict(values)

    def apply_startup_settings(self, settings: dict[str, Any]) -> None:
        """Apply the environment's overrides (``ApiSettings.kathara_overrides``) at startup.

        They win over ``kathara.conf`` for this session only, so they are pinned: a save leaves the
        file's own value for them in place unless the user changes one on the Settings page.
        """
        if settings:
            with self._mutate_lock:
                Setting.get_instance().load_from_dict(settings)
                self._pinned.update(settings)

    # The subset of SettingsUpdate's fields that belong to this project's own ApiSettings
    # (config.py), not to Kathara's Setting/DockerSettingsAddon — update_settings/get_settings_view
    # route these to/from the ApiSettings singleton instead of Setting.load_from_dict/_to_dict.
    _API_SETTINGS_KEYS = frozenset({"max_files_per_lab", "max_bytes_per_file", "max_bytes_per_lab"})

    @staticmethod
    def _kathara_settings_dict() -> dict[str, Any]:
        """Every Kathara setting's current value: the core ``Setting`` plus its manager addon."""
        setting = Setting.get_instance()
        return setting.addons.merge(setting._to_dict())

    def update_settings(self, settings: dict[str, Any]) -> None:
        """Change settings at runtime and save the Kathara ones to ``kathara.conf``.

        Every Kathara setting except ``manager_type`` is read fresh by the Kathara framework at
        the point of use, so it's safe to change any of them at any time. ``manager_type`` picks
        the concrete manager class exactly once, inside ``Kathara.get_instance()``'s constructor,
        and there's no supported way to swap it out afterward for the life of this process — so an
        actual change to it is rejected once the facade has been instantiated, rather than
        silently accepted but never taking effect.

        Values Kathara would refuse (``settings_store.invalid_settings``) are rejected before
        anything changes. A change is saved and applied, or neither: when the file cannot be
        written the previous values are restored, so the page never shows a setting the next start
        would not have. The file is merged into rather than replaced — keys this app doesn't know
        stay, and so do the file's own values for the pinned keys (``_pinned``) and
        ``last_checked``, the CLI's bookkeeping.

        ``max_files_per_lab``/``max_bytes_per_file``/``max_bytes_per_lab`` (``_API_SETTINGS_KEYS``)
        aren't Kathara settings at all — they're this project's own ``ApiSettings`` (config.py),
        just exposed on the same page. They're set directly on the ``get_settings()``
        singleton, which every request already reads fresh (``main.py``'s body-size middleware,
        ``LabStore.extract_zip``), and never written to ``kathara.conf``: they last until the
        process exits, unless whoever starts it passes them back as ``KATHARA_API_MAX_*``, as the
        desktop app does (see ``SettingsView``).
        """
        # Unlike every other mutator here, this doesn't touch a Lab — it touches the process-wide
        # Setting singleton and the ApiSettings singleton, both otherwise unguarded. Two concurrent
        # `PUT /settings` (or one racing a read of Setting.get_instance() elsewhere) could
        # interleave their writes without this.
        with self._mutate_lock:
            kathara_settings = {k: v for k, v in settings.items() if k not in self._API_SETTINGS_KEYS}
            if self._instance is not None and "manager_type" in kathara_settings:
                current = Setting.get_instance().manager_type
                if kathara_settings["manager_type"] != current:
                    raise SettingsLockedError(
                        "`manager_type` cannot be changed after the Kathara manager has been "
                        "initialized for this backend session — restart the app to switch "
                        "managers. Other settings can still be updated freely."
                    )
            problems = settings_store.invalid_settings(kathara_settings)
            if problems:
                raise InvalidSettingsError(" ".join(problems.values()))
            if kathara_settings:
                self._save_kathara_settings(kathara_settings)
            api_settings = get_settings()
            for key in self._API_SETTINGS_KEYS:
                if key in settings:
                    setattr(api_settings, key, settings[key])

    def _save_kathara_settings(self, changes: dict[str, Any]) -> None:
        """Apply ``changes`` to ``Setting`` and write the result to ``kathara.conf``, restoring
        the previous values if the write fails. Called under ``_mutate_lock``."""
        path = settings_store.conf_path()
        previous = self._kathara_settings_dict()
        changed = {key for key, value in changes.items() if previous.get(key) != value}
        Setting.get_instance().load_from_dict(changes)
        pinned = self._pinned - changed
        try:
            on_disk = settings_store.read_conf(path) or {}
            current = self._kathara_settings_dict()
            to_save = {**on_disk, **{k: v for k, v in current.items() if k not in pinned}}
            for key in (*pinned, "last_checked"):
                if key in on_disk:
                    to_save[key] = on_disk[key]
                elif key in pinned:
                    to_save.pop(key, None)
            settings_store.write_conf(path, to_save)
        except SettingsFileInvalidError as exc:
            Setting.get_instance().load_from_dict(previous)
            raise SettingsFileInvalidError(
                f"Settings not saved: {exc} Fix or delete it, then save again."
            ) from None
        except OSError as exc:
            Setting.get_instance().load_from_dict(previous)
            raise SettingsPersistError(f"Settings not saved: cannot write `{path}` ({exc}).") from None
        self._pinned = pinned
        self._conf_error = None
        for key in current.keys() - pinned:
            self._conf_warnings.pop(key, None)

    def get_settings_view(self) -> dict[str, Any]:
        """Everything the Settings page shows: Kathara's settings, the ``ApiSettings`` caps
        (``_API_SETTINGS_KEYS``), where ``kathara.conf`` is, why it couldn't be read, and which of its
        values this session ignores."""
        view = self._kathara_settings_dict()
        api_settings = get_settings()
        view.update({key: getattr(api_settings, key) for key in self._API_SETTINGS_KEYS})
        view["settings_file"] = str(settings_store.conf_path())
        view["settings_file_error"] = self._conf_error
        view["settings_warnings"] = list(self._conf_warnings.values())
        return view

    def system_info(self) -> dict[str, Any]:
        """The manager, the Docker daemon's version and whether the backend runs as admin. Never fails for a
        stopped daemon: only ``version`` needs it, and is None then."""
        facade = self._facade_or_offline()
        return {
            # A `@staticmethod` in Kathara's Docker manager returning exactly this string, so it
            # stays correct with the daemon down — hence the same constant either way.
            "manager": facade.get_formatted_manager_name() if facade is not None else _DOCKER_MANAGER_LABEL,
            # The one field here that genuinely needs Docker: it is `client.version()["Version"]`,
            # i.e. the *daemon's* version, not Kathara's. None when the daemon can't be asked —
            # see `SystemInfo.version`.
            "version": facade.get_release_version() if facade is not None else None,
            # Hardcoded rather than `Kathara.get_available_managers_name()`: that call eagerly
            # imports Kathara's Kubernetes manager (and the 80MB+ `kubernetes` package) even
            # though this app only ever drives Docker.
            "available_managers": {"docker": _DOCKER_MANAGER_LABEL},
            # A plain real-UID check (Kathara.utils.is_admin), no daemon involved — which is why
            # this endpoint degrading matters: it is the field the frontend actually consumes
            # (hooks/useIsAdmin.ts), so it has to survive a 503 from the rest of the snapshot.
            "is_admin": is_admin(),
        }

    # -- image suggestions (Docker Hub and the local daemon) -------------------

    def list_available_images(self) -> AvailableImages:
        """Image-field suggestions, split into the official Kathara images on Docker Hub and the
        images already present on this machine's Docker daemon.

        Suggestions only — the field stays free text, so neither half is authoritative and
        neither failing is an error. Docker Hub unreachable leaves the local images; the daemon
        stopped leaves the Hub list; both down returns two empty lists and the user types the
        name. An image in both halves is reported as official only, so the picker never shows it
        under two headings.
        """
        official = self._official_images()
        seen = set(official)
        return AvailableImages(
            official=official,
            local=[name for name in self.list_local_images() if name not in seen],
        )

    def _official_images(self) -> list[str]:
        """The Docker Hub half, cached in memory for ``_IMAGES_CACHE_TTL`` seconds and on disk.

        Only this half is cached: it is a ~20-request fan-out over the network, while
        ``list_local_images`` is a millisecond call to the local daemon that must stay fresh so
        an image the user just pulled shows up without waiting out a TTL.

        Past the memory TTL, the copy in the state directory (``_images_file``) is served while
        younger than ``_IMAGES_FILE_TTL``; otherwise Docker Hub is asked, and a successful answer
        replaces both. When it can't be reached, an older copy on disk is served rather than
        nothing — kept in memory like a fetched one, so an offline app doesn't wait out the
        request timeout on every open of a picker.
        """
        with self._images_cache_lock:
            if self._images_cache is not None and time.monotonic() - self._images_cache_at < self._IMAGES_CACHE_TTL:
                # A copy, not the cached list itself: a caller that mutated it in place would
                # corrupt the cache for everyone else.
                return list(self._images_cache)
        stored = self._images_file.load()
        # A copy dated in the future (the clock was set back since) has no age to trust.
        age = time.time() - stored.fetched_at if stored is not None else None
        if stored is not None and 0 <= age < self._IMAGES_FILE_TTL:
            return self._remember_official_images(stored.images)
        try:
            images = docker_hub.list_tagged_images()
        except HTTPConnectionError:
            logger.debug("Could not list the official Kathara images from Docker Hub", exc_info=True)
            if stored is not None:
                return self._remember_official_images(stored.images)
            # Nothing to fall back on, and not cached either: the next call retries rather than
            # latching the picker into a Hub-less state for five minutes after a brief blip.
            return []
        self._images_file.save(images, time.time())
        return self._remember_official_images(images)

    def _remember_official_images(self, images: list[str]) -> list[str]:
        """Keep ``images`` as the in-memory official list for ``_IMAGES_CACHE_TTL``; a copy back."""
        with self._images_cache_lock:
            self._images_cache = list(images)
            self._images_cache_at = time.monotonic()
        return list(images)

    def list_local_images(self) -> list[str]:
        """Every tagged image on this machine's Docker daemon, sorted, ``:latest`` stripped.

        Stripping ``:latest`` is what makes a locally pulled ``kathara/base:latest`` dedupe
        against Docker Hub's ``kathara/base`` instead of sitting next to it as a near-duplicate;
        it also matches how images are written in ``lab.conf``. Untagged (dangling) images are
        dropped — there is nothing a user could type to name one.
        """
        try:
            images = self._docker_manager().client.images.list()
        except (DockerDaemonConnectionError, APIError):
            logger.debug("Could not list local Docker images", exc_info=True)
            return []
        names = {
            tag[: -len(":latest")] if tag.endswith(":latest") else tag
            for image in images
            for tag in (image.tags or [])
            if tag and not tag.startswith("<none>")
        }
        return sorted(names)

    # -- Docker images (pre-deploy check + explicit download) -----------------

    def _docker_manager(self) -> Any:
        """Kathara's own Docker manager, for the image work the facade doesn't expose.

        Deliberately the manager's client and not a `docker.from_env()` of our own: Kathara builds
        that client from the user's settings (`docker.DockerClient(base_url=remote_url, ...)` when
        `remote_url` is set — `DockerManager.__init__`), so a client we made ourselves would talk to
        a different daemon than the one the deploy uses. This reaches past the facade contract
        (`manager.client` / `manager.docker_image` are internals), which is why every use goes
        through this one accessor: an upstream refactor then breaks in one legible place instead of
        as scattered AttributeErrors.

        No non-Docker branch: this app only drives Docker (see `system_info`), and every caller of
        the image pre-check treats *any* failure as "carry on with the deploy" anyway.
        """
        return self._facade().manager

    def check_lab_images(self, lab_id: str) -> LabImagesStatus:
        """Classify a lab's device images so the UI can offer the download before deploying.

        Read-only, and deliberately outside `_mutate_lock` — same as every other read path on this
        router (see `routers/labs.get_lab`). Kathara resolves a device's image through
        `Machine.get_image()` (lab metadata -> device meta -> the global default), so that is what
        decides which images this reports.
        """
        lab = self.get_lab_or_reconstruct(lab_id)
        names = sorted({machine.get_image() for machine in lab.machines.values()})
        policy = getattr(Setting.get_instance(), "image_update_policy", "Prompt") or "Prompt"
        states = image_pull.classify_images(
            self._docker_manager().docker_image, names, check_updates=policy != "Never"
        )
        return LabImagesStatus(
            update_policy=policy,
            images=[LabImageStatus(name=name, state=state) for name, state in states.items()],
            missing=[name for name, state in states.items() if state == "missing"],
            not_found=[name for name, state in states.items() if state == "not-found"],
            outdated=[name for name, state in states.items() if state == "outdated"],
        )

    def pull_images(self, images: list[str]) -> list[str]:
        """Download exactly `images`, one at a time, publishing progress for the poll endpoint."""
        return image_pull.pull_images(self._docker_manager(), images)

    # -- host-wide: wipe, sysctls ----------------------------------------------

    def wipe(self) -> list[str]:
        """Undeploy every lab kathara-desktop itself has registered and deployed.

        Unlike the Kathara CLI's own ``wipe(all_users=False)``, which force-undeploys *every*
        running scenario for the OS user regardless of who deployed it, this only touches labs
        this backend is managing — it must not reach out and kill scenarios some other tool (the
        CLI, another Kathara frontend) started. Routed through ``undeploy_lab`` per registered lab
        so the usual post-undeploy bookkeeping (cleared api_object, topology reloaded from disk)
        happens exactly as it would for a single manual undeploy.

        Best-effort: one lab's undeploy failing (a stuck container, the daemon going away
        mid-loop) must not leave every lab after it stuck deployed. Returns the names of the labs
        that could not be undeployed, so the caller can say what actually happened instead of a
        single all-or-nothing error.
        """
        failed: list[str] = []
        with self._mutate_lock:
            for lab in self.registry.all():
                if self._has_running_device(lab):
                    try:
                        self.undeploy_lab(lab.hash)
                    except Exception:
                        logger.warning(
                            "Failed to undeploy lab `%s` during wipe, continuing with remaining labs",
                            lab.name,
                            exc_info=True,
                        )
                        failed.append(lab.name)
        return failed

    def list_net_sysctls(self) -> list[str]:
        """Every ``net.*`` sysctl key available on this host's current kernel — walks
        ``/proc/sys/net``, where each file corresponds 1:1 to a ``net.a.b.c`` sysctl name (path
        separators become dots); a subtree this process can't list is silently skipped by
        ``os.walk``, but an individual unreadable *file* is still listed here as available since
        this only inspects names, never contents. Reflects the real kernel/loaded modules on this
        machine rather than a static, potentially stale list — Kathara's own sysctl validation
        only ever accepts the ``net.*`` namespace anyway (see ``Machine.add_meta``'s regex), so
        this is also exactly the set of keys that would actually be accepted.
        """
        root = Path("/proc/sys/net")
        if not root.is_dir():
            return []
        keys: set[str] = set()
        for dirpath, _dirnames, filenames in os.walk(root):
            rel_dir = Path(dirpath).relative_to(root)
            for filename in filenames:
                rel = filename if rel_dir == Path(".") else f"{rel_dir.as_posix()}/{filename}"
                keys.add("net." + rel.replace("/", "."))
        return sorted(keys)

    # -- lab lifecycle --------------------------------------------------------

    def _build_and_register(self, spec: LabCreate, lab_dir: Path) -> Lab:
        """Build an OS-backed Lab rooted at ``lab_dir`` (which must already exist) and register it.

        Every lab is OS-backed (``Lab(path=lab_dir)``) rather than the in-memory ``mem://`` fs, so
        Kathara's own deploy machinery (``Machine.pack_data``) packs real files/startup scripts
        into containers over the Docker API.
        """
        lab = lab_builder.build_lab(spec, path=str(lab_dir))
        if not self.registry.add_if_absent(lab, lab_dir):
            raise LabAlreadyRegisteredError(f"Lab `{spec.name}` already exists.")
        return lab

    # -- offline lab filesystem: path resolution and writes --------------------

    def _write_machine_files(
        self, lab: Lab, machine_name: str, files: dict[str, str], dirs: list[str]
    ) -> None:
        """Write an explicit files/dirs edit onto one machine's own on-disk folder.

        Writes exactly the caller's payload and nothing else, so an edit never touches a file it
        did not ask to change.
        """
        machine = self._registered_machine(lab, machine_name)
        if dirs:
            if machine.fs is None:
                machine.fs = lab.fs.makedir(machine_name, recreate=True)
            for rel_dir in dirs:
                if rel_dir and rel_dir.strip():
                    machine.fs.makedirs(rel_dir, recreate=True)
        for path, content in files.items():
            machine.create_file_from_string(content, path)

    def _write_lab_root_files(self, lab: Lab, files: dict[str, str], dirs: list[str]) -> None:
        """Same as ``_write_machine_files``, but for files/dirs under the ROOT_MACHINE bucket
        (the Lab Configuration tab's tree root, no device) — written straight onto the
        lab's own on-disk directory, alongside ``lab.conf`` and each device's folder. Real files,
        just not consumed by deploy (nothing under Kathara's deploy machinery reads outside
        ``lab.conf``/``<machine>/``/``<machine>.startup``/``shared/``)."""
        for rel_dir in dirs:
            if rel_dir and rel_dir.strip():
                lab.fs.makedirs(rel_dir, recreate=True)
        for path, content in files.items():
            lab.create_file_from_string(content, path)

    @staticmethod
    def _registered_machine(lab: Lab, machine_name: str) -> Machine:
        """The device `machine_name` names, for callers that have already established it exists.

        Every caller gets its name from `_offline_fs_owner`, which returns a device name *only*
        when `lab.machines.get(top) is not None`, and returns `ROOT_MACHINE` otherwise — on the
        same `lab` object, inside the same `_mutate_lock`, so there is no window in between. The
        lookup here can therefore only fail if that contract is broken.

        It raises rather than returning `None` so a broken invariant surfaces once, loudly, as a
        server error. Answering it per call site — a 200 having written nothing, a 400, a 404 —
        is the wrong shape for a condition that means "this code is wrong", not "your request is
        wrong".
        """
        machine = lab.machines.get(machine_name)
        if machine is None:
            raise RuntimeError(
                f"`{machine_name}` is not a registered device of lab `{lab.name}` — "
                "_offline_fs_owner's contract was broken."
            )
        return machine

    def _fs_for(self, lab: Lab, machine_name: str):
        """The real (osfs) fs backing ``machine_name``'s offline files — the lab's own root
        directory for ``ROOT_MACHINE``, or a registered device's own subdirectory. ``None`` if
        ``machine_name`` is neither ``ROOT_MACHINE`` nor a registered device."""
        if machine_name == ROOT_MACHINE:
            return lab.fs
        machine = lab.machines.get(machine_name)
        return machine.fs if machine is not None else None

    def _fs_for_write(self, lab: Lab, machine_name: str):
        """Like ``_fs_for``, but for a path about to be written: materializes the device's own
        directory if it has none yet, and *raises* instead of returning ``None`` for a name that
        is neither ``ROOT_MACHINE`` nor a registered device.

        The difference that matters is that it does not return ``None``: ``_fs_for`` doing so is
        how read paths answer 404, whereas every caller here has already established the device
        exists (see ``_registered_machine``).
        """
        if machine_name == ROOT_MACHINE:
            return lab.fs
        machine = self._registered_machine(lab, machine_name)
        if machine.fs is None:
            machine.fs = lab.fs.makedir(machine_name, recreate=True)
        return machine.fs

    @staticmethod
    def _clean_offline_path(path: str) -> str:
        """The canonical lab-relative spelling of an offline-fs path.

        Every method in the offline family runs its argument through this *first*, so the
        `lab.conf` guards below — and `_offline_fs_owner`/`_dirty_target_for`, which both split on
        "/" — all see one spelling of any given file. Without it the guards compare the raw
        string: "/lab.conf" routes to `update_lab_conf` (parse validation, the
        409-while-deployed gate, the registry rebuild) while "./lab.conf" slips past all three
        and overwrites lab.conf with unvalidated text, leaving the registry on the old model.

        Back-references are left to `fs.path.normpath`, which resolves an interior one
        ("pc1/../lab.conf" really does denote lab.conf, and reaches it through the validated
        path) and raises `IllegalBackReference` for one that climbs out of the lab — already
        mapped to a clean 400 in errors.py, and asserted by
        test_fs_list_offline_back_reference_path_raises_illegal_back_reference.
        """
        return fs.path.normpath(path.strip())

    @staticmethod
    def _is_lab_conf(path: str) -> bool:
        """Whether an already-cleaned offline path denotes the lab's own ``lab.conf``.

        A normalized comparison, like the lab-root guard in `fs_delete_offline`, for the reason
        that guard's comment gives.
        """
        return path.strip("/") == LAB_CONF_FILENAME

    @staticmethod
    def _is_lab_root(owner: str, guest: str) -> bool:
        """Whether ``(owner, guest)`` resolves to the lab's own root directory.

        Shared by every offline-fs mutator that can displace an entry: moving a lab's root away
        or copying something over it is as wrong as deleting it.
        """
        return owner == ROOT_MACHINE and fs.path.normpath(guest) in ("", "/")

    @staticmethod
    def _escapes_lab(lab: Lab, path: str) -> bool:
        """Whether the already-cleaned lab-relative ``path`` resolves outside the lab's directory.

        ``_clean_offline_path`` already refuses a ``..`` that climbs out; this catches the other
        way out, a symbolic link inside the lab pointing elsewhere, which pyfilesystem's ``OSFS``
        follows without a word. A lab opened from anywhere on the host (``open_lab``) can hold
        one, and following it would let the lab filesystem API read or write any file the backend
        can. A path-less (in-memory) lab has nowhere to escape to.
        """
        try:
            root = Path(lab.fs.getsyspath("/"))
        except fs.errors.NoSysPath:
            return False
        return not is_within(root / path.lstrip("/"), root)

    def _confine(self, lab: Lab, path: str) -> None:
        """Refuse ``path`` if it escapes the lab — see ``_escapes_lab``."""
        if self._escapes_lab(lab, path):
            raise ApiError(f"`{path}` leads outside the lab through a symbolic link.")

    @staticmethod
    def _offline_fs_owner(lab: Lab, path: str) -> tuple[str, str]:
        """Resolve a lab-relative path (``"pc1/etc/motd"``, ``"pc1.startup"``, ``"notes.txt"``) to
        ``(owner, guest_path)`` — ``owner`` is a real device name if the path's first segment
        matches one, else ``ROOT_MACHINE`` (the lab's own root — this is where a device's
        ``<name>.startup`` naturally resolves to too, since it really is just a file sitting in
        ``lab.fs``, not under any device's own subdirectory). ``guest_path`` is owner-relative,
        always leading-slash.
        """
        clean = path.strip("/")
        if not clean:
            return ROOT_MACHINE, "/"
        top, _, rest = clean.partition("/")
        if lab.machines.get(top) is not None:
            return top, f"/{rest}"
        return ROOT_MACHINE, f"/{clean}"

    @staticmethod
    def _dirty_target_for(lab: Lab, path: str) -> Optional[str]:
        """The device a write to ``path`` should mark dirty for redeploy live-push purposes — a
        path under a device's own subtree, or that device's dedicated ``<name>.startup`` file.
        ``None`` for ``lab.conf`` and anything else at the lab root, which have no already-running
        container to push into.
        """
        clean = path.strip("/")
        if not clean:
            return None
        if "/" in clean:
            top = clean.split("/", 1)[0]
            return top if lab.machines.get(top) is not None else None
        if clean.endswith(STARTUP_SUFFIX):
            candidate = clean[: -len(STARTUP_SUFFIX)]
            return candidate if lab.machines.get(candidate) is not None else None
        return None

    def _mark_dirty_for(self, lab: Lab, lab_id: str, path: str) -> None:
        """Mark the device a write to ``path`` belongs to dirty (``_dirty_target_for``), if any."""
        dirty = self._dirty_target_for(lab, path)
        if dirty:
            self.registry.mark_dirty(lab_id, dirty)

    @staticmethod
    def _fs_entry(info, parent_normalized: str) -> FsEntry:
        name = info.name
        path = f"/{name}" if parent_normalized == "/" else f"{parent_normalized}/{name}"
        modified = info.modified
        return FsEntry(
            name=name,
            path=path,
            is_dir=info.is_dir,
            size=info.size,
            mtime=modified.timestamp() if modified else None,
        )

    # -- lab lifecycle, continued: create, open, close -------------------------

    def _adopt_lab_dir(self, lab_dir: Path, t: lab_import.LabImportTranslation) -> Lab:
        """Build + register a Lab against its already-populated on-disk directory.

        Writes nothing: by the time this runs, the directory *is* the lab (verbatim — see
        ``upload_lab``), so there is nothing left to materialize. Kathara's own
        ``Machine.pack_data`` reads a machine's files straight off ``machine.fs`` and its
        ``<name>.startup``/``shared.startup``/``shared.shutdown`` straight off ``lab.fs`` at
        deploy time — a machine whose subfolder already exists on disk picks up ``machine.fs``
        automatically (``Machine.__init__``), so nothing needs writing here for that to work.
        """
        return self._build_and_register(t.payload, lab_dir)

    def create_lab(self, spec: LabCreate) -> Lab:
        """Create a lab under the labs root from a JSON description, not deployed, and write its ``lab.conf``
        from the model. Claims the directory with ``_claiming`` and refuses one already taken
        (``_assert_dir_free``); a failed write unregisters the lab and removes the directory again."""
        # `sanitize_lab_name` may strip whitespace (e.g. " demo " -> "demo"), and the lab
        # directory below is always created under that stripped form — every *import* path
        # already passes the same clean name through to the LabCreate it builds (see
        # lab_import.translate_lab_files' `lab_name` parameter), so this JSON path sanitizes too.
        # Keeping `spec.name` raw here would register a Lab carrying the untrimmed name while the
        # directory on disk used the trimmed one: GET/DELETE/etc by "demo" would 404 until the
        # next restart re-read the directory from disk and the lab silently renamed itself.
        clean_name = lab_store.sanitize_lab_name(spec.name)
        with self._claiming(lab_id_for(self.store.lab_dir(clean_name))):
            # Before the directory is made: one that is already there without a registry entry (a
            # folder whose lab.conf doesn't parse) would otherwise get its lab.conf overwritten, and
            # a failed write below would then delete the whole folder in the rollback.
            self._assert_dir_free(self.store.lab_dir(clean_name))
            lab_dir = self.store.ensure_lab_dir(clean_name)
            spec = spec.model_copy(update={"name": clean_name})
            lab = self._build_and_register(spec, lab_dir)
            # JSON-created labs have no source lab.conf, so one is generated from the model —
            # written directly here since the directory was just created and nothing else has
            # touched it yet (no atomic swap needed, unlike LabStore.write_lab/extract_zip).
            try:
                self.store.write_lab_conf(lab_dir, lab)
            except Exception:
                # Unlike the four import paths, this one registers *before* it writes — so a
                # failed write would otherwise leave a lab in the registry that has no lab.conf
                # on disk, and nothing would ever clean it up.
                self.registry.remove(lab.hash)
                self.store.delete_lab(lab_dir)
                raise
            return lab

    def open_lab(self, path: str, init: bool = False) -> tuple[Lab, list[str]]:
        """Open the folder at ``path`` — anywhere on the host — as a lab, and remember it.

        The folder is used in place: nothing is copied under the labs root, and the lab's id is
        derived from where it is (``lab_store.lab_id_for``), so a lab `kathara lstart` runs in
        that folder is this one. Opening a folder that is already open (or one of the root's own
        labs) just returns it, which is what makes a "recent labs" entry safe to click twice.

        ``path`` must be trusted: once open, the whole folder is readable and writable through the
        lab filesystem API. The route that reaches this is guarded by the desktop shell's own
        token (``dependencies.require_shell_token``) for exactly that reason.

        A folder with neither a ``lab.conf`` nor any device folder is a ``NotALabError`` (422) —
        unless ``init``, which makes it a lab first by writing an empty ``lab.conf``, the same one
        ``create_lab`` writes for a lab with no devices. Returns the lab and the non-fatal parse
        warnings an import reports.
        """
        if not os.path.isabs(path):
            raise ApiError("A lab folder must be given as an absolute path.")
        directory = Path(os.path.realpath(path))
        if not directory.is_dir():
            raise PathNotFoundError(f"`{path}` is not a folder.")
        if directory.parent == directory:
            raise ApiError("The root of the filesystem can't be opened as a lab.")
        lab_id = lab_id_for(directory)
        warnings: list[str] = []
        with self._claiming(lab_id):
            placed = self.registry.directory(lab_id)
            if placed is not None and Path(os.path.realpath(placed)) != directory:
                # Kathara's hash drops every non-ASCII character before hashing, so two paths
                # that differ only in those share an id — and would share containers under the CLI
                # too. Opening the second would hand back the first lab's model and edits.
                raise ApiError(
                    f"`{directory}` can't be opened next to `{placed}`: Kathara gives both the same "
                    "identity (their paths differ only in non-ASCII characters). Rename one of them."
                )
            if placed is None:
                self.store.check_openable(directory)
                conf_path = self.store.lab_conf_path(directory)
                if init and not conf_path.exists():
                    self.store.write_lab_conf(directory, lab_builder.build_lab(LabCreate(name=directory.name)))
                files, _dirs = self.store.read_lab(directory)
                t = lab_import.translate_lab_files(files, directory.name)
                if t.errors:
                    if LAB_CONF_FILENAME not in files:
                        raise NotALabError(f"`{directory.name}` has no lab.conf and no device folders.")
                    raise ApiError("; ".join(t.errors))
                self._build_and_register(t.payload, directory)
                warnings = t.warnings
                placed = directory
            if not self.store.is_under_root(placed):
                try:
                    self.known.add(placed)
                except OSError:
                    # The lab is open either way; it just won't be listed again after a restart.
                    logger.warning("Could not remember opened lab folder %s", placed, exc_info=True)
        # Through the usual lookup, so the answer already shows whatever runs under this lab's id
        # — e.g. a lab started from the CLI in this folder before it was ever opened here.
        return self.get_lab_or_reconstruct(lab_id), warnings

    def close_lab(self, lab_id: str) -> None:
        """Forget a lab opened from outside the labs root; its folder is left untouched.

        Undeploys it first: containers left running would belong to a lab nothing lists any more,
        with no way to stop them short of reopening it. A lab under the root cannot be closed
        (``LabCloseRefusedError``) — the next restart would list it again; it is deleted instead.
        Works on an opened folder that has gone missing too, which is how one is dropped from
        the list.
        """
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab_dir = self._lab_dir(lab_id)
            if lab_dir is None and self.registry.get(lab_id) is None:
                raise _lab_not_found(lab_id)
            if lab_dir is not None and self.store.is_under_root(lab_dir):
                raise LabCloseRefusedError(
                    f"`{self._lab_label(lab_id)}` is in the labs folder, so it can't be closed. Delete it instead."
                )
            try:
                self._facade().undeploy_lab(lab_hash=lab_id)
            except DockerDaemonConnectionError:
                # Same reasoning as delete_lab: with no daemon there is nothing running to stop.
                logger.warning("Docker daemon unreachable while closing lab `%s`; skipping undeploy", lab_id)
        with self._claiming(lab_id):
            self.registry.remove(lab_id)
            if lab_dir is not None:
                self.known.remove(lab_dir)

    # -- changes made on disk outside this app (services/lab_watch.py) ----------------------------

    def watched_labs(self) -> dict[str, Path]:
        """What the disk watcher polls, by id: every loaded lab's directory, and every opened folder
        that didn't load (``unloaded_opened_labs``) — so one that comes back, or whose lab.conf gets
        fixed, loads without being opened again."""
        watched = self.registry.directories()
        for lab_id, directory, _problem in self.unloaded_opened_labs():
            watched.setdefault(lab_id, directory)
        return watched

    def unloaded_opened_labs(self) -> list[tuple[str, Path, str]]:
        """Folders opened from outside the labs root that are remembered but not loaded, as
        ``(id, directory, problem)``: ``"missing"`` (not there — an unmounted drive, a moved folder)
        or ``"unloadable"`` (its lab.conf doesn't parse). Listed so they can still be closed."""
        unloaded: list[tuple[str, Path, str]] = []
        for directory in self.known.dirs():
            lab_id = lab_id_for(directory)
            if self.store.is_under_root(directory) or self.registry.get(lab_id) is not None:
                continue
            unloaded.append((lab_id, directory, "unloadable" if directory.is_dir() else "missing"))
        return unloaded

    # How long the watcher waits for `_mutate_lock` before giving a lab's change back to be retried:
    # a deploy of *another* lab holds it for minutes, and one lab must not stall every other's.
    _DISK_CHANGE_LOCK_WAIT_S = 0.2

    def handle_disk_change(self, lab_id: str, files: set[str]) -> set[str]:
        """React to ``files`` — names at the top of the lab's directory — having changed on disk,
        and return the ones to be offered again on the next poll (``lab_watch.LabWatcher``).

        Called for changes the watcher cannot tell apart from this app's own, so each half first
        works out whether there is anything to do:

        - ``lab.conf``: rebuilds the lab's model from disk, exactly as ``update_lab_conf`` would
          for the same text. If the text is the one this app itself last wrote
          (``LabStore.wrote_lab_conf``) that happens silently — the model already agrees, bar an
          outside edit the app's own edit was built on top of. If the text does not parse (most
          likely an edit still in progress) the current model is kept. If the lab is deployed, a
          rebuild would desync the running containers, so ``lab.conf`` is handed back until it is
          not: stopped here or from the CLI in the lab's folder, the new file then applies.
        - ``*.startup``: marks the devices whose boot script changed dirty, so a redeploy pushes it
          into a device that is already running (``registry.mark_dirty``); ``shared.startup`` runs
          on every device, so it marks all of them.

        A lab whose folder is gone altogether — moved, deleted, on a drive since unmounted — is
        neither: see ``_lab_dir_gone``.

        Every outcome but a silent one is published (``events``), a pending ``lab.conf`` or a
        missing folder once.
        Everything is handed back while the lab is mid deploy/undeploy, or when ``_mutate_lock``
        can't be had promptly — never blocking the watcher, which serves every lab.
        """
        if self._is_transitioning(lab_id):
            return set(files)
        if not self._mutate_lock.acquire(timeout=self._DISK_CHANGE_LOCK_WAIT_S):
            return set(files)
        try:
            lab = self.registry.get(lab_id)
            lab_dir = self.registry.directory(lab_id)
            if lab is None or lab_dir is None:
                self._conf_pending.discard(lab_id)
                self._load_opened_lab(lab_id)
                return set()  # otherwise closed, deleted or renamed since the poll: nothing to update
            if not lab_dir.is_dir():
                return self._lab_dir_gone(lab_id, files)
            self._missing_pending.discard(lab_id)
            pending: set[str] = set()
            if LAB_CONF_FILENAME in files and not self._lab_conf_changed_on_disk(lab_id, lab_dir):
                pending.add(LAB_CONF_FILENAME)
            startups = sorted(name for name in files if name.endswith(STARTUP_SUFFIX))
            if startups:
                devices = {name[: -len(STARTUP_SUFFIX)] for name in startups}
                touched = set(lab.machines) if "shared" in devices else devices & set(lab.machines)
                for machine_name in touched:
                    self.registry.mark_dirty(lab_id, machine_name)
                self._publish_disk_event(lab_id, "startup", startups)
            return pending
        finally:
            self._mutate_lock.release()

    def _lab_dir_gone(self, lab_id: str, files: set[str]) -> set[str]:
        """The folder of the registered lab ``lab_id`` is no longer there. Called holding
        ``_mutate_lock``.

        A stopped lab is dropped from the registry, which leaves it where a restart would: an
        opened folder is listed as missing (``unloaded_opened_labs``) and loads by itself when it
        comes back (``_load_opened_lab``); a lab under the root is simply gone. A deployed one
        stays registered, or its containers would run on with nothing listing them and no way to
        stop them from the app — so every name is handed back, and it is dropped once it stops,
        from the app or the CLI. Refreshed first for that reason (see ``_lab_conf_changed_on_disk``).
        """
        lab = self.get_lab_or_reconstruct(lab_id)
        if self._has_running_device(lab):
            if lab_id not in self._missing_pending:
                self._missing_pending.add(lab_id)
                self._publish_disk_event(
                    lab_id, "missing", sorted(files),
                    "Undeploy it to remove it from the list; its devices are still running.",
                )
            return set(files)
        self._missing_pending.discard(lab_id)
        self._conf_pending.discard(lab_id)
        self.registry.remove(lab_id)
        self._publish_disk_event(lab_id, "missing", sorted(files))
        return set()

    def _load_opened_lab(self, lab_id: str) -> None:
        """Load an opened folder that didn't load before, now that its files changed — it came
        back, or its lab.conf was fixed. Called holding ``_mutate_lock``."""
        directory = next((d for i, d, _problem in self.unloaded_opened_labs() if i == lab_id), None)
        if directory is None or not directory.is_dir():
            return
        if self._reload_lab_from_disk(directory) is not None:
            self._publish_disk_event(lab_id, "conf-reloaded", [LAB_CONF_FILENAME])

    def _lab_conf_changed_on_disk(self, lab_id: str, lab_dir: Path) -> bool:
        """The ``lab.conf`` half of ``handle_disk_change``, holding ``_mutate_lock``. False means
        "not yet": the lab is deployed."""
        text = self.store.read_lab_conf_text(lab_dir)
        own = text is not None and self.store.wrote_lab_conf(lab_dir, text)
        # Refreshed first: a lab stopped from outside the app still carries its old api_objects
        # until something asks Docker (see _refresh_from_api).
        lab = self.get_lab_or_reconstruct(lab_id)
        if self._has_running_device(lab):
            if own:
                return True  # a live edit this app made itself, already in the model
            if lab_id not in self._conf_pending:
                self._conf_pending.add(lab_id)
                self._publish_disk_event(
                    lab_id, "conf-pending", [LAB_CONF_FILENAME], "Undeploy the lab to apply the new lab.conf."
                )
            return False
        self._conf_pending.discard(lab_id)
        if not own:
            # From now on the file is someone else's: an outside revert to exactly the text this app
            # last wrote must not then be taken for this app's own write.
            self.store.forget_lab_conf(lab_dir)
        errors = lab_conf_edit.parse_errors(text) if text is not None else []
        reloaded = None if errors else self._reload_lab_from_disk(lab_dir)
        if own:
            return True
        if reloaded is None:
            detail = "; ".join(errors) if errors else "see the backend log."
            self._publish_disk_event(lab_id, "conf-invalid", [LAB_CONF_FILENAME], detail)
        else:
            self._publish_disk_event(lab_id, "conf-reloaded", [LAB_CONF_FILENAME])
        return True

    def _publish_disk_event(self, lab_id: str, kind: str, files: list[str], detail: Optional[str] = None) -> None:
        self.events.publish({"lab_id": lab_id, "kind": kind, "files": files, "detail": detail})

    # -- where a lab lives, its export and its lab.conf ------------------------

    def lab_place(self, lab: Lab) -> LabPlace:
        """Where ``lab`` lives, for the response schemas (``LabSummary.path``/``managed``)."""
        directory = self._lab_dir(lab.hash)
        return LabPlace(directory, directory is not None and self.store.is_under_root(directory))

    def deploy_failure(self, lab: Lab) -> Optional[DeployFailure]:
        """Why ``lab``'s last deploy failed, for the response schemas (``LabSummary.deploy_error``),
        or None — cleared by the next successful deploy and once nothing in the lab is running."""
        return self.registry.deploy_failure(lab.hash)

    def export_lab_zip(self, lab_id: str) -> tuple[str, io.BytesIO]:
        """The lab's directory name and an in-memory .zip of that directory (raises 404 if unknown).

        The name comes back with the archive because it is what the download should be called:
        the caller only has the id, which means nothing to whoever saves the file.
        """
        directory = self._existing_lab_dir(lab_id)
        return directory.name, self.store.zip_lab(directory)

    def read_lab_conf(self, lab_id: str) -> LabConfView:
        """The lab's on-disk ``lab.conf``, verbatim — 404 only if the lab itself is unknown.

        Reads the file rather than re-serializing the model (``gen_lab_conf``), which is lossy:
        the editor must show exactly the bytes an import/upload/edit last wrote. A lab with no
        ``lab.conf`` on disk (reconstruct-only, or a folder-based import never yet edited) is
        reported as ``exists=False``, not a 404 — ``update_lab_conf`` (``PUT``) creates the file,
        so the editor can start from an empty buffer.
        """
        directory = self._lab_dir(lab_id)
        if directory is None:
            self.get_lab_or_reconstruct(lab_id)  # raises LabNotFoundError unless running under this id
            return LabConfView(content="", exists=False)
        text = self.store.read_lab_conf_text(directory)
        return LabConfView(content=text or "", exists=text is not None)

    def lab_location(self, lab_id: str) -> Path:
        """Absolute host path of the lab's directory.

        Exists for the desktop shell (services/desktop), which needs a real host path to hand to
        the OS file manager and to a system terminal. The shell only ever holds an id, so it asks
        rather than guessing; an id resolves only to a directory this backend already knows.
        A reconstruct-only lab has no directory to show, so it is a 404 here like an unknown id.
        """
        return self._existing_lab_dir(lab_id)

    # -- fixed topology layout -------------------------------------------------

    def get_lab_layout(self, lab_id: str) -> LabLayout:
        """The lab's fixed topology layout, or an empty one when it has none.

        A missing *layout* is deliberately not a 404: "this lab has no fixed layout" is the normal
        case, and an unparseable/hand-broken ``lab.layout`` is ignored the same way (see
        ``LabStore.read_layout``) rather than breaking the topology view. A missing *lab* is a 404
        like every other per-lab endpoint.
        """
        data = self.store.read_layout(self._existing_lab_dir(lab_id))
        if data is None:
            return LabLayout()
        try:
            return LabLayout.model_validate(data)
        except ValidationError:
            logger.warning("Ignoring invalid %s for lab `%s`", lab_store.LAYOUT_FILENAME, lab_id, exc_info=True)
            return LabLayout()

    def save_lab_layout(self, lab_id: str, layout: LabLayout) -> LabLayout:
        """Write the lab's fixed topology layout to ``lab.layout`` (404 if the lab has no directory)."""
        self.store.write_layout(self._existing_lab_dir(lab_id), layout.model_dump())
        return layout

    def clear_lab_layout(self, lab_id: str) -> bool:
        """Delete the lab's ``lab.layout``; returns whether one existed."""
        return self.store.delete_layout(self._existing_lab_dir(lab_id))

    # -- interface slots -------------------------------------------------------

    @staticmethod
    def _compact_interfaces(machine: Machine) -> None:
        """Drop the ``None`` slots Kathara's ``Machine.remove_interface`` leaves behind, keeping
        every other number as it is.

        A running device keeps those slots on purpose (see ``disconnect_machine``), so this is
        only for a device on its way out of the model (``remove_machine``) and for the length of
        a refresh (``_empty_slots_hidden``): Kathara's ``undeploy_machine``,
        ``Lab.remove_machine`` and ``update_lab_from_api`` all read ``.link`` off every slot."""
        machine.interfaces = {num: iface for num, iface in machine.interfaces.items() if iface is not None}

    @staticmethod
    @contextmanager
    def _empty_slots_hidden(lab: Lab) -> Generator[None, None, None]:
        """Hide every device's empty interface slots from Kathara for the length of the block.

        A running device keeps the slot of an interface removed at runtime (``disconnect_machine``),
        and Kathara's ``update_lab_from_api`` reads ``.link`` off every slot. Each slot is put back
        afterwards unless the block filled its number, and any slot the block emptied itself (a
        collision domain detached outside this app) stays too. Hold ``_slot_lock`` across it.
        """
        hidden: list[tuple[Machine, list[int]]] = []
        for machine in lab.machines.values():
            empty = [num for num, iface in machine.interfaces.items() if iface is None]
            if empty:
                hidden.append((machine, empty))
                KatharaService._compact_interfaces(machine)
        try:
            yield
        finally:
            for machine, empty in hidden:
                slots = dict(machine.interfaces)
                for num in empty:
                    slots.setdefault(num, None)
                machine.interfaces = dict(sorted(slots.items()))

    @staticmethod
    def _renumber_interfaces(machine: Machine) -> None:
        """Drop the ``None`` slots ``Machine.remove_interface`` leaves behind *and* renumber the
        survivors to eth0..ethN-1, keeping their relative order.

        ``_compact_interfaces`` only drops the slots, which leaves a gap (e.g. 0, 2) — and a gap is
        rejected both by ``lab_import.parse_lab_conf`` and by Kathara's own ``Machine.check``, so it
        could neither be reloaded from disk nor deployed. Used only for a **stopped** device's
        offline disconnect (see ``disconnect_machine``): on a running device the numbers name real
        container interfaces and must not be rewritten, so the runtime branch keeps using
        ``_compact_interfaces``.
        """
        survivors = sorted(
            ((num, iface) for num, iface in machine.interfaces.items() if iface is not None),
            key=lambda kv: kv[0],
        )
        renumbered: dict[int, Any] = {}
        for new_num, (_, iface) in enumerate(survivors):
            iface.num = new_num
            renumbered[new_num] = iface
        machine.interfaces = renumbered

    # -- loading labs from disk, and the lab.conf text they load from ----------

    def _translate_lab_dir(self, lab_dir: Optional[Path]) -> Optional[lab_import.LabImportTranslation]:
        """Read a lab directory and parse it into a translation, or None if there is no directory
        (reconstruct-only lab) or its lab.conf can't be parsed (logged). The lab is named after
        its directory."""
        if lab_dir is None or not lab_dir.exists():
            return None
        files, _dirs = self.store.read_lab(lab_dir)
        t = lab_import.translate_lab_files(files, lab_dir.name)
        if t.errors:
            logger.warning("Cannot load lab `%s` from disk: %s", lab_dir, "; ".join(t.errors))
            return None
        return t

    def _config_lab_from_disk(self, lab_dir: Path) -> Optional[Lab]:
        """Build an in-memory Lab from the *on-disk* ``lab.conf`` — the configuration source of
        truth, free of any runtime interface changes that sit in the live registry model.

        The live model is shared for a lab: Kathara's runtime ``connect_machine_to_link`` calls
        ``Machine.add_interface`` (see DockerManager), so a running device's live interfaces end up
        in ``machine.interfaces`` too. Serializing that model would leak runtime edits into
        ``lab.conf``. Rebuilding from disk instead keeps offline (lab.conf) edits isolated from
        runtime ones. Returns None if the lab has no on-disk directory (reconstruct-only labs).

        Its one use is the folder-based-import bootstrap in ``_lab_conf_base_text`` — every other
        offline edit works on the stored ``lab.conf`` *text* directly (``lab_conf_edit``), never
        through this model round trip.
        """
        t = self._translate_lab_dir(lab_dir)
        if t is None:
            return None
        # path=None: in-memory fs — this Lab is only serialized back to lab.conf, never deployed,
        # so it must not touch (or contend for) the live lab's on-disk directory.
        return lab_builder.build_lab(t.payload)

    def _lab_conf_base_text(self, lab_dir: Optional[Path]) -> Optional[str]:
        """The on-disk ``lab.conf`` text an offline structural edit should be applied to, or None
        when there is nothing to (safely) edit.

        - Lab directory with a readable, parseable ``lab.conf``: its exact bytes.
        - Lab directory without one (folder-based import): bootstrap one from the on-disk
          configuration via ``gen_lab_conf`` — there is no user text to preserve here, so
          generating is lossless, and the lab gains a real ``lab.conf`` on its first edit.
        - Lab directory whose ``lab.conf`` can't be read back or doesn't parse: None. Blocking an
          unrelated device edit on a pre-existing problem would be worse than not persisting it;
          ``update_lab_conf`` (``PUT .../lab-conf``) is the repair path.
        - No directory at all (reconstruct-only lab): None. An offline edit must never conjure a
          lab directory as a side effect — the lab was never persisted in the first place.
        """
        if lab_dir is None or not lab_dir.is_dir():
            return None
        conf_path = self.store.lab_conf_path(lab_dir)
        if conf_path.is_file():
            text = self.store.read_lab_conf_text(lab_dir)
            if text is None:
                logger.warning("Not editing %s: it could not be read back", conf_path)
                return None
            if lab_conf_edit.parse_errors(text):
                logger.warning("Not editing %s: the stored file does not parse", conf_path)
                return None
            return text
        config_lab = self._config_lab_from_disk(lab_dir)
        return lab_store.gen_lab_conf(config_lab) if config_lab is not None else None

    def _edit_lab_conf(self, lab_id: str, edit: Callable[[str], str]) -> None:
        """Apply a surgical, line-level edit to the stored ``lab.conf`` and write it back
        atomically.

        ``edit`` is a pure text -> text transform from ``lab_conf_edit``; it never sees a ``Lab``
        object, which is exactly why a running device's runtime interface changes can never leak
        into the saved configuration — the on-disk text *is* the configuration here, the live
        model is never consulted. Writing nothing when the edit is a no-op keeps mtimes stable.
        """
        lab_dir = self._lab_dir(lab_id)
        base = self._lab_conf_base_text(lab_dir)
        if base is None:
            return
        new_text = edit(base)
        if new_text != base:
            self.store.write_lab_conf_text(lab_dir, new_text)

    def _reload_from_disk(self) -> None:
        """Rebuild the registry from every lab directory this backend knows: the store root's own,
        then the folders opened from elsewhere (``known``).

        An opened folder that is missing (an unmounted drive, a folder moved away) stays known
        rather than being forgotten — it may well come back — and is just not loaded.
        """
        opened = [d for d in self.known.dirs() if not self.store.is_under_root(d)]
        for lab_dir in [*self.store.lab_dirs(), *opened]:
            if not lab_dir.is_dir():
                logger.info("Not loading lab `%s`: the folder is missing", lab_dir)
                continue
            self._adopt_dir(lab_dir)

    def _adopt_dir(self, lab_dir: Path) -> Optional[Lab]:
        """Load ``lab_dir`` and register it, unless a lab with its id is already registered.
        Returns the registered lab, or None when the folder doesn't load (logged)."""
        try:
            t = self._translate_lab_dir(lab_dir)
            if t is None:
                return None
            # Re-associate the lab with its real, already-populated directory (machines whose
            # subfolder already exists on disk automatically pick up machine.fs — see Kathara's
            # Machine.__init__), so a redeployed/reloaded lab stays OS-backed.
            lab = lab_builder.build_lab(t.payload, path=str(lab_dir))
            if not self.registry.add_if_absent(lab, lab_dir):
                logger.warning(
                    "Not loading `%s`: it has the same Kathara identity as `%s`",
                    lab_dir, self.registry.directory(lab.hash),
                )
                return None
            return lab
        except Exception:
            logger.warning("Failed to reload lab `%s` from disk", lab_dir, exc_info=True)
            return None

    @staticmethod
    def _folder_signature(lab_dir: Path) -> Optional[tuple[int, Optional[int]]]:
        """What decides whether a folder that didn't load is worth another try: its own mtime
        (a device folder or a lab.conf added or removed) and its lab.conf's (edited). None if the
        folder can't be read."""
        try:
            own = lab_dir.stat().st_mtime_ns
        except OSError:
            return None
        try:
            conf = (lab_dir / LAB_CONF_FILENAME).stat().st_mtime_ns
        except OSError:
            conf = None
        return own, conf

    def rescan_labs_root(self) -> list[str]:
        """Adopt every folder under the labs root that isn't a registered lab yet — one copied or
        extracted there while the backend runs — and return the ids of those adopted, each also
        announced as a lab event of kind ``adopted``.

        Called on every listing and by the disk watcher on each poll, so it has to be cheap when
        nothing changed: one directory listing, and a folder that didn't load is only retried
        once it changes (``_folder_signature``). A folder some request is creating, renaming or
        deleting right now is skipped (``_claiming_if_free``) and seen again on the next pass.
        """
        # By id, not by path: the id is what registration is keyed on (lab_store.lab_id_for).
        registered = set(self.registry.ids())
        candidates = [d for d in self.store.lab_dirs() if lab_id_for(d) not in registered]
        with self._unadoptable_lock:
            # Forget folders that are gone or got registered some other way.
            for gone in set(self._unadoptable) - set(candidates):
                del self._unadoptable[gone]
        adopted: list[str] = []
        for lab_dir in candidates:
            signature = self._folder_signature(lab_dir)
            if signature is None:
                continue
            with self._unadoptable_lock:
                if self._unadoptable.get(lab_dir) == signature:
                    continue
            with self._claiming_if_free(lab_id_for(lab_dir)) as claimed:
                if not claimed or self.registry.get(lab_id_for(lab_dir)) is not None:
                    continue
                lab = self._adopt_dir(lab_dir)
            if lab is None:
                with self._unadoptable_lock:
                    self._unadoptable[lab_dir] = signature
                continue
            logger.info("Loaded lab `%s`, found in the labs folder", lab_dir)
            adopted.append(lab.hash)
            self._publish_disk_event(lab.hash, "adopted", [])
        return adopted

    def _reload_lab_from_disk(self, lab_dir: Optional[Path]) -> Optional[Lab]:
        """Rebuild a single lab's model from its on-disk lab.conf, *replacing* the registry entry,
        and return it. Used after a full undeploy to drop runtime-only model changes (e.g.
        interfaces added live) and restore the saved configuration topology, and after a rename to
        load the lab from where it now is. Returns None if there is no directory (reconstruct-only
        labs) or the stored lab.conf can't be parsed.

        Doesn't touch any device's actual files/dirs — those live only on the real on-disk fs
        (``lab.fs``/``machine.fs``), never mirrored into a separate in-memory structure, so there is
        nothing here that could go stale or be lost by rebuilding the model.
        """
        t = self._translate_lab_dir(lab_dir)
        if t is None:
            return None
        lab = lab_builder.build_lab(t.payload, path=str(lab_dir))
        self.registry.add(lab, lab_dir)
        # lab.conf can't hold a domain with no device on it, so the drafts are put back by hand;
        # one a device has since been connected to is in lab.conf now, and stops being a draft.
        for name in self.registry.drafts(lab.hash):
            existing = lab.links.get(name)
            if existing is not None and existing.machines:
                self.registry.discard_draft(lab.hash, name)
            else:
                lab.get_or_new_link(name)
        return lab

    # -- imports (upload, examples, gallery) and lab.conf saves ----------------

    def _adopt_populated_dir(self, clean_name: str) -> tuple[Lab, list[str]]:
        """Parse an already-populated, on-disk lab directory and register it.

        Shared tail of ``upload_lab`` and ``_install_from`` (both install paths) — they differ
        only in *how* the directory got populated (zip extraction, a gallery download, a verbatim
        copy of a bundled example), never in how the populated directory becomes a registered Lab.
        Rolls the directory back if parsing or registration fails, so no caller has to: a
        half-populated directory must never outlive the request that created it.
        """
        lab_dir = self.store.lab_dir(clean_name)
        try:
            files, _dirs = self.store.read_lab(lab_dir)
            t = lab_import.translate_lab_files(files, clean_name)
            if t.errors:
                raise ApiError("; ".join(t.errors))
            lab = self._adopt_lab_dir(lab_dir, t)
        except Exception:
            if self.registry.get(lab_id_for(lab_dir)) is None:
                self.store.delete_lab(lab_dir)  # roll back the populated directory
            raise
        return lab, t.warnings

    def upload_lab(self, name: str, zip_data: BinaryIO, deploy: bool = False) -> tuple[Lab, list[str]]:
        """Create (and optionally deploy) a lab from an uploaded .zip archive, verbatim.

        The archive is extracted to disk exactly as uploaded — comments, quoting, ``shared.startup``/
        ``shared.shutdown``, binaries and all — then parsed the same way as a JSON-described
        import. Machine subfolders that already exist on disk after extraction are picked up
        automatically as ``machine.fs`` (see ``Machine.__init__``), so any binary files travel to
        the deployed container via Kathara's native ``pack_data``, straight off disk.
        """
        clean_name = lab_store.sanitize_lab_name(name)
        lab_dir = self.store.lab_dir(clean_name)
        with self._claiming(lab_id_for(lab_dir)):
            self._assert_dir_free(lab_dir)
            self.store.extract_zip(clean_name, zip_data)
            lab, warnings = self._adopt_populated_dir(clean_name)
        if deploy:
            lab = self.deploy_lab(lab.hash)
        return lab, warnings

    def list_example_labs(self) -> list[ExampleSummary]:
        """Bundled example network scenarios, each flagged with whether it's already installed —
        see services/examples.py and the frontend's welcome screen."""
        return examples.list_examples(set(self.store.lab_names()))

    def _to_gallery_catalog(self, catalog: lab_gallery.Catalog) -> GalleryCatalog:
        installed = set(self.store.lab_names())
        return GalleryCatalog(
            repo=catalog.repo,
            ref=catalog.ref,
            section=catalog.section,
            fetched_at=catalog.fetched_at,
            labs=[
                GalleryLabSummary(
                    id=entry.id,
                    name=entry.name,
                    category=entry.category,
                    n_files=entry.n_files,
                    size_bytes=entry.size_bytes,
                    repo_url=entry.repo_url,
                    installed=entry.name in installed,
                )
                for entry in catalog.entries.values()
            ],
        )

    async def list_gallery_labs(self, refresh: bool = False) -> GalleryCatalog:
        """The upstream Kathara-Labs catalog, each entry flagged with whether it's already
        installed — the remote twin of ``list_example_labs``. See services/lab_gallery.py.

        Async because the fetch is network-bound and the route awaits it: a synchronous fetch
        here would block the event loop for the whole round trip, and a burst of callers would
        each park a threadpool worker behind it. See docs/DESIGN-NOTES.md. The sync
        ``fetch_catalog`` still serves ``install_gallery_lab`` through ``lab_gallery.get_entry``,
        which is not on the event loop.
        """
        return self._to_gallery_catalog(await lab_gallery.fetch_catalog_async(refresh=refresh))

    def _install_from(self, clean_name: str, populate: Callable[[], None]) -> tuple[Lab, list[str]]:
        """Claim the directory ``clean_name`` names, populate it, and adopt what landed there.

        The shared tail of both install paths; they differ only in ``populate`` (files written from
        a gallery download, or a bundled example copied). Anything slow that does *not* need the
        directory — a gallery fetch — belongs before the call, not inside ``populate``.
        """
        lab_dir = self.store.lab_dir(clean_name)
        with self._claiming(lab_id_for(lab_dir)):
            # Re-checked inside the lock: the caller's pre-check may have run before a long
            # download, so by now another create may well have taken the name.
            self._assert_dir_free(lab_dir)
            populate()
            return self._adopt_populated_dir(clean_name)

    def install_gallery_lab(self, entry_id: str, name: Optional[str] = None) -> tuple[Lab, list[str]]:
        """Create a lab from an entry in the upstream Kathara-Labs gallery.

        Structurally identical to ``install_example`` — the only difference is *how* the lab
        directory gets populated (files downloaded over HTTP, instead of a local copy) — see
        ``_install_from``, which both share. The download happens before anything touches the labs
        directory and outside every lock, so a slow or failing fetch never blocks other lab
        operations; only the re-checked 409 and the on-disk write run under the directory's
        ``_claiming`` lock, inside ``_install_from``, like every other create.
        """
        entry = lab_gallery.get_entry(entry_id)  # raises GalleryLabNotFoundError (404) if unknown
        clean_name = lab_store.sanitize_lab_name(name or entry.name)
        self._assert_dir_free(self.store.lab_dir(clean_name))

        # Downloaded *before* `_install_from` takes the lab's lock, not inside it: a slow or failing
        # fetch must not hold a lock other operations on this directory are waiting for.
        files = lab_gallery.download_lab_files(entry)
        return self._install_from(clean_name, lambda: self.store.write_lab(clean_name, files))

    def install_example(self, example_id: str, name: Optional[str] = None) -> tuple[Lab, list[str]]:
        """Create a lab from one of the bundled example network scenarios.

        Structurally identical to ``upload_lab`` — the only difference is *how* the lab
        directory gets populated (a verbatim copy of a bundled example, instead of a zip
        extraction) — both end in ``_adopt_populated_dir``, this one through ``_install_from``.
        Installing is a create, not an upsert: an existing lab under the target name is a 409,
        exactly like upload_lab, so retrying an install never silently overwrites something the
        user changed.
        """
        clean_name = lab_store.sanitize_lab_name(name or example_id)
        self._assert_dir_free(self.store.lab_dir(clean_name))

        source = examples.example_dir(example_id)  # raises ExampleNotFoundError (404) if unknown
        return self._install_from(clean_name, lambda: self.store.copy_lab_dir(clean_name, source))

    def update_lab_conf(self, lab_id: str, content: str) -> Lab:
        """Rebuild a **non-deployed** lab from an edited ``lab.conf`` (topology + device metadata).

        The submitted text is stored **verbatim** (``LabStore.write_lab_conf_text``) — never
        normalized through parse-and-regenerate — so whatever the caller submits is exactly what
        lands on disk: comments, ordering, quoting and options this API doesn't interpret survive
        an editor save unchanged. Existing on-disk device files and startup scripts are preserved
        by re-reading the lab directory and overriding only ``lab.conf`` before re-parsing.
        Rejected with 409 while the lab is deployed (rebuilding would desync running containers) —
        undeploy first. Binary device files aren't representable in the text merge and would be
        dropped; they belong to the Runtime FS flow instead.
        """
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)  # raises LabNotFoundError if unknown
            if self._has_running_device(lab):
                raise LabConfLockedError(
                    f"Cannot edit lab.conf while `{lab.name}` is deployed. Undeploy it first."
                )
            # A lab with no directory is reconstruct-only, i.e. running, so it never gets here.
            lab_dir = self._existing_lab_dir(lab_id)
            files, _dirs = self.store.read_lab(lab_dir)
            files[LAB_CONF_FILENAME] = content
            t = lab_import.translate_lab_files(files, lab_dir.name)
            if t.errors:
                raise ApiError("; ".join(t.errors))
            # Validate against a throwaway in-memory Lab (check_integrity, MAC format, meta
            # validation) *before* writing anything, so a bad submission never partially lands.
            lab_builder.build_lab(t.payload)
            # The only file this writes is lab.conf, verbatim — never store.write_lab(files, dirs),
            # which would rewrite every device file from read_lab's newline-normalized,
            # binary-stripped output.
            self.store.write_lab_conf_text(lab_dir, content)
            # Rebuild under the same id, replacing the previous registration/model, from the
            # text just written.
            self.registry.remove(lab_id)
            return self._build_and_register(t.payload, lab_dir)

    # -- offline lab filesystem (the Lab Configuration tab) --------------------
    #
    # Browses/edits the lab's own on-disk directory directly — lab.conf, every device's own
    # subdirectory, its <name>.startup, and anything else at the lab root (no separate in-memory
    # tracking of what's there; the filesystem itself is the only source of truth, so a
    # redeploy/undeploy/rename can never lose track of something a cache failed to reconstruct).
    # A write under a device's own path (or its <name>.startup) marks that device "dirty" — see
    # registry.mark_dirty — so a later redeploy of an already-running container knows to live-push
    # the change (deploy_lab's already-running branch, _live_push below).

    def get_startup_scripts(self, lab_id: str) -> dict[str, str]:
        """Each device's real ``<machine>.startup`` content (``""`` if it doesn't exist, or if it
        isn't valid UTF-8) — a fresh scan, not a cache. Backs the topology node-info panel's
        boot-time IP preview across all devices at once, so one device's corrupted/binary
        ``.startup`` must not blank out every other device's preview.
        """
        lab = self.get_lab_or_reconstruct(lab_id)
        result: dict[str, str] = {}
        for name in lab.machines:
            fname = f"{name}.startup"
            text = ""
            if lab.fs.exists(fname) and not self._escapes_lab(lab, fname):
                try:
                    text = lab.fs.readtext(fname)
                except UnicodeDecodeError:
                    text = ""
            result[name] = text
        return result

    @_lab_file_permissions
    def fs_list_offline(self, lab_id: str, path: str) -> list[FsEntry]:
        """A directory listing straight off the real fs — no synthesized entries. A device with
        nothing on disk yet simply doesn't appear at the root, the same way an empty/nonexistent
        directory has no listing on a normal filesystem; it starts existing the moment something
        is written under it (`fs_write_text_offline`/`fs_mkdir_offline`/etc.), and stops existing
        again once its last real content is deleted (see `fs_delete_offline`)."""
        path = self._clean_offline_path(path)
        lab = self.get_lab_or_reconstruct(lab_id)
        self._confine(lab, path)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)
        normalized = self.normalize_guest_path(path)
        entries: dict[str, FsEntry] = {}
        if target_fs is not None:
            if target_fs.exists(guest):
                if not target_fs.isdir(guest):
                    raise ApiError(f"`{path}` is a file, not a directory.")
                for info in target_fs.scandir(guest, namespaces=["details"]):
                    entries[info.name] = self._fs_entry(info, normalized)
            elif guest != "/":
                raise PathNotFoundError(f"Path `{path}` not found.")
            # guest == "/" with nothing materialized yet (a device with no machine.fs) is a
            # legitimate empty listing, not an error.
        return sorted(entries.values(), key=lambda e: (not e.is_dir, e.name.lower()))

    @_lab_file_permissions
    def fs_search_offline(
        self, lab_id: str, path: str, query: str, case_sensitive: bool = False
    ) -> tuple[list[FsSearchMatch], bool]:
        """Search file contents under a directory in the lab's own on-disk tree. One
        PyFilesystem2 walk from a single resolved owner fs — when `path` resolves to the lab root
        (ROOT_MACHINE), that walk already reaches every device's on-disk files too, since
        `machine.fs` is just an `opendir()` view nested inside `lab.fs`'s own directory; no
        separate fan-out over `lab.machines` is needed."""
        path = self._clean_offline_path(path)
        lab = self.get_lab_or_reconstruct(lab_id)
        self._confine(lab, path)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)

        # Read once for the whole walk rather than per file: one search has to apply one threshold
        # to every file it considers, or a concurrent PUT /settings would make its results depend
        # on where in the tree the walk happened to be.
        max_file_size = get_settings().max_bytes_per_file
        matches: list[FsSearchMatch] = []
        truncated = False
        if target_fs is not None and target_fs.exists(guest):
            for file_path in (p for p, is_dir in _walk(target_fs, guest) if not is_dir):
                if len(matches) >= _SEARCH_MAX_TOTAL_MATCHES:
                    truncated = True
                    break
                # `file_path` is absolute within the device's own fs, and `join` drops everything
                # before an absolute part, so it goes in relative.
                display_path = (
                    file_path if owner == ROOT_MACHINE else fs.path.join(f"/{owner}", file_path.lstrip("/"))
                )
                # The walk follows a symlinked directory, so a file under one may lie outside.
                if self._escapes_lab(lab, display_path):
                    continue
                try:
                    info = target_fs.getinfo(file_path, namespaces=["details"])
                    if info.size is not None and info.size > max_file_size:
                        continue
                    text = target_fs.readtext(file_path)
                except UnicodeDecodeError:
                    continue  # binary — same tolerance as every other offline text read
                except fs.errors.ResourceError:
                    continue  # vanished between walk() and readtext() — benign race
                except fs.errors.PermissionDenied:
                    continue  # unreadable (a device's root-owned file): nothing to match in it

                remaining = _SEARCH_MAX_TOTAL_MATCHES - len(matches)
                file_matches, file_capped = _search_lines_in_text(
                    text, query, case_sensitive, min(_SEARCH_MAX_MATCHES_PER_FILE, remaining)
                )
                if file_capped:
                    truncated = True
                matches.extend(
                    FsSearchMatch(path=display_path, line_number=lineno, line_text=text_)
                    for lineno, text_ in file_matches
                )
        elif guest != "/":
            raise PathNotFoundError(f"Path `{path}` not found.")
        return matches, truncated

    def _resolve_offline_file(self, lab_id: str, path: str):
        """Resolve a cleaned offline path to ``(fs, guest_path)`` for reading, or raise.

        404 for a path that is not there, 400 for a directory — the two answers both readers owe
        before they can differ about *how* they read the bytes.
        """
        lab = self.get_lab_or_reconstruct(lab_id)
        self._confine(lab, path)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)
        if target_fs is None or not target_fs.exists(guest):
            raise PathNotFoundError(f"Path `{path}` not found.")
        if target_fs.isdir(guest):
            raise ApiError(f"`{path}` is a directory. Use list to navigate it.")
        return target_fs, guest

    @_lab_file_permissions
    def fs_read_text_offline(self, lab_id: str, path: str) -> str:
        """The UTF-8 text of a file in the lab's folder; ``lab.conf`` is read through ``read_lab_conf``.
        ``PathNotFoundError`` (404) for a missing path, 400 for a directory, ``BinaryFileError`` for a file
        that isn't UTF-8."""
        path = self._clean_offline_path(path)
        # Only the text read short-circuits lab.conf: it is the one whose content the API owns a
        # canonical copy of. A bytes read (a download) wants the file as it is on disk.
        if self._is_lab_conf(path):
            return self.read_lab_conf(lab_id).content
        target_fs, guest = self._resolve_offline_file(lab_id, path)
        try:
            return target_fs.readtext(guest)
        except UnicodeDecodeError as exc:
            raise BinaryFileError("File is not UTF-8 text. Use download for binary files.") from exc

    @_lab_file_permissions
    def fs_read_bytes_offline(self, lab_id: str, path: str) -> bytes:
        """A file in the lab's folder, byte for byte as it is on disk — ``lab.conf`` included.
        ``PathNotFoundError`` (404) for a missing path, 400 for a directory."""
        target_fs, guest = self._resolve_offline_file(lab_id, self._clean_offline_path(path))
        return target_fs.readbytes(guest)

    @_lab_file_permissions
    def fs_write_text_offline(self, lab_id: str, path: str, content: str) -> int:
        """Write ``content`` over a file in the lab's folder and return the bytes written.

        ``lab.conf`` goes through ``update_lab_conf``. Any other file is written under ``_mutate_lock``,
        refused while the lab is transitioning, and marks its device dirty for the next redeploy
        (``_dirty_target_for``).
        """
        path = self._clean_offline_path(path)
        if self._is_lab_conf(path):
            # update_lab_conf does its own _check_not_transitioning.
            self.update_lab_conf(lab_id, content)
            return len(content.encode("utf-8"))
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            self._confine(lab, path)
            owner, guest = self._offline_fs_owner(lab, path)
            if owner == ROOT_MACHINE:
                self._write_lab_root_files(lab, {guest: content}, [])
            else:
                self._write_machine_files(lab, owner, {guest: content}, [])
            self._mark_dirty_for(lab, lab_id, path)
        return len(content.encode("utf-8"))

    @_lab_file_permissions
    def fs_upload_bytes_offline(self, lab_id: str, path: str, content: bytes) -> int:
        """Write raw ``content`` over a file in the lab's folder, creating its parent folders, and return its
        size. ``lab.conf`` must be UTF-8 and goes through ``update_lab_conf``; any other file is handled as
        in ``fs_write_text_offline``."""
        path = self._clean_offline_path(path)
        if self._is_lab_conf(path):
            # Routed exactly like fs_write_text_offline's, and for the same reasons. Unguarded, an
            # upload to the *literal* path "lab.conf" writes raw bytes straight over it: no parse
            # validation, no 409 while the lab is deployed, no registry rebuild, and (being bytes)
            # not even a guarantee the file is still text.
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ApiError("lab.conf must be UTF-8 text.") from exc
            self.update_lab_conf(lab_id, text)
            return len(content)
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            self._confine(lab, path)
            owner, guest = self._offline_fs_owner(lab, path)
            target_fs = self._fs_for_write(lab, owner)
            parent = posixpath.dirname(guest)
            if parent and parent != "/":
                target_fs.makedirs(parent, recreate=True)
            target_fs.writebytes(guest, content)
            self._mark_dirty_for(lab, lab_id, path)
        return len(content)

    @_lab_file_permissions
    def fs_mkdir_offline(self, lab_id: str, path: str) -> None:
        """Create a folder, and any missing parents, in the lab's folder. Under ``_mutate_lock``, refused
        while the lab is transitioning; a folder under a device marks that device dirty."""
        path = self._clean_offline_path(path)
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            self._confine(lab, path)
            owner, guest = self._offline_fs_owner(lab, path)
            if owner == ROOT_MACHINE:
                self._write_lab_root_files(lab, {}, [guest])
            else:
                self._write_machine_files(lab, owner, {}, [guest])
            self._mark_dirty_for(lab, lab_id, path)

    @_lab_file_permissions
    def fs_delete_offline(self, lab_id: str, path: str, recursive: bool = False) -> None:
        """Delete a file, or a folder — only an empty one unless ``recursive``.

        Refuses ``lab.conf`` and the lab root. Deleting a device's own folder removes it entirely, and it
        reappears as soon as something is written under it. Under ``_mutate_lock``, refused while the lab
        is transitioning.
        """
        path = self._clean_offline_path(path)
        if self._is_lab_conf(path):
            raise ApiError("lab.conf can't be deleted.")
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            self._confine(lab, path)
            owner, guest = self._offline_fs_owner(lab, path)

            # The lab root itself is never a valid delete target — `DELETE /labs/{lab}` is what
            # removes a lab. Normalized rather than a raw string comparison, since "/", "", "//",
            # "/." and "pc1/.." all resolve to the same root directory once pyfilesystem gets hold
            # of them, which is what `target_fs.removetree` would actually delete. The `lab.conf`
            # guards normalize for the same reason — a raw string comparison there misses
            # "./lab.conf"; see `_clean_offline_path`.
            if self._is_lab_root(owner, guest):
                raise ApiError("The lab root can't be deleted. Delete the lab instead.")

            if owner != ROOT_MACHINE and guest == "/":
                # Deleting a device's own folder removes it entirely — machine.fs stops existing
                # (matching fs_list_offline, which then stops showing it) rather than leaving an
                # empty shell behind; it starts existing again the moment anything new is written
                # under this device. <name>.startup is a separate, sibling entry and untouched.
                machine = self._registered_machine(lab, owner)
                if machine.fs is not None and lab.fs.exists(owner):
                    # Same non-empty guard as the generic branch below — `recursive` means the
                    # same thing everywhere in this endpoint, not "always recursive for a device's
                    # own root."
                    if not recursive and next(iter(lab.fs.scandir(owner)), None) is not None:
                        raise ApiError(f"`{path}` is not empty. Delete recursively to remove it.")
                    _remove_tree(lab.fs, owner)
                machine.fs = None
                return

            target_fs = self._fs_for(lab, owner)
            if target_fs is None:
                raise PathNotFoundError(f"Path `{path}` not found.")
            if not target_fs.exists(guest):
                raise PathNotFoundError(f"Path `{path}` not found.")
            if target_fs.isdir(guest):
                if not recursive and next(iter(target_fs.scandir(guest)), None) is not None:
                    raise ApiError(f"`{path}` is not empty. Delete recursively to remove it.")
                _remove_tree(target_fs, guest)
            else:
                target_fs.remove(guest)
            self._mark_dirty_for(lab, lab_id, path)

    def _resolve_two_ended_offline_op(self, lab_id: str, source_path: str, destination_path: str):
        """Resolve both ends of a move or a copy to ``(lab, src_fs, src_guest, dst_fs, dst_guest)``.

        Must be called while holding ``_mutate_lock``: the callers' own work continues under it.

        What deliberately stays with the callers is the ``lab.conf`` guard, because the two do not
        agree on it — a move refuses lab.conf at *either* end, a copy only refuses overwriting it —
        and the divergent tail: a move needs a same-fs/cross-fs split and marks both paths dirty,
        a copy needs neither.
        """
        lab = self.get_lab_or_reconstruct(lab_id)
        self._confine(lab, source_path)
        self._confine(lab, destination_path)
        source_owner, source_guest = self._offline_fs_owner(lab, source_path)
        dest_owner, dest_guest = self._offline_fs_owner(lab, destination_path)
        # Neither end may be the lab's own root: moving it away and copying something over it are
        # as destructive as deleting it, which `fs_delete_offline` already refuses.
        if self._is_lab_root(source_owner, source_guest) or self._is_lab_root(dest_owner, dest_guest):
            raise ApiError("The lab root can't be moved or copied.")

        src_fs = self._fs_for(lab, source_owner)
        if src_fs is None or not src_fs.exists(source_guest):
            raise PathNotFoundError(f"Path `{source_path}` not found.")

        dst_fs = self._fs_for_write(lab, dest_owner)
        parent = posixpath.dirname(dest_guest)
        if parent and parent != "/":
            dst_fs.makedirs(parent, recreate=True)

        return lab, src_fs, source_guest, dst_fs, dest_guest

    @_lab_file_permissions
    def fs_move_offline(self, lab_id: str, source_path: str, destination_path: str) -> None:
        """Move a file or folder within the lab's folder: a file replaces one at the destination, a folder
        merges into one there, and a symlink moves as the link it is.

        Refuses ``lab.conf`` at either end and the lab root. Marks the devices of both paths dirty. Under
        ``_mutate_lock``, refused while the lab is transitioning.
        """
        source_path = self._clean_offline_path(source_path)
        destination_path = self._clean_offline_path(destination_path)
        if self._is_lab_conf(source_path) or self._is_lab_conf(destination_path):
            raise ApiError("lab.conf can't be moved.")
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab, src_fs, source_guest, dst_fs, dest_guest = self._resolve_two_ended_offline_op(
                lab_id, source_path, destination_path
            )

            is_dir = src_fs.isdir(source_guest)
            same_fs = src_fs is dst_fs
            if is_dir:
                # Copy-then-remove on either kind of move, never pyfilesystem's own movedir: that
                # is a copy_dir + removetree too, and both follow symlinks (see _remove_tree).
                _copy_tree(src_fs, source_guest, dst_fs, dest_guest)
                _remove_tree(src_fs, source_guest)
            else:
                if same_fs:
                    src_fs.move(source_guest, dest_guest, overwrite=True)
                else:
                    fs.copy.copy_file(src_fs, source_guest, dst_fs, dest_guest)
                    src_fs.remove(source_guest)

            for p in (source_path, destination_path):
                self._mark_dirty_for(lab, lab_id, p)

    @_lab_file_permissions
    def fs_copy_offline(self, lab_id: str, source_path: str, destination_path: str) -> None:
        """Copy a file or folder within the lab's folder, like ``fs_move_offline`` but keeping the source.
        Refuses copying over ``lab.conf`` and the lab root, and marks the destination's device dirty."""
        source_path = self._clean_offline_path(source_path)
        destination_path = self._clean_offline_path(destination_path)
        if self._is_lab_conf(destination_path):
            raise ApiError("lab.conf can't be replaced by copy — edit it directly.")
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab, src_fs, source_guest, dst_fs, dest_guest = self._resolve_two_ended_offline_op(
                lab_id, source_path, destination_path
            )

            # No same-fs/cross-fs split like fs_move_offline needs: both helpers work identically
            # either way, and unlike move there is no source to remove.
            if src_fs.isdir(source_guest):
                _copy_tree(src_fs, source_guest, dst_fs, dest_guest)
            else:
                fs.copy.copy_file(src_fs, source_guest, dst_fs, dest_guest)

            self._mark_dirty_for(lab, lab_id, destination_path)

    # -- resolving a lab and refreshing it from Docker -------------------------

    def get_lab_or_reconstruct(self, lab_id: str, *, refresh_in_transition: bool = False) -> Lab:
        """Return the registered Lab (refreshed from the backend) or reconstruct it.

        Raises LabNotFoundError if the lab is neither registered nor running. A reconstructed lab
        is whatever Kathara runs under ``lab_hash=lab_id`` — e.g. one started with ``kathara
        lstart`` in a directory this backend has never loaded — and carries the placeholder name
        Kathara's ``get_lab_from_api`` gives it, since nothing on a container records a lab name.

        ``refresh_in_transition`` is for ``deploy_lab`` alone, which looks its own lab up while it
        is marked as transitioning: see ``_refresh_from_api``.
        """
        lab = self.registry.get(lab_id)
        if lab is not None:
            facade = self._facade_or_offline()
            if facade is None:
                # Docker is unreachable: the registered model came from disk and is the whole
                # answer, minus the live overlay. See _facade_or_offline/_offline_lab_state.
                return self._offline_lab_state(lab)
            self._refresh_from_api(facade, lab, in_own_transition=refresh_in_transition)
            return lab

        # Not registered: try to rebuild from the running backend state. Nothing to fall back on
        # here — an unregistered lab exists only as running containers, so with no daemon to ask
        # there is genuinely no such lab, which is the same 404 as "nothing is running under it".
        facade = self._facade_or_offline()
        if facade is None:
            raise _lab_not_found(lab_id)
        try:
            reconstructed = facade.get_lab_from_api(lab_hash=lab_id)
        except LabNotFoundError as exc:
            raise _lab_not_found(lab_id) from exc

        # get_lab_from_api returns an empty Lab when nothing is running under that hash.
        if not reconstructed.machines:
            raise _lab_not_found(lab_id)
        return reconstructed

    def list_labs(self) -> list[Lab]:
        """Every registered lab, after adopting any new folder under the labs root (``rescan_labs_root``),
        each refreshed from Docker — or shown with nothing running when the daemon can't be reached."""
        self.rescan_labs_root()
        labs = self.registry.all()
        facade = self._facade_or_offline()
        if facade is None:
            # Docker unreachable: still list every lab on disk, just with nothing marked running.
            return [self._offline_lab_state(lab) for lab in labs]
        for lab in labs:
            self._refresh_from_api(facade, lab)
        return labs

    def _refresh_from_api(self, facade: Kathara, lab: Lab, *, in_own_transition: bool = False) -> None:
        """Overlay what is actually running under ``lab.hash`` onto the registered model.

        Empty interface slots are hidden from Kathara for the refresh (``_empty_slots_hidden``),
        under the lab's ``_slot_lock``; a device whose container is gone takes the interfaces its
        lab.conf declares back (``_restore_declared_interfaces``).

        Skipped while the lab is mid deploy/undeploy, unless the caller is that transition itself
        (``in_own_transition``). A deploy creates each container attached to its first collision
        domain only and attaches the others once it has started (Kathara's ``DockerMachine.start``),
        so a refresh in between sees those interfaces as detached at runtime and has Kathara drop
        them from the model — the very model the deploy is iterating to attach them. The
        transition keeps the model current on its own: Kathara sets each device's ``api_object``
        as it creates the container, and ``undeploy_lab`` clears them when it is done.

        ``update_lab_from_api`` only ever *sets* ``api_object`` — on a fresh container object for
        each device still running — and never clears it for one whose container is gone. A lab's
        containers can go away without this backend doing it: the id is the same hash ``kathara
        lstart``/``lclean`` compute in the lab's directory (``lab_store.lab_id_for``), so the CLI
        can stop a lab this app deployed. A device whose ``api_object`` is still the very object it
        had before the refresh therefore has no container any more, and is cleared the same way an
        undeploy clears it (``_clear_undeployed_state``).

        Compared by identity after the refresh rather than cleared before it, so no concurrent
        reader ever sees a running device momentarily reported as stopped. Only a Docker
        ``Container`` is checked, since that is what the Docker manager — the only one this app
        drives (see ``system_info``) — replaces on every refresh; anything else cannot be known
        to be gone this way and is left as it is.
        """
        if not in_own_transition and self._is_transitioning(lab.hash):
            return
        with self._slot_lock(lab.hash):
            before = {name: m.api_object for name, m in lab.machines.items() if isinstance(m.api_object, Container)}
            with self._empty_slots_hidden(lab):
                try:
                    facade.update_lab_from_api(lab)
                except LabNotFoundError:
                    # Some managers raise when nothing is running under this hash; the Docker
                    # manager instead enriches with whatever containers exist (none) and never
                    # raises. Either way nothing is running, which the stale check below reflects.
                    pass
            stale = {
                name for name, obj in before.items() if name in lab.machines and lab.machines[name].api_object is obj
            }
            if stale:
                self._clear_undeployed_state(lab, stale)
                self._restore_declared_interfaces(lab, stale)

    def _clear_undeployed_state(
        self,
        lab: Lab,
        machine_names: set[str],
        link_names: Optional[set[str]] = None,
    ) -> None:
        """Clear stale ``api_object`` references after an undeploy.

        Kathara's Docker manager never resets ``api_object`` on the in-memory Machine/Link
        objects when a container/network goes down — it only *sets* it for still-running ones
        on resync (``update_lab_from_api``). Without this, ``deployed``/``running`` (derived from
        ``api_object is not None``) would keep reporting the pre-undeploy state forever. This
        mirrors the manager's own rule for collision domains: a link only actually goes down once
        none of its attached devices are still running.
        """
        for name in machine_names:
            machine = lab.machines.get(name)
            if machine is not None:
                machine.api_object = None

        candidate_links = (
            [lab.links[n] for n in link_names if n in lab.links]
            if link_names is not None
            else list(lab.links.values())
        )
        for link in candidate_links:
            if not any(m.api_object is not None for m in link.machines.values()):
                link.api_object = None

    def _restore_declared_interfaces(self, lab: Lab, machine_names: set[str]) -> None:
        """Give each of ``machine_names``, devices whose containers are gone, back the interfaces
        its lab.conf declares, dropping whatever changed at runtime.

        The per-device counterpart of the full undeploy's ``_reload_lab_from_disk``, for a device
        stopped while others keep running. Needed as well as consistent: a new container attaches
        its interfaces from eth0 in order, so an empty slot kept for its predecessor
        (``disconnect_machine``) would make the next deploy misnumber the interfaces after it, or
        fail outright on reading ``.link`` off it. A collision domain this leaves with no device
        goes too, unless lab.conf declares it, it is a draft, or its network is still up. When
        lab.conf can't be read, each device keeps its interfaces, renumbered from eth0
        (``_renumber_interfaces``).
        """
        machines = [lab.machines[name] for name in machine_names if name in lab.machines]
        if not machines:
            return
        translation = self._translate_lab_dir(self._lab_dir(lab.hash))
        if translation is None:
            for machine in machines:
                self._renumber_interfaces(machine)
            return
        declared = {spec.name: spec.interfaces for spec in translation.payload.machines}
        declared_links = {iface.link for interfaces in declared.values() for iface in interfaces}
        for machine in machines:
            for iface in machine.interfaces.values():
                if iface is not None:
                    iface.link.machines.pop(machine.name, None)
            machine.interfaces = {}
            for iface in declared.get(machine.name, []):
                lab.connect_machine_to_link(
                    machine.name, iface.link, machine_iface_number=iface.number, mac_address=iface.mac_address
                )
            machine.interfaces = dict(sorted(machine.interfaces.items()))
        drafts = self.registry.drafts(lab.hash)
        for name, link in list(lab.links.items()):
            if not link.machines and link.api_object is None and name not in declared_links and name not in drafts:
                del lab.links[name]

    # -- deploy, undeploy, rename, delete --------------------------------------

    @staticmethod
    def _resolve_targets(
        all_names: set[str], selected: Optional[set[str]], excluded: Optional[set[str]]
    ) -> set[str]:
        """Resolve a target name set: ``selected`` wins over ``excluded``; neither means everything."""
        if selected is not None:
            return selected
        if excluded is not None:
            return all_names - excluded
        return all_names

    def deploy_lab(
        self,
        lab_id: str,
        selected_machines: Optional[set[str]] = None,
        excluded_machines: Optional[set[str]] = None,
    ) -> Lab:
        """Deploy the lab — or only ``selected_machines``, or every device but ``excluded_machines`` — and
        return it.

        A device already running is not recreated: the files changed under it since its last deploy are
        pushed into its container instead (``_live_push``). The lab is marked as transitioning and holds
        ``_mutate_lock`` for the whole call; a second deploy or undeploy meanwhile is a
        ``LabTransitioningError`` (409). A failure is kept for the lab to show
        (``registry.set_deploy_failure``).
        """
        # Self-checked exactly like every other guarded mutator — without this, two
        # concurrent deploy_lab calls on the same lab both pass _begin_transition (a set add, not
        # a lock) and run concurrently, each computing its own fresh/already-running split from a
        # Lab object the other is mutating at the same time, colliding inside the facade call on
        # MachineAlreadyExistsError. Must run before _begin_transition, same reasoning as every
        # other call site: checking after taking _mutate_lock below would just wait out the hang
        # this exists to avoid.
        self._check_not_transitioning(lab_id)
        # Marked as transitioning for the whole call, not just the facade section below — a
        # lab.conf edit/offline-fs write/structural change arriving anywhere in this window should
        # fail fast via _check_not_transitioning rather than queue up behind _mutate_lock.
        self._begin_transition(lab_id)
        try:
            # The entire body, not just the facade call: reading `lab`/computing the fresh vs
            # already-running split is itself a read of shared model state (`lab.machines`,
            # `machine.api_object`) that another mutator could otherwise change mid-computation —
            # mirrors undeploy_lab, which already locks its whole body for the same reason.
            with self._mutate_lock:
                if selected_machines and excluded_machines:
                    raise InvocationError("You can either select or exclude devices.")

                lab = self.get_lab_or_reconstruct(lab_id, refresh_in_transition=True)
                all_names = set(lab.machines.keys())

                # Mirror the facade's own validation (it would otherwise never run for this call,
                # since below we always pass it a freshly-computed `selected_machines`, not the
                # caller's raw selected/excluded_machines).
                for label, requested in (("selected", selected_machines), ("excluded", excluded_machines)):
                    if requested is not None and not requested <= all_names:
                        missing = requested - all_names
                        raise MachineNotFoundError(
                            f"The following devices are not in the network scenario: {missing}."
                        )

                target_names = self._resolve_targets(all_names, selected_machines, excluded_machines)

                # Already-running machines can't be recreated — Kathara's facade raises
                # MachineAlreadyExistsError for them — so only machines about to be *freshly*
                # created are passed to it. Their files are already on disk by now: an
                # import/upload wrote them there verbatim (see _adopt_lab_dir) and any pre-deploy
                # edit was written through immediately by fs_write_text_offline/etc. — so
                # Kathara's own deploy machinery (Machine.pack_data) packs them straight from the
                # real (osfs) fs, with nothing to materialize here. Already-running targets
                # instead get any *changed* file pushed live via ``_live_push`` (the dirty set —
                # see registry.mark_dirty — not everything, so an untouched machine isn't
                # redundantly re-pushed and its startup script re-executed on every redeploy), the
                # only way to reach a container that already exists.
                pre_running = {m.name for m in lab.machines.values() if m.api_object is not None}
                fresh_names = target_names - pre_running
                already_running = target_names & pre_running

                if fresh_names:
                    self._check_deployable(lab, fresh_names)
                    try:
                        self._facade().deploy_lab(lab, selected_machines=fresh_names)
                    except Exception as exc:
                        # The devices that did start stay up (Kathara starts them side by side), so
                        # the reason is kept for the ones that didn't — see set_deploy_failure.
                        whole_lab = selected_machines is None and excluded_machines is None
                        if whole_lab or not _privileged_device_refused(exc):
                            message = (
                                known_error_detail(exc)
                                or "An unexpected error stopped the deploy; the backend log has the details."
                            )
                            self.registry.set_deploy_failure(lab_id, DeployFailure(message, frozenset(fresh_names)))
                            raise
                        self.registry.set_deploy_failure(
                            lab_id, DeployFailure(PRIVILEGED_ONLY_WITH_LAB, frozenset(fresh_names))
                        )
                        raise PrivilegeError(f"{exc} {PRIVILEGED_SINGLE_DEPLOY_HINT}") from exc
                    self.registry.clear_deploy_failure(lab_id)
                    # Native pack_data just packed each fresh machine's *current* on-disk state,
                    # so any dirty flag an offline edit set before this deploy is already
                    # reflected — discard it rather than leaving it to trigger a spurious
                    # live-push on some future redeploy.
                    self.registry.pop_dirty_machines(lab_id, fresh_names)

                dirty = self.registry.pop_dirty_machines(lab_id, already_running)
                if dirty:
                    self._live_push(lab_id, lab, dirty)
                return lab
        finally:
            self._end_transition(lab_id)

    @staticmethod
    def _check_deployable(lab: Lab, names: set[str]) -> None:
        """Refuse the deploy, before any network or container exists, when a device's ``mem`` or
        ``cpus`` is one Kathara cannot read.

        Kathara reads both only while creating each container, and creates a lab's containers side
        by side: one bad value fails its own device while every other one starts, leaving a lab
        half up because of a typo. ``get_mem``/``get_cpu`` are the very readers it uses, so the
        check can neither miss a value Kathara rejects nor refuse one it accepts — the lab-wide
        ``mem`` included, which ``get_mem`` also reads.
        """
        problems = []
        for name in sorted(names):
            machine = lab.machines[name]
            for read in (machine.get_mem, machine.get_cpu):
                try:
                    read()
                except MachineOptionError as exc:
                    problems.append(str(exc))
        if problems:
            raise MachineOptionError(f"Can't deploy: {' '.join(problems)}")

    @staticmethod
    def _boot_script(lab: Lab, machine: Machine) -> str:
        """The script a *live* push must run for an already-running device: what native deploy
        would run for a fresh one, in the same order (``DockerMachine.STARTUP_COMMANDS``):
        ``shared.startup``, the device's own ``<name>.startup`` (read straight off ``lab.fs`` —
        the real, only copy of it), then any ``exec_commands``. Only needed here — for a fresh
        deploy, ``Machine.pack_data`` and the container's own boot sequence already handle all
        three natively, straight off disk.
        """
        parts = []
        if lab.fs.exists("shared.startup"):
            try:
                shared_text = lab.fs.readtext("shared.startup")
            except Exception:
                shared_text = ""
            if shared_text.strip():
                parts.append(shared_text)
        startup_name = f"{machine.name}.startup"
        if lab.fs.exists(startup_name):
            try:
                own_startup = lab.fs.readtext(startup_name)
            except Exception:
                own_startup = ""
            if own_startup.strip():
                parts.append(own_startup)
        commands = machine.get_exec_commands()
        if commands:
            parts.append("\n".join(commands))
        return "\n".join(parts)

    def _live_push(self, lab_id: str, lab: Lab, target_names: set[str]) -> None:
        """Live-push each already-running target's *current* on-disk files/dirs/startup into its
        container, and re-run its boot script.

        Native deploy (``Machine.pack_data``, see ``deploy_lab``) already applies on-disk state
        for machines freshly created by this deploy call, so this is scoped to only the subset
        that was already running before it: a redeploy can't recreate a running container
        (Kathara raises ``MachineAlreadyExistsError``), so pushing files/exec'ing the startup
        script live is the only way to update one. Order matches the Kathara CLI's own:
        filesystem first, then the startup script (composed via ``_boot_script`` — see there).
        Reads straight off ``machine.fs``/``lab.fs`` — there is no cached spec to read instead.
        """
        for machine_name in target_names:
            machine = lab.machines.get(machine_name)
            if machine is None or machine.api_object is None:
                continue

            files: dict[str, str] = {}
            if machine.fs is not None:
                entries = list(_walk(machine.fs))
                dirs = [p for p, is_dir in entries if is_dir]
                if dirs:
                    quoted = " ".join(shlex.quote(d) for d in dirs)
                    self._exec_checked(lab_id, machine_name, f"mkdir -p {quoted}", action_label="mkdir")
                for file_path in (p for p, is_dir in entries if not is_dir):
                    if self._escapes_lab(lab, f"/{machine_name}{file_path}"):
                        continue  # a link out of the lab: never pushed, like every other read
                    try:
                        files[file_path] = machine.fs.readtext(file_path)
                    except UnicodeDecodeError:
                        continue  # binary — this live-push path is text-only

            boot_script = self._boot_script(lab, machine)
            has_startup = bool(boot_script.strip())
            if has_startup:
                files["/tmp/.kathara_boot.sh"] = boot_script
            if files:
                self.copy_files(lab_id, machine_name, files)
            if has_startup:
                self.exec_command(lab_id, machine_name, "sh /tmp/.kathara_boot.sh", wait=False)

    def undeploy_lab(
        self,
        lab_id: str,
        selected_machines: Optional[set[str]] = None,
        excluded_machines: Optional[set[str]] = None,
        selected_links: Optional[set[str]] = None,
    ) -> None:
        """Stop the lab, or only the selected devices or collision domains.

        A full undeploy puts the model back to what ``lab.conf`` declares; a partial one does that for the
        devices it stopped only. 404 for a lab with neither a registration nor a directory. Transitioning
        and under ``_mutate_lock`` for the whole call, like ``deploy_lab``.
        """
        # Marked as transitioning for the whole call (see deploy_lab's own comment on why), plus
        # everything here runs inside one lock section, not just the facade call — the model
        # bookkeeping below (`_clear_undeployed_state`, and for a full undeploy, replacing the
        # registry entry via `_reload_lab_from_disk`) is as much a state mutation as the facade
        # call itself, and this module's own docstring promises every one of those is serialized.
        # Left outside the lock, a concurrent deploy_lab/add_machine/connect_machine could read
        # `machine.api_object`/the registry mid-transition — e.g. still non-None right after the
        # facade call returns but before `_clear_undeployed_state` clears it, making a
        # just-stopped machine look "already running" and get silently skipped by that concurrent
        # deploy_lab's fresh/already-running split.
        #
        # Self-checked for the same reason deploy_lab is: without this, a second
        # concurrent undeploy_lab on the same lab doesn't fail fast, it just queues up behind
        # _mutate_lock and then runs the facade call a second time against a lab already brought
        # down by the first — a confusing lower-level error instead of a clean "try again".
        self._check_not_transitioning(lab_id)
        self._begin_transition(lab_id)
        try:
            with self._mutate_lock:
                lab = self.registry.get(lab_id)
                lab_dir = self._lab_dir(lab_id)
                if lab is None and lab_dir is None:
                    raise _lab_not_found(lab_id)
                self._facade().undeploy_lab(
                    lab_hash=lab_id,
                    selected_machines=selected_machines,
                    excluded_machines=excluded_machines,
                    selected_links=selected_links,
                )
                if lab is not None:
                    machine_names = self._resolve_targets(
                        set(lab.machines.keys()), selected_machines, excluded_machines
                    )
                    self._clear_undeployed_state(lab, machine_names, selected_links)

                # A full undeploy brings the whole lab down, so restore the topology to the saved
                # configuration (lab.conf) — discarding any runtime-only model changes such as
                # interfaces added/removed live. A partial undeploy does the same for the devices
                # it stopped only, and must not disturb the ones left running (and their live
                # state).
                full_undeploy = selected_machines is None and excluded_machines is None and selected_links is None
                if full_undeploy:
                    self._reload_lab_from_disk(lab_dir)
                elif lab is not None:
                    self._restore_declared_interfaces(lab, machine_names)
                # A deploy failure explains devices that should be running and aren't; once none
                # is meant to run, there is nothing left for it to explain.
                if full_undeploy or lab is None or not any(m.api_object is not None for m in lab.machines.values()):
                    self.registry.clear_deploy_failure(lab_id)
        finally:
            self._end_transition(lab_id)

    def rename_lab(self, lab_id: str, new_name: str) -> Lab:
        """Rename a **non-deployed** lab's directory, in place, and return the lab under its new id.

        The id is derived from the directory's path (``lab_store.lab_id_for``), and it is also the
        hash Kathara derives container/network names from, so a rename *changes the id* — and is
        rejected with 409 while the lab is deployed, since its containers would be left under the
        old one. Undeploy first. Nothing inside the lab is rewritten: ``lab.conf`` is not
        regenerated (the name never appears in it — a ``LAB_NAME`` key is dropped at import time),
        and device files/startup scripts/``lab.layout`` travel with the directory.

        The model is rebuilt from the moved directory (``_reload_lab_from_disk``) rather than
        mutating ``lab.name`` in place, so the ``Lab`` — and every machine's ``fs`` — is re-anchored
        on the new path, and registered under the new id.
        """
        clean_new = lab_store.sanitize_lab_name(new_name)
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)  # raises LabNotFoundError if unknown
            lab_dir = self._existing_lab_dir(lab_id)
            if clean_new == lab_dir.name:
                return lab
            if self._has_running_device(lab):
                raise LabRenameLockedError(
                    f"Cannot rename `{lab.name}` while it is deployed. Undeploy it first."
                )
            target = lab_dir.parent / clean_new
            # The destination is claimed the same way a create claims it — otherwise this
            # check-then-move races an import of `clean_new` exactly as two unguarded creates race
            # each other. Acquired *after* `_mutate_lock`, never before: creates take `_claiming`
            # alone and never reach for `_mutate_lock` while holding it, so this ordering cannot
            # close a cycle.
            with self._claiming(lab_id_for(target)):
                self._assert_dir_free(target)
                moved = self.store.rename_lab(lab_dir, clean_new)
                try:
                    renamed = self._reload_lab_from_disk(moved)
                    if renamed is None:
                        raise ApiError(f"Lab `{lab.name}` could not be reloaded after renaming.")
                except Exception:
                    self.store.rename_lab(moved, lab_dir.name)  # roll the directory back
                    raise
                self.registry.remove(lab_id)
                if not self.store.is_under_root(moved):
                    self.known.replace(lab_dir, moved)
                return renamed

    def delete_lab(self, lab_id: str) -> None:
        """Undeploy a lab under the labs root and delete its folder.

        A folder opened from elsewhere is a ``LabDeleteRefusedError`` (409). A folder holding a file this
        user can't remove is a ``LabFilePermissionError`` (403) before anything is undeployed; a removal
        that still fails part-way leaves what remains listed. Unregistering and removing the folder run
        under ``_claiming``, like a create.
        """
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab_dir = self._lab_dir(lab_id)
            if self.registry.get(lab_id) is None and lab_dir is None:
                raise _lab_not_found(lab_id)
            if lab_dir is not None and not self.store.is_under_root(lab_dir):
                raise LabDeleteRefusedError(
                    f"`{self._lab_label(lab_id)}` is a folder opened from outside the labs folder, so it "
                    "can't be deleted from here. Close it instead."
                )
            # Before the undeploy, so a refused delete leaves the lab exactly as it was, running
            # included. A device writing a new root-owned file after this check is what the
            # part-way failure below still covers.
            if lab_dir is not None:
                blocked = self.store.first_undeletable(lab_dir)
                if blocked is not None:
                    path = _lab_display_path(str(blocked), lab_dir)
                    raise LabFilePermissionError(
                        f"`{self._lab_label(lab_id)}` can't be deleted: {_owned_by_another_account(path)}. "
                        "Nothing was deleted."
                    )
            try:
                self._facade().undeploy_lab(lab_hash=lab_id)
            except DockerDaemonConnectionError:
                # A lab's directory is plain disk I/O and needs no daemon to remove — and with no
                # daemon reachable, there is nothing that could still be running to undeploy first.
                # Any other failure here (the daemon *is* up but the undeploy itself fails) must
                # keep propagating: deleting the directory out from under live containers is worse
                # than leaving the lab undeleted.
                logger.warning("Docker daemon unreachable while deleting lab `%s`; skipping undeploy", lab_id)
        # Claimed like a create does: unregistering and removing the directory are what *release*
        # it, and without the lock they can land in the middle of a concurrent import into the
        # same directory — deleting what that import had just written.
        #
        # Unregistered before the directory goes, never after: the disk watcher would otherwise
        # find a registered lab with no folder and report it missing (handle_disk_change). A
        # removal that fails part-way — typically files an elevated session left owned by root —
        # puts the same model back, so what is left stays listed and the delete can be retried;
        # reloading it from disk instead could fail on a lab.conf already removed.
        with self._claiming(lab_id):
            label = self._lab_label(lab_id)
            lab = self.registry.remove(lab_id)
            if lab_dir is None:
                return
            try:
                self.store.delete_lab(lab_dir)
            except OSError as exc:
                if lab is not None and lab_dir.is_dir():
                    self.registry.add(lab, lab_dir)
                error = LabFilePermissionError if isinstance(exc, PermissionError) else ApiError
                raise error(
                    f"`{label}` could not be deleted completely: {exc.strerror or exc} ({exc.filename}). "
                    "What is left is still listed; try again once that is fixed."
                ) from exc

    # -- machines -------------------------------------------------------------

    def get_machine_api_object(self, lab_id: str, machine_name: str):
        """Return backend-native API object for a running machine.

        Used by features that require manager-specific low-level capabilities
        (for example interactive TTY websocket bridging on Docker).
        """
        self._get_running_machine(lab_id, machine_name)
        getter = getattr(self._facade(), "get_machine_api_object", None)
        if not callable(getter):
            raise UnsupportedOperationError("Live TTY is not supported by the current Kathara manager.")
        return getter(machine_name, lab_hash=lab_id)

    def available_shells(self, lab_id: str, machine_name: str) -> list[str]:
        """Return the supported shells actually present (executable) in the *running* device, in
        canonical order — used to populate the live-terminal shell picker. Falls back to the full
        supported set if the device can't be probed."""
        self._get_running_machine(lab_id, machine_name)  # 409 if the device isn't running
        # One probe: echo the name of each known shell whose resolved binary is executable — the same
        # path the live-TTY session would exec (see docker_tty.resolve_shell_path).
        probe = "".join(f"[ -x {path} ] && echo {name}\n" for name, path in SHELL_PATHS.items())
        try:
            stdout, _, _ = self.exec_command(lab_id, machine_name, ["sh", "-lc", probe], wait=False)
        except Exception:
            stdout = None
        found = {ln.strip() for ln in _decode(stdout).splitlines() if ln.strip()}
        available = [name for name in SHELL_PATHS if name in found]
        return available or list(SHELL_PATHS)

    def add_machine(self, lab_id: str, spec: MachineCreate) -> Machine:
        """Add a device to the lab, stopped, and append it to ``lab.conf``.

        Adding a device is a *configuration* edit, whether or not the lab is running. Starting it
        is a separate step — a single-device deploy, or the lab's next deploy — so the one path
        that starts devices (deploy_lab) is also the one that checks and explains why one can't
        start.
        """
        # `lab` is (re)read *inside* the lock, not before it — matching update_machine/
        # update_lab_conf/rename_lab: a `lab` read outside it could be an orphan the registry no
        # longer tracks (undeploy_lab replaces it via _reload_lab_from_disk).
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            # Render + validate the lab.conf block *before* touching the model, so a spec that
            # can't be represented (name clash, interface-number gap) fails with no side effects
            # instead of leaving a device behind or an unloadable file on disk.
            lab_dir = self._lab_dir(lab_id)
            base = self._lab_conf_base_text(lab_dir)
            new_conf = lab_conf_edit.add_device(base, spec) if base is not None else None
            machine = lab_builder.build_machine(lab, spec)
            if new_conf is not None:
                self.store.write_lab_conf_text(lab_dir, new_conf)
        return machine

    def update_machine(self, lab_id: str, machine_name: str, spec: MachineUpdate) -> Machine:
        """Replace a stopped device's full option set (image/mem/.../volumes) from ``spec``.

        This is a configuration edit, not a runtime one — rejected with 409 while the lab is
        deployed (mirroring ``update_lab_conf``'s gate exactly), unlike ``add_machine``, which adds
        a stopped device to a running lab too. There is no live-redeploy path here: editing options
        only ever takes effect from the lab's next deploy.
        """
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            if self._has_running_device(lab):
                raise LabConfLockedError(
                    f"Cannot edit device options while `{lab.name}` is deployed. Undeploy it first."
                )
            machine = lab.get_machine(machine_name)  # raises MachineNotFoundError
            # Render + validate the lab.conf edit *before* mutating the live model, so a spec that
            # can't be represented fails with no side effects (mirrors add_machine's ordering).
            lab_dir = self._lab_dir(lab_id)
            base = self._lab_conf_base_text(lab_dir)
            new_conf = lab_conf_edit.replace_device_options(base, machine_name, spec) if base is not None else None
            lab_builder.apply_options(machine, spec)
            if new_conf is not None:
                self.store.write_lab_conf_text(lab_dir, new_conf)
            return machine

    def remove_machine(self, lab_id: str, machine_name: str, keep_links: bool = False) -> None:
        """Undeploy a device and drop it: from the model, its files from disk, its lines from ``lab.conf``.
        ``keep_links`` keeps its collision domains' networks up."""
        # `lab`/`machine` are (re)read *inside* the lock — see add_machine's comment on why reading
        # them beforehand would let a concurrent deploy_lab/undeploy_lab run first and act on
        # stale state (e.g. a `machine` whose interfaces changed since, or a `lab` the registry
        # already replaced).
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            machine = lab.get_machine(machine_name)
            link_names = {iface.link.name for iface in machine.interfaces.values() if iface is not None}
            # Kathara's undeploy_machine and Lab.remove_machine read `.link` off every slot, and
            # the device leaves the model, so its empty slots (see disconnect_machine) go first.
            with self._slot_lock(lab_id):
                self._compact_interfaces(machine)
            self._facade().undeploy_machine(machine, keep_links=keep_links)
            # link_names=None means "check every link in the lab" to _clear_undeployed_state, so a
            # kept link set must be the empty set (not None) to mean "check none of them".
            self._clear_undeployed_state(lab, {machine_name}, set() if keep_links else link_names)
            # The facade only undeploys — it leaves the device in the model, where it would keep
            # reappearing in the topology/devices forever. Drop it from the Lab too (and its
            # on-disk files).
            # delete_fs=False: Kathara's own delete_fs uses removedir(), which fails on a non-empty
            # device folder — clean the fs ourselves recursively (see _remove_machine_fs).
            lab.remove_machine(name=machine_name, delete_fs=False)
            self._remove_machine_fs(lab, machine_name)
            # Drop the device's lines from the persisted lab.conf — every other line in the file
            # (comments, other devices, unmodelled options) stays byte-identical.
            self._edit_lab_conf(lab_id, lambda text: lab_conf_edit.remove_device(text, machine_name))

    @staticmethod
    def _remove_machine_fs(lab: Lab, machine_name: str) -> None:
        """Recursively delete a device's on-disk files: its ``<name>.startup``/``.shutdown`` scripts
        and its ``<name>/`` folder (Kathara's own ``delete_fs`` can't — it uses ``removedir``, which
        fails on a non-empty folder).

        ``<name>`` is the device's folder only when it is a directory, the same rule Kathara's own
        ``Machine`` applies when it loads one: a plain file of that name belongs to the user, not
        to the device, and stays. The Remove Device confirmation lists exactly these files
        (``deviceFilesOnDisk`` in the frontend's ``services/labfs.ts``) and must follow this.
        """
        for fname in (f"{machine_name}.startup", f"{machine_name}.shutdown"):
            if lab.fs.exists(fname):
                lab.fs.remove(fname)
        if lab.fs.isdir(machine_name):
            _remove_tree(lab.fs, machine_name)

    def connect_machine(
        self,
        lab_id: str,
        machine_name: str,
        link_name: str,
        interface_number: Optional[int] = None,
        mac_address: Optional[str] = None,
    ) -> Machine:
        """Attach a device to a collision domain, creating the domain if needed.

        A stopped device gets the interface in ``lab.conf`` too, numbered ``interface_number`` or the next
        free one. A running device is connected live, not persisted, and cannot be given an
        ``interface_number`` (``UnsupportedOperationError``).
        """
        # `lab`/`machine`/`link`, and — critically — the running-vs-stopped branch below, are all
        # decided *inside* the lock (see add_machine's comment on why). Deciding the branch from a
        # `machine.api_object` read taken before the lock could see "stopped" and then have a
        # concurrent deploy_lab start the device before this function's own critical section runs:
        # the interface would be written to lab.conf instead of connected live, silently invisible
        # to the now-running container.
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            machine = lab.get_machine(machine_name)

            # `lab.get_or_new_link` adds the domain to the model, so each branch calls it only once
            # every check that can still refuse the request has passed: a refused request must not
            # leave an empty domain behind.

            # For stopped devices, update the topology model directly so interfaces can be
            # prepared before deploy (supports explicit interface numbering). This is a "static"
            # edit — persist it to lab.conf so it survives a reload / is applied on the next deploy.
            if machine.api_object is None:
                # Resolve the interface number against the *on-disk* configuration — the same
                # source the text edit itself reads — and hand the resolved number to the live
                # model too, so lab.conf and the model can never disagree about eth numbering.
                lab_dir = self._lab_dir(lab_id)
                base = self._lab_conf_base_text(lab_dir)
                number = interface_number
                new_conf = None
                if base is not None:
                    if number is None:
                        number = lab_conf_edit.next_interface_number(base, machine_name)
                    new_conf = lab_conf_edit.add_interface(base, machine_name, number, link_name, mac_address)
                link = lab.get_or_new_link(link_name)
                machine.add_interface(link, number=number, mac_address=mac_address)
                if new_conf is not None:
                    self.store.write_lab_conf_text(lab_dir, new_conf)
                return machine

            if interface_number is not None:
                raise UnsupportedOperationError(
                    "Explicit interface_number is only supported when the device is not running."
                )

            # Kathara starts a device with no interfaces in Docker's `none` network mode, and Docker
            # refuses to attach any network to such a container. Checked here because Kathara's own
            # connect adds the interface to the model and creates the collision domain before
            # Docker refuses, leaving a phantom interface behind an unreadable daemon error.
            if self._started_without_network(machine):
                raise UnsupportedOperationError(
                    f"Device `{machine_name}` was started without any network interface, so its container "
                    "has networking disabled and cannot be attached to links at runtime. "
                    "To connect it, stop the lab, add the device to a collision domain, and restart the lab."
                )

            link = lab.get_or_new_link(link_name)
            # Kathara numbers the new interface by counting the device's slots, empty ones
            # included (see disconnect_machine), so no refresh may hide them meanwhile.
            with self._slot_lock(lab_id):
                self._facade().connect_machine_to_link(
                    machine,
                    link,
                    mac_address=mac_address,
                )
        return machine

    @staticmethod
    def _started_without_network(machine: Machine) -> bool:
        """Whether the device's Docker container was created in the `none` network mode. Only a
        Docker container carries ``attrs``; other managers' objects read as ``False``."""
        attrs = getattr(machine.api_object, "attrs", None)
        if not isinstance(attrs, dict):
            return False
        return (attrs.get("HostConfig") or {}).get("NetworkMode") == "none"

    def disconnect_machine(
        self, lab_id: str, machine_name: str, link_name: str, keep_link: bool = False
    ) -> None:
        """Detach a device from a collision domain.

        A stopped device loses the interface in ``lab.conf`` too, its higher interfaces renumbered down. A
        running device is disconnected live only, and keeps the empty interface slot until it stops.
        """
        # `lab`/`machine`/`link` and the running-vs-stopped branch are all decided *inside* the
        # lock — same reasoning as connect_machine above (and add_machine's comment): deciding it
        # from a read taken before the lock risks acting on a device whose running state has
        # since changed under a concurrent deploy_lab/undeploy_lab.
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            machine = lab.get_machine(machine_name)
            link = lab.get_link(link_name)

            # For stopped devices, update the topology model only (a "static" lab.conf edit) and
            # persist.
            if machine.api_object is None:
                # Remove the interface line and renumber the device's higher interfaces: a gap is
                # an error for both this project's parser and Kathara's own Machine.check, so a
                # bare line delete would leave a lab.conf that can no longer be loaded or deployed.
                self._edit_lab_conf(
                    lab_id, lambda text: lab_conf_edit.remove_interface(text, machine_name, link_name)
                )
                machine.remove_interface(link)
                self._renumber_interfaces(machine)
                return

            # Running device: live disconnect, not persisted to lab.conf. The empty slot Kathara
            # leaves behind stays, on purpose: Docker never gives a container an ethN it has used
            # before, and Kathara numbers the next interface attached at runtime by counting the
            # slots (their number, or the highest plus one on a bridged device). Without it that
            # interface would be shown under a number its container doesn't have. Reads cope with
            # the slot (_empty_slots_hidden); it goes once the device stops
            # (_restore_declared_interfaces).
            with self._slot_lock(lab_id):
                self._facade().disconnect_machine_from_link(machine, link, keep_link=keep_link)

    def copy_files(self, lab_id: str, machine_name: str, files: dict[str, str]) -> None:
        """Copy text files into a running device's container, ``{guest path: content}``.
        ``MachineNotRunningError`` (409) unless it is running, checked under ``_mutate_lock``."""
        guest_to_host = {path: io.BytesIO(content.encode("utf-8")) for path, content in files.items()}
        # `_get_running_machine` (lab/machine lookup + the running check) belongs inside the lock:
        # checked outside it, a concurrent undeploy_lab/remove_machine could stop the device
        # between the check and the copy, so `self._facade().copy_files` would run against a
        # machine whose `api_object` this call never actually confirmed was still live.
        with self._mutate_lock:
            machine = self._get_running_machine(lab_id, machine_name)
            self._facade().copy_files(machine, guest_to_host)

    # -- runtime filesystem (a running device's own files) ---------------------

    def normalize_guest_path(self, path: str) -> str:
        """Return a canonical absolute path for runtime filesystem operations."""
        if not path or not path.strip():
            raise ApiError("Path cannot be empty.")
        cleaned = path.strip()
        if not cleaned.startswith("/"):
            cleaned = f"/{cleaned}"
        normalized = posixpath.normpath(cleaned)
        if not normalized.startswith("/"):
            normalized = f"/{normalized}"
        return normalized

    def _get_running_machine(self, lab_id: str, machine_name: str) -> Machine:
        lab = self.get_lab_or_reconstruct(lab_id)
        machine = lab.get_machine(machine_name)
        if machine.api_object is None:
            # MachineNotRunningError formats its own "Device `<name>` is not running." message.
            raise MachineNotRunningError(machine_name)
        return machine

    def _running_guest_path(self, lab_id: str, machine_name: str, path: str) -> str:
        """Assert the device is running and return the normalized guest path — the common preamble
        of every ``fs_*`` runtime-filesystem method."""
        self._get_running_machine(lab_id, machine_name)
        return self.normalize_guest_path(path)

    def _exec_checked(
        self,
        lab_id: str,
        machine_name: str,
        command: Union[str, list[str]],
        *,
        wait: bool = True,
        action_label: str,
    ) -> tuple[bytes, bytes]:
        """``exec_command`` for a command that must succeed: a non-zero exit becomes an ``ApiError`` naming
        ``action_label``, the device and the command's stderr. Returns ``(stdout, stderr)``, never None."""
        stdout, stderr, exit_code = self.exec_command(lab_id, machine_name, command, wait=wait)
        # Some backends can return None for empty streams; normalize so callers can decode safely.
        stdout = stdout if stdout is not None else b""
        stderr = stderr if stderr is not None else b""
        if exit_code != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            raise ApiError(f"{action_label} failed on `{machine_name}`: {err or f'exit code {exit_code}'}")
        return stdout, stderr

    # Lists the directory given as `$1`, one record per entry: kind, target kind, size, octal mode,
    # mtime and name, tab-separated, each record ending in NUL.
    #
    # The name goes last and each record ends in NUL, the one byte a filename cannot contain: a
    # name may hold tabs or newlines, but the five fields before it never do, so splitting on the
    # first five tabs always leaves the name whole.
    #
    # Two branches because `-printf` exists only in GNU find: BusyBox images (Alpine and anything
    # built on it) reject it. The fallback emits the same records from shell builtins plus
    # `stat -c`, whose output here is digits and spaces only, so word-splitting it is safe whatever
    # the name holds. Both branches dereference `$1` itself when it is a symlink (Debian/Ubuntu's
    # merged-usr `/bin -> usr/bin`) without following symlinks among the children: GNU find through
    # `-H` — plain `find` (`-P`) treats a symlinked start path as a leaf at depth 0, which
    # `-mindepth 1` then excludes, so the listing would come back empty — and the fallback by
    # `cd`-ing into it and inspecting each child with `[ -L ]` before `[ -d ]`.
    _FS_LIST_SCRIPT = (
        "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then\n"
        "  exec find -H \"$1\" -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%m\\t%T@\\t%f\\0'\n"
        "fi\n"
        "cd -- \"$1\" || exit 1\n"
        "for f in .[!.]* ..?* *; do\n"
        "  [ -e \"$f\" ] || [ -L \"$f\" ] || continue\n"
        "  if [ -L \"$f\" ]; then k=l; elif [ -d \"$f\" ]; then k=d; else k=f; fi\n"
        "  if [ -d \"$f\" ]; then t=d; else t=f; fi\n"
        "  st=$(stat -c '%s %a %Y' -- \"$f\" 2>/dev/null) || st=\n"
        "  set -- $st\n"
        "  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\0' \"$k\" \"$t\" \"$1\" \"$2\" \"$3\" \"$f\"\n"
        "done\n"
    )

    def fs_list_directory(self, lab_id: str, machine_name: str, path: str) -> list[FsEntry]:
        """List a directory of a running device (``_FS_LIST_SCRIPT``), directories first, a symlink to a
        directory counted as one. ``ApiError`` when the listing fails."""
        normalized = self._running_guest_path(lab_id, machine_name, path)
        # The path travels as a positional argument (`$1`, after `$0`), never spliced into the
        # script text, so it needs no shell quoting.
        stdout, _ = self._exec_checked(
            lab_id,
            machine_name,
            ["sh", "-lc", self._FS_LIST_SCRIPT, "sh", normalized],
            wait=False,
            action_label=f"List directory `{normalized}`",
        )

        entries: list[FsEntry] = []
        for record in stdout.decode("utf-8", errors="replace").split("\0"):
            parts = record.split("\t", 5)
            if len(parts) != 6 or not parts[5]:
                continue
            kind, target_kind, size_raw, mode, mtime_raw, name = parts
            try:
                size = int(size_raw)
            except ValueError:
                size = None
            try:
                mtime = float(mtime_raw)
            except ValueError:
                mtime = None
            entries.append(
                FsEntry(
                    name=name,
                    path=f"/{name}" if normalized == "/" else f"{normalized}/{name}",
                    # Treat symlinks to directories as directories for UI navigation.
                    is_dir=kind == "d" or (kind == "l" and target_kind == "d"),
                    size=size,
                    # Empty when the fallback branch found no usable `stat` in the image.
                    mode=mode or None,
                    mtime=mtime,
                )
            )
        # Same order as the offline tree and the host browser — directories first, then
        # case-insensitive by name — rather than whatever `find` happened to emit.
        return sorted(entries, key=lambda e: (not e.is_dir, e.name.lower()))

    # Exit code used to signal "path is a directory" from the combined test+cat below — distinct
    # from `cat`'s own exit codes (1 on error) and from a shell's own low-numbered exit codes.
    _FS_READ_IS_DIR_EXIT = 90

    def fs_read_bytes(self, lab_id: str, machine_name: str, path: str) -> bytes:
        """A file of a running device, read in one exec. ``ApiError`` for a directory or a failed read."""
        normalized = self._running_guest_path(lab_id, machine_name, path)
        quoted = shlex.quote(normalized)
        # A single exec instead of a `test -d` probe followed by a separate `cat` — halves the
        # docker-exec round trips for every Runtime FS file open.
        cmd = f"[ -d {quoted} ] && exit {self._FS_READ_IS_DIR_EXIT}; cat {quoted}"
        stdout, stderr, exit_code = self.exec_command(lab_id, machine_name, ["sh", "-lc", cmd], wait=False)
        if exit_code == self._FS_READ_IS_DIR_EXIT:
            raise ApiError(f"Path `{normalized}` is a directory. Use list to navigate it.")
        if exit_code != 0:
            err = _decode(stderr).strip()
            raise ApiError(f"Read file `{normalized}` failed: {err or f'exit code {exit_code}'}")
        return stdout or b""

    def fs_read_text(self, lab_id: str, machine_name: str, path: str) -> str:
        """``fs_read_bytes`` as UTF-8 text, or ``BinaryFileError`` for a file that isn't."""
        raw = self.fs_read_bytes(lab_id, machine_name, path)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BinaryFileError("File is not UTF-8 text. Use download for binary files.") from exc

    def get_startup_log(self, lab_id: str, machine_name: str) -> str:
        """The device's boot-time startup log: `/var/log/startup.log`, the redirected stdout+stderr
        of its `.startup` script followed by its lab.conf `exec_commands` (see Kathara's
        `DockerMachine.STARTUP_COMMANDS`). The file doesn't exist until the device actually has a
        `.startup` script to run — treated as "no log yet" (empty string) rather than an error,
        since polling this while a device is still booting is the whole point.
        """
        self._get_running_machine(lab_id, machine_name)
        stdout, _, exit_code = self.exec_command(lab_id, machine_name, ["cat", "/var/log/startup.log"], wait=False)
        if exit_code != 0:
            return ""
        return _decode(stdout)

    def is_startup_finished(self, lab_id: str, machine_name: str) -> bool:
        """Whether the device's startup commands (`.startup` script + `exec_commands`) have finished
        executing — mirrors Kathara's own internal check (`DockerMachine._wait_startup_execution`):
        the very last of its startup commands is `touch /tmp/EOS`, so the marker's existence is the
        signal. Must call `exec_command` with `wait=False` here — `wait=True` would itself block on
        this same condition via Kathara's blocking wait, defeating the point of polling for it.
        """
        self._get_running_machine(lab_id, machine_name)
        _, _, exit_code = self.exec_command(lab_id, machine_name, ["test", "-f", "/tmp/EOS"], wait=False)
        return exit_code == 0

    # One exec per device: its addresses, but only once its startup commands have finished (the
    # same `/tmp/EOS` marker as is_startup_finished) — a device still booting has not assigned
    # them yet, and comparing those with its startup would flag every one of them.
    _LIVE_ADDRESSES_PROBE = "test -f /tmp/EOS && ip -o addr show"

    def get_live_addresses(self, lab_id: str) -> dict[str, dict[int, list[str]]]:
        """The addresses on each running device's `ethN` interfaces, for the devices whose startup
        has finished (see live_addresses.parse_ip_o_addr). A device that is stopped, still booting,
        has no `ip` or cannot be reached is simply left out: this feeds a best-effort comparison
        with the startup files, and one device must not fail it for the others."""
        lab = self.get_lab_or_reconstruct(lab_id)
        result: dict[str, dict[int, list[str]]] = {}
        for name in sorted(lab.machines):
            if lab.machines[name].api_object is None:
                continue
            try:
                stdout, _, exit_code = self.exec_command(
                    lab_id, name, ["sh", "-c", self._LIVE_ADDRESSES_PROBE], wait=False
                )
            except Exception:
                continue
            if exit_code == 0:
                result[name] = live_addresses.parse_ip_o_addr(_decode(stdout))
        return result

    # Overwrites `$1` with the content of the staged file `$2`, then removes `$2` whatever happened.
    # `cat >` truncates the existing file and writes into the same inode, so its mode, owner, hard
    # links and bind mount all survive and its mtime becomes the time of the write; a missing file
    # is created by the shell (root, mode from the umask) inside its parent, created first.
    _FS_WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat -- "$2" > "$1"; rc=$?; rm -f -- "$2"; exit $rc'

    def fs_write_text(self, lab_id: str, machine_name: str, path: str, content: str) -> int:
        """Write ``content`` over a file of a running device, or create it, keeping an existing file's
        metadata (``_write_in_place``). Returns the bytes written."""
        normalized = self._running_guest_path(lab_id, machine_name, path)
        data = content.encode("utf-8")
        self._write_in_place(lab_id, machine_name, normalized, data)
        return len(data)

    def fs_upload_bytes(self, lab_id: str, machine_name: str, path: str, content: bytes) -> int:
        """``fs_write_text`` for raw bytes. Returns their count."""
        normalized = self._running_guest_path(lab_id, machine_name, path)
        self._write_in_place(lab_id, machine_name, normalized, content)
        return len(content)

    def _write_in_place(self, lab_id: str, machine_name: str, path: str, data: bytes) -> None:
        """Write `data` over the running device's file at `path`, keeping that file's metadata.

        Not a plain `copy_files` to `path`: Docker's archive upload deletes and recreates its
        target, which resets mode, owner and mtime (an executable script loses its `x` bit) and
        fails outright with "device or resource busy" on the files Docker bind-mounts into every
        container (`/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`). The upload therefore goes
        to a uniquely named staging file under `/tmp`, and `_FS_WRITE_SCRIPT` copies it over the
        real one in place.
        """
        staging = f"/tmp/.kathara-desktop-{uuid.uuid4().hex}"
        # Re-resolved inside the lock, for the reason `copy_files` spells out: the check the caller
        # already made is the same early 409 every other fs_* method gives, not the one the upload
        # can rely on.
        with self._mutate_lock:
            machine = self._get_running_machine(lab_id, machine_name)
            self._facade().copy_files(machine, {staging: io.BytesIO(data)})
            self._exec_checked(
                lab_id,
                machine_name,
                ["sh", "-lc", self._FS_WRITE_SCRIPT, "sh", path, staging],
                wait=False,
                action_label=f"Write file `{path}`",
            )

    def fs_mkdir(self, lab_id: str, machine_name: str, path: str) -> None:
        """Create a directory, and any missing parents, on a running device."""
        normalized = self._running_guest_path(lab_id, machine_name, path)
        self._exec_checked(
            lab_id,
            machine_name,
            ["mkdir", "-p", normalized],
            wait=False,
            action_label=f"Create directory `{normalized}`",
        )

    def fs_move(self, lab_id: str, machine_name: str, source_path: str, destination_path: str) -> None:
        """Move a path on a running device with ``mv``: into a destination directory that exists,
        not over it."""
        source = self._running_guest_path(lab_id, machine_name, source_path)
        destination = self.normalize_guest_path(destination_path)
        self._exec_checked(
            lab_id,
            machine_name,
            ["mv", "--", source, destination],
            wait=False,
            action_label=f"Move `{source}`",
        )

    def fs_copy(self, lab_id: str, machine_name: str, source_path: str, destination_path: str) -> None:
        """Copy a path on a running device with ``cp -a``: into a destination directory that exists, like
        ``fs_move``."""
        # Like `mv` above, `cp -a` copies *into* an existing destination directory rather than
        # replacing it — for both, the frontend deletes a confirmed directory collision before
        # calling this.
        source = self._running_guest_path(lab_id, machine_name, source_path)
        destination = self.normalize_guest_path(destination_path)
        self._exec_checked(
            lab_id,
            machine_name,
            ["cp", "-a", "--", source, destination],
            wait=False,
            action_label=f"Copy `{source}`",
        )

    def fs_delete(self, lab_id: str, machine_name: str, path: str, recursive: bool = False) -> None:
        """Delete a path on a running device: a file or an empty directory, or anything when ``recursive``."""
        normalized = self._running_guest_path(lab_id, machine_name, path)
        if recursive:
            self._exec_checked(
                lab_id,
                machine_name,
                ["rm", "-rf", "--", normalized],
                wait=False,
                action_label=f"Delete `{normalized}`",
            )
            return
        # Non-recursive delete supports files and empty directories.
        quoted = shlex.quote(normalized)
        cmd = f"rm -f -- {quoted} || rmdir -- {quoted}"
        self._exec_checked(
            lab_id,
            machine_name,
            ["sh", "-lc", cmd],
            wait=False,
            action_label=f"Delete `{normalized}`",
        )

    # -- links ----------------------------------------------------------------

    def add_link(self, lab_id: str, link_name: str, external: Optional[list[str]] = None) -> Link:
        """Add a collision domain, bridged to the host's ``external`` interfaces if any.

        A domain added with no device on it can't be written to lab.conf, so it is kept as a draft
        (LabRegistry.add_draft) until a device is connected to it. Its Docker network is created
        only while the lab is running: a stopped lab creates its networks when it is deployed.
        """
        # `lab`/`link` read *inside* the lock (see add_machine's comment on why), along with the
        # `link.external` model mutation — building it outside the lock is the same class of
        # issue as reading stale state: a concurrent operation on this lab could run in between.
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            link = lab.get_or_new_link(link_name)
            if external:
                for iface in external:
                    link.external.append(lab_builder.build_external_link(iface))
            if not link.machines:
                self.registry.add_draft(lab_id, link_name)
            if self._has_running_device(lab):
                self._facade().deploy_link(link)
        return link

    def remove_link(self, lab_id: str, link_name: str) -> None:
        """Remove a collision domain, and every interface on it, from the model and ``lab.conf``.
        ``LinkInUseError`` (409) while a running device is attached to it."""
        # Running-machine check decided *inside* the lock — same reasoning as add_machine/
        # connect_machine/disconnect_machine: a read taken before the lock could see "all stopped"
        # and then have a concurrent deploy_lab start a machine before this function's own critical
        # section runs.
        self._check_not_transitioning(lab_id)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_id)
            link = lab.get_link(link_name)

            # self._facade().undeploy_link(link) below is a silent no-op for a domain that still
            # has a running machine attached (DockerLink.undeploy filters out any network with
            # containers on it) — refuse up front instead of leaving the Docker network/veth alive
            # while the API and the in-memory model both claim the link is gone.
            running = sorted(m.name for m in link.machines.values() if m.api_object is not None)
            if running:
                raise LinkInUseError(
                    f"Collision domain `{link_name}` still has running machine(s) attached "
                    f"({', '.join(running)}); stop them (or the lab) before removing it."
                )

            # Only a domain whose network exists has one to remove: a draft on a stopped lab never
            # had one (add_link).
            if link.api_object is not None:
                self._facade().undeploy_link(link)
            self.registry.discard_draft(lab_id, link_name)

            # Every attached machine is stopped (checked above): persist the removal to lab.conf,
            # the same way disconnect_machine's stopped branch does for a single interface.
            machine_names = list(link.machines.keys())

            def edit(text: str) -> str:
                for machine_name in machine_names:
                    text = lab_conf_edit.remove_interface(text, machine_name, link_name)
                return text

            self._edit_lab_conf(lab_id, edit)

            # Keep the in-memory model consistent with the operation: drop all interfaces attached
            # to this collision domain, renumbering each device's survivors (a gap is an error for
            # both this project's parser and Kathara's own Machine.check), and remove the link from
            # the lab map so it no longer appears in topology/list views.
            for machine_name in machine_names:
                machine = lab.machines.get(machine_name)
                if machine is not None:
                    machine.remove_interface(link)
                    self._renumber_interfaces(machine)

            lab.links.pop(link_name, None)

    # -- exec -----------------------------------------------------------------

    def exec_command(
        self,
        lab_id: str,
        machine_name: str,
        command: Union[str, list[str]],
        wait: bool = False,
    ) -> tuple[bytes, bytes, int]:
        """Run ``command`` on a device through the facade; returns ``(stdout, stderr, exit_code)``. REST code
        paths pass ``wait=False``: ``wait=True`` blocks until the device's startup commands have finished."""
        return self._facade().exec(
            machine_name, command, lab_hash=lab_id, wait=wait, stream=False
        )

    # -- stats ----------------------------------------------------------------

    # Without a floor, a lab with nothing running lists its containers back to back: an empty
    # listing answers at once, so the stream would pin a CPU core and hammer the Docker daemon.
    # Once devices run, Docker's own stats stream already sends about one sample per second, so
    # the floor costs nothing in the deployed steady state.
    _MIN_STATS_INTERVAL_S = 1.0
    # How many devices' stats streams are opened side by side: the first sample of each blocks
    # for about a second, so opening them one after the other would delay a large lab's first
    # snapshot by that many seconds.
    _STATS_OPEN_CONCURRENCY = 8

    def machines_stats_stream(self, lab_id: str) -> Generator[list, None, None]:
        """Stream snapshots of the running devices' ``DockerMachineStats``, one list per sample.

        Reads each container's Docker stats stream itself rather than through Kathara's
        ``get_machines_stats``, for two reasons. A device whose container goes away between two
        listings (a device removed or undeployed while the stream is open) must only lose its own
        row: in Kathara's generator the ``NotFound`` from opening its stats ends the whole stream.
        And closing this generator closes every Docker stats stream it opened, which releases the
        underlying HTTP connections at once; Kathara's keeps them in a local it never closes.
        """
        # A plain (non-generator) function, deliberately: this must raise *synchronously*, when
        # the caller calls it, not lazily on first iteration. `routers/stats.py` wraps the
        # returned generator straight into an already-started `EventSourceResponse` — by the time
        # anything iterates it, a 200 has already gone out and a raised LabNotFoundError could no
        # longer become a 404. Checking here, before returning the inner generator, is what makes
        # an unknown lab id a clean 404 instead of a stream that opens fine and never emits.
        if self.registry.get(lab_id) is None and self._lab_dir(lab_id) is None:
            self.get_lab_or_reconstruct(lab_id)  # raises LabNotFoundError unless running under this id

        def _open(container: Container) -> Optional[DockerMachineStats]:
            try:
                return DockerMachineStats(container)
            except (DockerException, StopIteration) as exc:
                logger.debug("No stats for container %s: %s", container.name, exc)
                return None

        def _close(stats: DockerMachineStats) -> None:
            try:
                stats.stats.close()
            except Exception as exc:  # a stream that failed to close is still dropped
                logger.debug("Closing the stats stream of %s failed: %s", stats.container_name, exc)

        def _stream():
            open_stats: dict[str, DockerMachineStats] = {}  # by container id
            last_yield = 0.0
            try:
                while True:
                    containers = self._facade().get_machines_api_objects(lab_hash=lab_id)
                    listed = {container.id for container in containers}
                    for container_id in [cid for cid in open_stats if cid not in listed]:
                        _close(open_stats.pop(container_id))

                    fresh = [container for container in containers if container.id not in open_stats]
                    if fresh:
                        workers = min(len(fresh), self._STATS_OPEN_CONCURRENCY)
                        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="kathara-stats") as pool:
                            opened = list(pool.map(_open, fresh))
                        for container, stats in zip(fresh, opened):
                            if stats is not None:
                                open_stats[container.id] = stats

                    # Freshly opened ones already hold their first sample.
                    fresh_ids = {container.id for container in fresh}
                    for container_id, stats in list(open_stats.items()):
                        if container_id in fresh_ids:
                            continue
                        try:
                            stats.update()
                        except (DockerException, StopIteration) as exc:
                            logger.debug("Stats of %s ended: %s", stats.container_name, exc)
                            _close(open_stats.pop(container_id))

                    elapsed = time.monotonic() - last_yield
                    if elapsed < self._MIN_STATS_INTERVAL_S:
                        time.sleep(self._MIN_STATS_INTERVAL_S - elapsed)
                    last_yield = time.monotonic()
                    yield list(open_stats.values())
            finally:
                for stats in open_stats.values():
                    _close(stats)

        return _stream()


