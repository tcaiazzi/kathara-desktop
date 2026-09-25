"""Adapter that wraps the singleton Kathara facade for the REST API.

Design notes:
- The Kathara facade and ``Setting`` are process-wide singletons and Kathara is not safe for
  concurrent *independent* mutating calls, so state-changing operations on an existing lab are
  serialized behind a single re-entrant lock (``_mutate_lock``). Read-only operations (stats,
  exec, reconstruction) run concurrently.
- Lab *creation* is serialized per lab name instead (``_claiming_name``), not globally: its
  critical section contains the on-disk write, so holding the global lock across a large .zip
  extraction would stall unrelated labs. Both are needed — see ``_claiming_name``.
- All facade calls block; routers invoke these methods from FastAPI's threadpool (sync handlers)
  or via ``iterate_in_threadpool`` for streams.
- Most Kathara settings are read fresh at the point of use by the framework itself, so
  ``update_settings`` can change them at any time. ``manager_type`` is the one exception:
  ``Kathara.get_instance()`` picks the concrete manager class exactly once and Kathara has no
  supported way to swap it out afterward for the life of the process, so changing it once the
  facade has been instantiated is rejected rather than silently doing nothing.
"""

import io
import logging
import os
import posixpath
import shlex
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Callable, Generator, Optional, Union

import fs.copy
import fs.errors
import fs.path
from docker.errors import APIError
from Kathara.exceptions import (
    DockerDaemonConnectionError,
    HTTPConnectionError,
    InvocationError,
    LabNotFoundError,
    MachineNotFoundError,
    MachineNotRunningError,
    NotSupportedError,
)
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
    LabAlreadyRegisteredError,
    LabConfLockedError,
    LabRenameLockedError,
    LabTransitioningError,
    LinkInUseError,
    PathNotFoundError,
    SettingsLockedError,
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
)
from .docker_tty import SHELL_PATHS
from .lab_store import LabStore
from .registry import LabRegistry

logger = logging.getLogger("kathara_api")

# Reserved "machine name" for files/dirs queued directly under the lab root (no device) — the Lab
# Configuration tab's tree root. Structurally impossible for a real device to collide with: device
# names are validated against MACHINE_NAME_PATTERN (schemas/machine.py), which is lowercase-only.
ROOT_MACHINE = "ROOT"

# What Kathara's Docker manager calls itself — a `@staticmethod` returning this literal, so it holds
# whether or not a daemon is reachable. Named here because `system_info` reports it from two places
# (the active manager and the available-managers map) and they must not drift apart.
_DOCKER_MANAGER_LABEL = "Docker (Kathara)"


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


class KatharaService:
    """Thread-safe wrapper around ``Kathara.get_instance()``."""

    # How long a fetched Docker Hub image list stays valid before the next call re-fetches it.
    # DockerHubApi.get_tagged_images() has no caching of its own and fans out one HTTP request per
    # official image (~20-30) on every call — fine for the CLI's one-shot settings menu, too slow
    # and too chatty to redo on every "Add device"/options-editor open in a long-lived UI session.
    _IMAGES_CACHE_TTL = 300

    # How long a failed `Kathara.get_instance()` is remembered before the next call retries the
    # connection. Deliberately short: it exists so that opening the app costs *one* connection
    # attempt instead of one per read (see `_facade`), not to latch the process into an offline
    # mode. Anything longer would keep reporting a lab as not-running for that long after the
    # user starts Docker.
    _FACADE_FAILURE_TTL = 3.0

    def __init__(self, store: Optional[LabStore] = None) -> None:
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
        # Names of labs currently inside deploy_lab/undeploy_lab — see _check_not_transitioning.
        # A separate, always-uncontended lock, deliberately not `_mutate_lock`: deploy_lab holds
        # that one for the whole (potentially slow) facade call, so checking membership through it
        # would block the check itself for just as long, defeating the point of a fast-fail guard.
        self._transitioning: set[str] = set()
        self._transitioning_lock = threading.Lock()
        # One lock per lab *name*, held across the "is this name free?" check and the on-disk
        # write that claims it — see _claiming_name.
        self._name_locks: dict[str, threading.Lock] = {}
        self._name_locks_guard = threading.Lock()
        self.registry = LabRegistry()
        self.store = store if store is not None else LabStore(get_settings().labs_dir_path())
        # Repopulate the in-memory registry from any labs persisted on disk, so they survive a
        # restart. Safe at import time: builds model objects only (no facade/Docker), and reads
        # nothing if the storage root does not exist yet.
        self._reload_from_disk()

    # -- lifecycle / settings -------------------------------------------------

    def _begin_transition(self, name: str) -> None:
        with self._transitioning_lock:
            self._transitioning.add(name)

    def _end_transition(self, name: str) -> None:
        with self._transitioning_lock:
            self._transitioning.discard(name)

    def _assert_name_free(self, clean_name: str) -> None:
        """Refuse a lab name already taken, in the registry or merely on disk.

        Both halves matter: a directory can exist without a registry entry (a lab dropped into the
        labs dir by hand, or one whose lab.conf failed to parse at startup), and overwriting it
        would destroy work this process never knew about.

        Called under `_claiming_name` on every create path, and a second time *before* the lock on
        the two install paths — a cheap 409 that avoids a download or a copy that is about to be
        thrown away.
        """
        if self.registry.get(clean_name) is not None or self.store.lab_dir(clean_name).exists():
            raise LabAlreadyRegisteredError(f"Lab `{clean_name}` already exists.")

    @contextmanager
    def _claiming_name(self, name: str) -> Generator[None, None, None]:
        """Serialize everything that claims or releases the lab name ``name``.

        A creation path that checks ``registry.get(name) or lab_dir(name).exists()`` and only
        *then* writes, holding nothing in between, lets two concurrent creates of the same name
        both pass the check and both write — the loser's rollback then deletes the winner's
        freshly created directory, leaving the winner with its 201 and its registry entry and no
        files on disk. Every path that claims or releases a name holds this instead: the four
        creation paths (``create_lab``, ``upload_lab``, and ``install_example`` and
        ``install_gallery_lab`` through ``_install_from``), ``rename_lab`` for the name it moves to,
        and ``delete_lab`` — unregistering and removing the directory are what *release* a name, so
        they race a concurrent create of it.

        Deliberately *not* ``_mutate_lock``, which every other mutator uses: the critical section
        here contains the on-disk write itself — extracting a large .zip, ``copytree``-ing a
        bundled example — and serializing that globally would stall unrelated labs' deploys for
        its whole duration. A per-name lock serializes only the race that can actually corrupt
        anything: two operations fighting over one lab directory. Slow, name-independent I/O
        (a gallery download) stays outside, as ``install_gallery_lab`` documents.

        Entries are never removed from ``_name_locks``: an empty ``Lock`` per lab name the process
        has created is bounded and tiny, while removing one safely needs reference counting that
        would cost more complexity than it saves.
        """
        with self._name_locks_guard:
            lock = self._name_locks.setdefault(name, threading.Lock())
        with lock:
            yield

    def _check_not_transitioning(self, name: str) -> None:
        """Fail fast — without ever touching `_mutate_lock` — if `name` is mid deploy/undeploy.

        Must be the first thing a guarded method does, before it acquires `_mutate_lock` itself:
        calling this *after* taking that lock would just wait out the very hang it exists to
        avoid (deploy_lab/undeploy_lab hold `_mutate_lock` for their whole duration).
        """
        with self._transitioning_lock:
            busy = name in self._transitioning
        if busy:
            raise LabTransitioningError(f"Lab `{name}` is being deployed or undeployed. Try again once it finishes.")

    def _facade(self) -> Kathara:
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
        ``deployed`` and ``running`` are derived from it (``serializers._is_deployed`` /
        ``machine_to_detail``) — so a lab that was up before the daemon went away would keep
        claiming to be up. ``_clear_undeployed_state`` is the routine undeploy already uses for
        exactly this reason. On a freshly started process it changes nothing, because
        ``_reload_from_disk`` builds machines with no ``api_object`` to begin with.
        """
        self._clear_undeployed_state(lab, set(lab.machines))
        return lab

    def apply_startup_settings(self, settings: dict[str, Any]) -> None:
        """Apply settings before the facade is created (used at app startup)."""
        if settings:
            Setting.get_instance().load_from_dict(settings)

    # The subset of SettingsUpdate's fields that belong to this project's own ApiSettings
    # (config.py), not to Kathara's Setting/DockerSettingsAddon — update_settings/get_settings_view
    # route these to/from the ApiSettings singleton instead of Setting.load_from_dict/_to_dict.
    _API_SETTINGS_KEYS = frozenset({"max_files_per_lab", "max_bytes_per_file", "max_bytes_per_lab"})

    def update_settings(self, settings: dict[str, Any]) -> None:
        """Override settings at runtime.

        Every Kathara setting except ``manager_type`` is read fresh by the Kathara framework at
        the point of use, so it's safe to change any of them at any time. ``manager_type`` picks
        the concrete manager class exactly once, inside ``Kathara.get_instance()``'s constructor,
        and there's no supported way to swap it out afterward for the life of this process — so an
        actual change to it is rejected once the facade has been instantiated, rather than
        silently accepted but never taking effect.

        ``max_files_per_lab``/``max_bytes_per_file``/``max_bytes_per_lab`` (``_API_SETTINGS_KEYS``)
        aren't Kathara settings at all — they're this project's own ``ApiSettings`` (config.py),
        just exposed on the same page. They're set directly on the ``get_settings()``
        singleton, which every request already reads fresh (``main.py``'s body-size middleware,
        ``LabStore.extract_zip``), rather than passed to
        ``Setting.load_from_dict`` — which has no idea these attributes exist. This mutation is
        in-process only: it does not persist past a restart (see ``SettingsView``'s docstring).
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
                        "initialized for this backend session — restart the backend to switch "
                        "managers. Other settings can still be updated freely."
                    )
            if kathara_settings:
                Setting.get_instance().load_from_dict(kathara_settings)
            api_settings = get_settings()
            for key in self._API_SETTINGS_KEYS:
                if key in settings:
                    setattr(api_settings, key, settings[key])

    def get_settings_view(self) -> dict[str, Any]:
        setting = Setting.get_instance()
        # _to_dict() holds core settings; addons.merge() adds manager-specific ones.
        view = setting.addons.merge(setting._to_dict())
        api_settings = get_settings()
        view.update({key: getattr(api_settings, key) for key in self._API_SETTINGS_KEYS})
        return view

    def system_info(self) -> dict[str, Any]:
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
        """The Docker Hub half, cached in-process for ``_IMAGES_CACHE_TTL`` seconds.

        Only this half is cached: it is a ~20-request fan-out over the network, while
        ``list_local_images`` is a millisecond call to the local daemon that must stay fresh so
        an image the user just pulled shows up without waiting out a TTL.
        """
        with self._images_cache_lock:
            if self._images_cache is not None and time.monotonic() - self._images_cache_at < self._IMAGES_CACHE_TTL:
                # A copy, not the cached list itself: a caller that mutated it in place would
                # corrupt the cache for everyone else.
                return list(self._images_cache)
        try:
            images = docker_hub.list_tagged_images()
        except HTTPConnectionError:
            # Not cached, so the next call retries rather than latching the picker into a
            # Hub-less state for five minutes after a brief network blip.
            logger.debug("Could not list the official Kathara images from Docker Hub", exc_info=True)
            return []
        with self._images_cache_lock:
            self._images_cache = images
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
        `remote_url` is set — DockerManager.py:62-73), so a client we made ourselves would talk to
        a different daemon than the one the deploy uses. This reaches past the facade contract
        (`manager.client` / `manager.docker_image` are internals), which is why every use goes
        through this one accessor: an upstream refactor then breaks in one legible place instead of
        as scattered AttributeErrors.

        No non-Docker branch: this app only drives Docker (see `system_info`), and every caller of
        the image pre-check treats *any* failure as "carry on with the deploy" anyway.
        """
        return self._facade().manager

    def check_lab_images(self, lab_name: str) -> LabImagesStatus:
        """Classify a lab's device images so the UI can offer the download before deploying.

        Read-only, and deliberately outside `_mutate_lock` — same as every other read path on this
        router (see `routers/labs.get_lab`). Kathara resolves a device's image through
        `Machine.get_image()` (lab metadata -> device meta -> the global default), so that is what
        decides which images this reports.
        """
        lab = self.get_lab_or_reconstruct(lab_name)
        names = sorted({machine.get_image() for machine in lab.machines.values()})
        policy = getattr(Setting.get_instance(), "image_update_policy", "Prompt") or "Prompt"
        states = image_pull.classify_images(
            self._docker_manager().docker_image, names, check_updates=policy != "Never"
        )
        return LabImagesStatus(
            update_policy=policy,
            images=[LabImageStatus(name=name, state=state) for name, state in states.items()],
            missing=[name for name, state in states.items() if state == "missing"],
            outdated=[name for name, state in states.items() if state == "outdated"],
        )

    def pull_images(self, images: list[str]) -> list[str]:
        """Download exactly `images`, one at a time, publishing progress for the poll endpoint."""
        return image_pull.pull_images(self._docker_manager(), images)

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
                if any(m.api_object is not None for m in lab.machines.values()):
                    try:
                        self.undeploy_lab(lab.name)
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

    def _build_and_register(self, spec: LabCreate, lab_dir) -> Lab:
        """Build an OS-backed Lab rooted at ``lab_dir`` (which must already exist) and register it.

        Every lab is OS-backed (``Lab(path=lab_dir)``) rather than the in-memory ``mem://`` fs, so
        Kathara's own deploy machinery (``Machine.pack_data``) packs real files/startup scripts
        into containers over the Docker API.
        """
        lab = lab_builder.build_lab(spec, path=str(lab_dir))
        if not self.registry.add_if_absent(lab):
            raise LabAlreadyRegisteredError(f"Lab `{spec.name}` already exists.")
        return lab

    def _write_machine_files(
        self, lab: Lab, machine_name: str, files: dict[str, str], dirs: list[str]
    ) -> None:
        """Write an explicit files/dirs edit onto one machine's own on-disk folder.

        Only ever called with the caller's own payload, never a whole accumulated pending map —
        re-writing everything a machine has ever queued on every single edit would be wasteful and
        would keep touching files nothing asked to change.
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
        """Same as ``_write_machine_files``, but for files/dirs queued under the ROOT_MACHINE
        bucket (the Lab Configuration tab's tree root, no device) — written straight onto the
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

        Mirrors the normalized comparison the lab-root guard in `fs_delete_offline` already uses,
        and for the same reason its comment gives.
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
        if clean.endswith(".startup"):
            candidate = clean[: -len(".startup")]
            return candidate if lab.machines.get(candidate) is not None else None
        return None

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

    def _adopt_lab_dir(self, name: str, t: lab_import.LabImportTranslation) -> Lab:
        """Build + register a Lab against its already-populated on-disk directory.

        Writes nothing: by the time this runs, the directory *is* the lab (verbatim — see
        ``upload_lab``), so there is nothing left to materialize. Kathara's own
        ``Machine.pack_data`` reads a machine's files straight off ``machine.fs`` and its
        ``<name>.startup``/``shared.startup``/``shared.shutdown`` straight off ``lab.fs`` at
        deploy time — a machine whose subfolder already exists on disk picks up ``machine.fs``
        automatically (``Machine.__init__``), so nothing needs writing here for that to work.
        """
        return self._build_and_register(t.payload, self.store.lab_dir(name))

    def create_lab(self, spec: LabCreate) -> Lab:
        # `sanitize_lab_name` may strip whitespace (e.g. " demo " -> "demo"), and the lab
        # directory below is always created under that stripped form — every *import* path
        # already passes the same clean name through to the LabCreate it builds (see
        # lab_import.translate_lab_files' `lab_name` parameter), so this JSON path sanitizes too.
        # Keeping `spec.name` raw here would register a Lab carrying the untrimmed name while the
        # directory on disk used the trimmed one: GET/DELETE/etc by "demo" would 404 until the
        # next restart re-read the directory from disk and the lab silently renamed itself.
        clean_name = lab_store.sanitize_lab_name(spec.name)
        with self._claiming_name(clean_name):
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
                self.registry.remove(lab.name)
                self.store.delete_lab(lab.name)
                raise
            return lab

    def export_lab_zip(self, name: str) -> io.BytesIO:
        """Return an in-memory .zip of the lab's on-disk directory (raises 404 if unknown)."""
        return self.store.zip_lab(name)

    def read_lab_conf(self, name: str) -> LabConfView:
        """The lab's on-disk ``lab.conf``, verbatim — 404 only if the lab itself is unknown.

        Reads the file rather than re-serializing the model (``gen_lab_conf``), which is lossy:
        the editor must show exactly the bytes an import/upload/edit last wrote. A lab with no
        ``lab.conf`` on disk (reconstruct-only, or a folder-based import never yet edited) is
        reported as ``exists=False``, not a 404 — ``update_lab_conf`` (``PUT``) creates the file,
        so the editor can start from an empty buffer.
        """
        clean = lab_store.sanitize_lab_name(name)
        if self.registry.get(clean) is None and not self.store.lab_dir(clean).is_dir():
            self.get_lab_or_reconstruct(clean)  # raises LabNotFoundError unless running under this name
        text = self.store.read_lab_conf_text(clean)
        return LabConfView(content=text or "", exists=text is not None)

    def lab_location(self, name: str) -> Path:
        """Absolute host path of the lab's directory.

        Exists for the desktop shell (services/desktop), which needs a real host path to hand to
        the OS file manager and to a system terminal. The shell knows neither the storage root
        nor the name rules, so it asks rather than guessing; an unsafe name is rejected here,
        never resolved into a path that could escape the root.
        """
        clean = lab_store.sanitize_lab_name(name)
        lab_dir = self.store.lab_dir(clean)
        if not lab_dir.is_dir():
            self.get_lab_or_reconstruct(clean)  # raises LabNotFoundError if it isn't a known lab
        return lab_dir

    # -- fixed topology layout -------------------------------------------------

    def get_lab_layout(self, name: str) -> LabLayout:
        """The lab's fixed topology layout, or an empty one when it has none.

        A missing *layout* is deliberately not a 404: "this lab has no fixed layout" is the normal
        case, and an unparseable/hand-broken ``lab.layout`` is ignored the same way (see
        ``LabStore.read_layout``) rather than breaking the topology view. A missing *lab* is a 404
        like every other per-lab endpoint (``LabStore.read_layout`` raises ``LabNotFoundError``).
        """
        data = self.store.read_layout(name)
        if data is None:
            return LabLayout()
        try:
            return LabLayout.model_validate(data)
        except ValidationError:
            logger.warning("Ignoring invalid %s for lab `%s`", lab_store.LAYOUT_FILENAME, name, exc_info=True)
            return LabLayout()

    def save_lab_layout(self, name: str, layout: LabLayout) -> LabLayout:
        """Write the lab's fixed topology layout to ``lab.layout`` (404 if the lab has no directory)."""
        self.store.write_layout(name, layout.model_dump())
        return layout

    def clear_lab_layout(self, name: str) -> bool:
        """Delete the lab's ``lab.layout``; returns whether one existed."""
        return self.store.delete_layout(name)

    @staticmethod
    def _compact_interfaces(machine: Machine) -> None:
        """Drop ``None`` interface slots left by Kathara's ``Machine.remove_interface`` (it nulls a
        slot to preserve numbering). Those ``None`` slots crash a later ``update_lab_from_api``
        (``x.link`` on ``None``), so we compact after any disconnect/removal — an in-our-layer
        workaround for that upstream behavior (the sibling repo is left untouched)."""
        machine.interfaces = {num: iface for num, iface in machine.interfaces.items() if iface is not None}

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

    def _translate_lab_dir(self, name: str) -> Optional[lab_import.LabImportTranslation]:
        """Read a stored lab directory and parse it into a translation, or None if the directory is
        missing (reconstruct-only lab) or its lab.conf can't be parsed (logged)."""
        lab_dir = self.store.lab_dir(name)
        if not lab_dir.exists():
            return None
        files, _dirs = self.store.read_lab(lab_dir)
        t = lab_import.translate_lab_files(files, name)
        if t.errors:
            logger.warning("Cannot load lab `%s` from disk: %s", name, "; ".join(t.errors))
            return None
        return t

    def _config_lab_from_disk(self, name: str) -> Optional[Lab]:
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
        t = self._translate_lab_dir(name)
        if t is None:
            return None
        # path=None: in-memory fs — this Lab is only serialized back to lab.conf, never deployed,
        # so it must not touch (or contend for) the live lab's on-disk directory.
        return lab_builder.build_lab(t.payload)

    def _lab_conf_base_text(self, name: str) -> Optional[str]:
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
        lab_dir = self.store.lab_dir(name)
        if not lab_dir.is_dir():
            return None
        conf_path = self.store.lab_conf_path(name)
        if conf_path.is_file():
            text = self.store.read_lab_conf_text(name)
            if text is None:
                logger.warning("Not editing lab.conf for `%s`: it could not be read back", name)
                return None
            if lab_conf_edit.parse_errors(text):
                logger.warning("Not editing lab.conf for `%s`: the stored file does not parse", name)
                return None
            return text
        config_lab = self._config_lab_from_disk(name)
        return lab_store.gen_lab_conf(config_lab) if config_lab is not None else None

    def _edit_lab_conf(self, name: str, edit: Callable[[str], str]) -> None:
        """Apply a surgical, line-level edit to the stored ``lab.conf`` and write it back
        atomically.

        ``edit`` is a pure text -> text transform from ``lab_conf_edit``; it never sees a ``Lab``
        object, which is exactly why a running device's runtime interface changes can never leak
        into the saved configuration — the on-disk text *is* the configuration here, the live
        model is never consulted. Writing nothing when the edit is a no-op keeps mtimes stable.
        """
        base = self._lab_conf_base_text(name)
        if base is None:
            return
        new_text = edit(base)
        if new_text != base:
            self.store.write_lab_conf_text(name, new_text)

    def _reload_from_disk(self) -> None:
        """Rebuild the registry from the stored lab directories."""
        for name in self.store.lab_names():
            try:
                t = self._translate_lab_dir(name)
                if t is None:
                    continue
                # Re-associate the lab with its real, already-populated directory (machines whose
                # subfolder already exists on disk automatically pick up machine.fs — see
                # Kathara's Machine.__init__), so a redeployed/reloaded lab stays OS-backed.
                lab = lab_builder.build_lab(t.payload, path=str(self.store.lab_dir(name)))
                self.registry.add_if_absent(lab)
            except Exception:
                logger.warning("Failed to reload lab `%s` from disk", name, exc_info=True)

    def _reload_lab_from_disk(self, name: str) -> bool:
        """Rebuild a single lab's model from its on-disk lab.conf, *replacing* the registry entry.
        Used after a full undeploy to drop runtime-only model changes (e.g. interfaces added live)
        and restore the saved configuration topology. Returns False if the lab has no on-disk
        directory (reconstruct-only labs) or the stored lab.conf can't be parsed.

        Doesn't touch any device's actual files/dirs — those live only on the real on-disk fs
        (``lab.fs``/``machine.fs``), never mirrored into a separate in-memory structure, so there is
        nothing here that could go stale or be lost by rebuilding the model.
        """
        t = self._translate_lab_dir(name)
        if t is None:
            return False
        lab = lab_builder.build_lab(t.payload, path=str(self.store.lab_dir(name)))
        self.registry.add(lab)
        return True

    def _adopt_populated_dir(self, clean_name: str) -> tuple[Lab, list[str]]:
        """Parse an already-populated, on-disk lab directory and register it.

        Shared tail of ``upload_lab`` and ``install_example`` — they differ only in *how* the
        directory got populated (zip extraction vs. a verbatim copy of a bundled example), never
        in how the populated directory becomes a registered Lab. Rolls the directory back if
        parsing or registration fails, so neither caller has to: a half-populated directory must
        never outlive the request that created it.
        """
        lab_dir = self.store.lab_dir(clean_name)
        try:
            files, _dirs = self.store.read_lab(lab_dir)
            t = lab_import.translate_lab_files(files, clean_name)
            if t.errors:
                raise ApiError("; ".join(t.errors))
            lab = self._adopt_lab_dir(clean_name, t)
        except Exception:
            if self.registry.get(clean_name) is None:
                self.store.delete_lab(clean_name)  # roll back the populated directory
            raise
        return lab, t.warnings

    def upload_lab(self, name: str, zip_data: BinaryIO, deploy: bool = False) -> tuple[Lab, list[str]]:
        """Create (and optionally deploy) a lab from an uploaded .zip archive, verbatim.

        The archive is extracted to disk exactly as uploaded — comments, quoting, ``shared.startup``/
        ``shared.shutdown``, binaries and all — then parsed the same way as a JSON-described
        import. Machine subfolders that already exist on disk after extraction are picked up
        automatically as ``machine.fs`` (see ``Machine.__init__``), so any binary files travel to
        the deployed container via Kathara's native ``pack_data`` even though the pending-files
        model (which only round-trips text) can't represent them.
        """
        clean_name = lab_store.sanitize_lab_name(name)
        with self._claiming_name(clean_name):
            self._assert_name_free(clean_name)
            self.store.extract_zip(clean_name, zip_data)
            lab, warnings = self._adopt_populated_dir(clean_name)
        if deploy:
            lab = self.deploy_lab(clean_name)
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
        """Claim ``clean_name``, populate its directory, and adopt what landed there.

        The shared tail of both install paths; they differ only in ``populate`` (files written from
        a gallery download, or a bundled example copied). Anything slow that does *not* need the
        name — a gallery fetch — belongs before the call, not inside ``populate``.
        """
        with self._claiming_name(clean_name):
            # Re-checked inside the lock: the caller's pre-check may have run before a long
            # download, so by now another create may well have taken the name.
            self._assert_name_free(clean_name)
            populate()
            return self._adopt_populated_dir(clean_name)

    def install_gallery_lab(self, lab_id: str, name: Optional[str] = None) -> tuple[Lab, list[str]]:
        """Create a lab from an entry in the upstream Kathara-Labs gallery.

        Structurally identical to ``install_example`` — the only difference is *how* the lab
        directory gets populated (files downloaded over HTTP, instead of a local copy) — see
        ``_adopt_populated_dir``, which both share. The download happens before anything touches
        the labs directory and outside ``_mutate_lock``, so a slow or failing fetch never blocks
        other lab operations; only the 409 pre-check and the final on-disk write are serialized by
        going through ``store``/``registry`` the same way every other import does.
        """
        entry = lab_gallery.get_entry(lab_id)  # raises GalleryLabNotFoundError (404) if unknown
        clean_name = lab_store.sanitize_lab_name(name or entry.name)
        self._assert_name_free(clean_name)

        # Downloaded *before* `_install_from` takes the name lock, not inside it: a slow or failing
        # fetch must not hold a lock other operations on this name are waiting for.
        files = lab_gallery.download_lab_files(entry)
        return self._install_from(clean_name, lambda: self.store.write_lab(clean_name, files))

    def install_example(self, example_id: str, name: Optional[str] = None) -> tuple[Lab, list[str]]:
        """Create a lab from one of the bundled example network scenarios.

        Structurally identical to ``upload_lab`` — the only difference is *how* the lab
        directory gets populated (a verbatim copy of a bundled example, instead of a zip
        extraction) — see ``_adopt_populated_dir``, which both share. Installing is a create, not
        an upsert: an existing lab under the target name is a 409, exactly like upload_lab,
        so retrying an install never silently overwrites something the user changed.
        """
        clean_name = lab_store.sanitize_lab_name(name or example_id)
        self._assert_name_free(clean_name)

        source = examples.example_dir(example_id)  # raises ExampleNotFoundError (404) if unknown
        return self._install_from(clean_name, lambda: self.store.copy_lab_dir(clean_name, source))

    def update_lab_conf(self, name: str, content: str) -> Lab:
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
        clean = lab_store.sanitize_lab_name(name)
        self._check_not_transitioning(clean)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(clean)  # raises LabNotFoundError if unknown
            if any(m.api_object is not None for m in lab.machines.values()):
                raise LabConfLockedError(
                    f"Cannot edit lab.conf while `{clean}` is deployed. Undeploy it first."
                )
            lab_dir = self.store.ensure_lab_dir(clean)
            files, _dirs = self.store.read_lab(lab_dir)
            files["lab.conf"] = content
            t = lab_import.translate_lab_files(files, clean)
            if t.errors:
                raise ApiError("; ".join(t.errors))
            # Validate against a throwaway in-memory Lab (check_integrity, MAC format, meta
            # validation) *before* writing anything, so a bad submission never partially lands.
            lab_builder.build_lab(t.payload)
            # The only file this writes is lab.conf, verbatim — never store.write_lab(files, dirs),
            # which would rewrite every device file from read_lab's newline-normalized,
            # binary-stripped output.
            self.store.write_lab_conf_text(clean, content)
            # Rebuild under the same name, replacing the previous registration/model, from the
            # text just written.
            self.registry.remove(clean)
            new_lab = self._build_and_register(t.payload, lab_dir)
            return new_lab

    # -- offline lab filesystem (the Lab Configuration tab) --------------------
    #
    # Browses/edits the lab's own on-disk directory directly — lab.conf, every device's own
    # subdirectory, its <name>.startup, and anything else queued at the lab root (no separate
    # in-memory tracking of what's there; the filesystem itself is the only source of truth, so
    # a redeploy/undeploy/rename can never lose track of something a cache failed to reconstruct).
    # A write under a device's own path (or its <name>.startup) marks that device "dirty" — see
    # registry.mark_dirty — so a later redeploy of an already-running container knows to live-push
    # the change (deploy_lab's already-running branch, _live_push below).

    def get_startup_scripts(self, lab_name: str) -> dict[str, str]:
        """Each device's real ``<machine>.startup`` content (``""`` if it doesn't exist, or if it
        isn't valid UTF-8) — a fresh scan, not a cache. Backs the topology node-info panel's
        boot-time IP preview across all devices at once, so one device's corrupted/binary
        ``.startup`` must not blank out every other device's preview.
        """
        lab = self.get_lab_or_reconstruct(lab_name)
        result: dict[str, str] = {}
        for name in lab.machines:
            fname = f"{name}.startup"
            text = ""
            if lab.fs.exists(fname):
                try:
                    text = lab.fs.readtext(fname)
                except UnicodeDecodeError:
                    text = ""
            result[name] = text
        return result

    def fs_list_offline(self, lab_name: str, path: str) -> list[FsEntry]:
        """A directory listing straight off the real fs — no synthesized entries. A device with
        nothing on disk yet simply doesn't appear at the root, the same way an empty/nonexistent
        directory has no listing on a normal filesystem; it starts existing the moment something
        is written under it (`fs_write_text_offline`/`fs_mkdir_offline`/etc.), and stops existing
        again once its last real content is deleted (see `fs_delete_offline`)."""
        path = self._clean_offline_path(path)
        lab = self.get_lab_or_reconstruct(lab_name)
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

    def fs_search_offline(
        self, lab_name: str, path: str, query: str, case_sensitive: bool = False
    ) -> tuple[list[FsSearchMatch], bool]:
        """Search file contents under a directory in the lab's own on-disk tree. One
        PyFilesystem2 walk from a single resolved owner fs — when `path` resolves to the lab root
        (ROOT_MACHINE), that walk already reaches every device's on-disk files too, since
        `machine.fs` is just an `opendir()` view nested inside `lab.fs`'s own directory; no
        separate fan-out over `lab.machines` is needed."""
        path = self._clean_offline_path(path)
        lab = self.get_lab_or_reconstruct(lab_name)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)

        # Read once for the whole walk rather than per file: one search has to apply one threshold
        # to every file it considers, or a concurrent PUT /settings would make its results depend
        # on where in the tree the walk happened to be.
        max_file_size = get_settings().max_bytes_per_file
        matches: list[FsSearchMatch] = []
        truncated = False
        if target_fs is not None and target_fs.exists(guest):
            for file_path in target_fs.walk.files(path=guest):
                if len(matches) >= _SEARCH_MAX_TOTAL_MATCHES:
                    truncated = True
                    break
                try:
                    info = target_fs.getinfo(file_path, namespaces=["details"])
                    if info.size is not None and info.size > max_file_size:
                        continue
                    text = target_fs.readtext(file_path)
                except UnicodeDecodeError:
                    continue  # binary — same tolerance as every other offline text read
                except fs.errors.ResourceError:
                    continue  # vanished between walk() and readtext() — benign race

                remaining = _SEARCH_MAX_TOTAL_MATCHES - len(matches)
                file_matches, file_capped = _search_lines_in_text(
                    text, query, case_sensitive, min(_SEARCH_MAX_MATCHES_PER_FILE, remaining)
                )
                if file_capped:
                    truncated = True
                display_path = file_path if owner == ROOT_MACHINE else fs.path.join(f"/{owner}", file_path)
                matches.extend(
                    FsSearchMatch(path=display_path, line_number=lineno, line_text=text_)
                    for lineno, text_ in file_matches
                )
        elif guest != "/":
            raise PathNotFoundError(f"Path `{path}` not found.")
        return matches, truncated

    def _resolve_offline_file(self, lab_name: str, path: str):
        """Resolve a cleaned offline path to ``(fs, guest_path)`` for reading, or raise.

        404 for a path that is not there, 400 for a directory — the two answers both readers owe
        before they can differ about *how* they read the bytes.
        """
        lab = self.get_lab_or_reconstruct(lab_name)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)
        if target_fs is None or not target_fs.exists(guest):
            raise PathNotFoundError(f"Path `{path}` not found.")
        if target_fs.isdir(guest):
            raise ApiError(f"`{path}` is a directory. Use list to navigate it.")
        return target_fs, guest

    def fs_read_text_offline(self, lab_name: str, path: str) -> str:
        path = self._clean_offline_path(path)
        # Only the text read short-circuits lab.conf: it is the one whose content the API owns a
        # canonical copy of. A bytes read (a download) wants the file as it is on disk.
        if self._is_lab_conf(path):
            return self.read_lab_conf(lab_name).content
        target_fs, guest = self._resolve_offline_file(lab_name, path)
        try:
            return target_fs.readtext(guest)
        except UnicodeDecodeError as exc:
            raise BinaryFileError("File is not UTF-8 text. Use download for binary files.") from exc

    def fs_read_bytes_offline(self, lab_name: str, path: str) -> bytes:
        target_fs, guest = self._resolve_offline_file(lab_name, self._clean_offline_path(path))
        return target_fs.readbytes(guest)

    def fs_write_text_offline(self, lab_name: str, path: str, content: str) -> int:
        path = self._clean_offline_path(path)
        if self._is_lab_conf(path):
            # update_lab_conf does its own _check_not_transitioning.
            self.update_lab_conf(lab_name, content)
            return len(content.encode("utf-8"))
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            owner, guest = self._offline_fs_owner(lab, path)
            if owner == ROOT_MACHINE:
                self._write_lab_root_files(lab, {guest: content}, [])
            else:
                self._write_machine_files(lab, owner, {guest: content}, [])
            dirty = self._dirty_target_for(lab, path)
            if dirty:
                self.registry.mark_dirty(lab_name, dirty)
        return len(content.encode("utf-8"))

    def fs_upload_bytes_offline(self, lab_name: str, path: str, content: bytes) -> int:
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
            self.update_lab_conf(lab_name, text)
            return len(content)
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            owner, guest = self._offline_fs_owner(lab, path)
            target_fs = self._fs_for_write(lab, owner)
            parent = posixpath.dirname(guest)
            if parent and parent != "/":
                target_fs.makedirs(parent, recreate=True)
            target_fs.writebytes(guest, content)
            dirty = self._dirty_target_for(lab, path)
            if dirty:
                self.registry.mark_dirty(lab_name, dirty)
        return len(content)

    def fs_mkdir_offline(self, lab_name: str, path: str) -> None:
        path = self._clean_offline_path(path)
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            owner, guest = self._offline_fs_owner(lab, path)
            if owner == ROOT_MACHINE:
                self._write_lab_root_files(lab, {}, [guest])
            else:
                self._write_machine_files(lab, owner, {}, [guest])
            dirty = self._dirty_target_for(lab, path)
            if dirty:
                self.registry.mark_dirty(lab_name, dirty)

    def fs_delete_offline(self, lab_name: str, path: str, recursive: bool = False) -> None:
        path = self._clean_offline_path(path)
        if self._is_lab_conf(path):
            raise ApiError("lab.conf can't be deleted.")
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
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
                    lab.fs.removetree(owner)
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
                target_fs.removetree(guest)
            else:
                target_fs.remove(guest)
            dirty = self._dirty_target_for(lab, path)
            if dirty:
                self.registry.mark_dirty(lab_name, dirty)

    def _resolve_two_ended_offline_op(self, lab_name: str, source_path: str, destination_path: str):
        """Resolve both ends of a move or a copy to ``(lab, src_fs, src_guest, dst_fs, dst_guest)``.

        Must be called while holding ``_mutate_lock``: the callers' own work continues under it.

        What deliberately stays with the callers is the ``lab.conf`` guard, because the two do not
        agree on it — a move refuses lab.conf at *either* end, a copy only refuses overwriting it —
        and the divergent tail: a move needs a same-fs/cross-fs split and marks both paths dirty,
        a copy needs neither.
        """
        lab = self.get_lab_or_reconstruct(lab_name)
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

    def fs_move_offline(self, lab_name: str, source_path: str, destination_path: str) -> None:
        source_path = self._clean_offline_path(source_path)
        destination_path = self._clean_offline_path(destination_path)
        if self._is_lab_conf(source_path) or self._is_lab_conf(destination_path):
            raise ApiError("lab.conf can't be moved.")
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab, src_fs, source_guest, dst_fs, dest_guest = self._resolve_two_ended_offline_op(
                lab_name, source_path, destination_path
            )

            is_dir = src_fs.isdir(source_guest)
            same_fs = src_fs is dst_fs
            if is_dir:
                if same_fs:
                    src_fs.movedir(source_guest, dest_guest, create=True)
                else:
                    dst_fs.makedirs(dest_guest, recreate=True)
                    fs.copy.copy_dir(src_fs, source_guest, dst_fs, dest_guest)
                    src_fs.removetree(source_guest)
            else:
                if same_fs:
                    src_fs.move(source_guest, dest_guest, overwrite=True)
                else:
                    fs.copy.copy_file(src_fs, source_guest, dst_fs, dest_guest)
                    src_fs.remove(source_guest)

            for p in (source_path, destination_path):
                dirty = self._dirty_target_for(lab, p)
                if dirty:
                    self.registry.mark_dirty(lab_name, dirty)

    def fs_copy_offline(self, lab_name: str, source_path: str, destination_path: str) -> None:
        source_path = self._clean_offline_path(source_path)
        destination_path = self._clean_offline_path(destination_path)
        if self._is_lab_conf(destination_path):
            raise ApiError("lab.conf can't be replaced by copy — edit it directly.")
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab, src_fs, source_guest, dst_fs, dest_guest = self._resolve_two_ended_offline_op(
                lab_name, source_path, destination_path
            )

            # No same-fs/cross-fs split like fs_move_offline needs: fs.copy.copy_dir/copy_file
            # work identically either way, and unlike move there is no source to remove.
            if src_fs.isdir(source_guest):
                dst_fs.makedirs(dest_guest, recreate=True)
                fs.copy.copy_dir(src_fs, source_guest, dst_fs, dest_guest)
            else:
                fs.copy.copy_file(src_fs, source_guest, dst_fs, dest_guest)

            dirty = self._dirty_target_for(lab, destination_path)
            if dirty:
                self.registry.mark_dirty(lab_name, dirty)

    def get_lab_or_reconstruct(self, name: str) -> Lab:
        """Return the registered Lab (refreshed from the backend) or reconstruct it.

        Raises LabNotFoundError if the lab is neither registered nor running.
        """
        lab = self.registry.get(name)
        if lab is not None:
            facade = self._facade_or_offline()
            if facade is None:
                # Docker is unreachable: the registered model came from disk and is the whole
                # answer, minus the live overlay. See _facade_or_offline/_offline_lab_state.
                return self._offline_lab_state(lab)
            try:
                facade.update_lab_from_api(lab)
            except LabNotFoundError:
                # Some managers raise when nothing is running under this name; the Docker manager
                # instead enriches with whatever containers exist (none) and never raises. Either
                # way, keep the registered (config) model as-is.
                pass
            return lab

        # Not registered: try to rebuild from the running backend state. Nothing to fall back on
        # here — an unregistered lab exists only as running containers, so with no daemon to ask
        # there is genuinely no such lab, which is the same 404 as "nothing is running under it".
        facade = self._facade_or_offline()
        if facade is None:
            raise LabNotFoundError(f"Lab `{name}` not found.")
        try:
            reconstructed = facade.get_lab_from_api(lab_name=name)
        except LabNotFoundError as exc:
            raise LabNotFoundError(f"Lab `{name}` not found.") from exc

        # get_lab_from_api returns an empty Lab when nothing is running under that name.
        if not reconstructed.machines:
            raise LabNotFoundError(f"Lab `{name}` not found.")
        return reconstructed

    def list_labs(self) -> list[Lab]:
        labs = self.registry.all()
        facade = self._facade_or_offline()
        if facade is None:
            # Docker unreachable: still list every lab on disk, just with nothing marked running.
            return [self._offline_lab_state(lab) for lab in labs]
        for lab in labs:
            try:
                facade.update_lab_from_api(lab)
            except LabNotFoundError:
                pass
        return labs

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
        name: str,
        selected_machines: Optional[set[str]] = None,
        excluded_machines: Optional[set[str]] = None,
    ) -> Lab:
        # Self-checked exactly like every other guarded mutator — without this, two
        # concurrent deploy_lab calls on the same lab both pass _begin_transition (a set add, not
        # a lock) and run concurrently, each computing its own fresh/already-running split from a
        # Lab object the other is mutating at the same time, colliding inside the facade call on
        # MachineAlreadyExistsError. Must run before _begin_transition, same reasoning as every
        # other call site: checking after taking _mutate_lock below would just wait out the hang
        # this exists to avoid.
        self._check_not_transitioning(name)
        # Marked as transitioning for the whole call, not just the facade section below — a
        # lab.conf edit/offline-fs write/structural change arriving anywhere in this window should
        # fail fast via _check_not_transitioning rather than queue up behind _mutate_lock.
        self._begin_transition(name)
        try:
            # The entire body, not just the facade call: reading `lab`/computing the fresh vs
            # already-running split is itself a read of shared model state (`lab.machines`,
            # `machine.api_object`) that another mutator could otherwise change mid-computation —
            # mirrors undeploy_lab, which already locks its whole body for the same reason.
            with self._mutate_lock:
                if selected_machines and excluded_machines:
                    raise InvocationError("You can either select or exclude devices.")

                lab = self.get_lab_or_reconstruct(name)
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
                    self._facade().deploy_lab(lab, selected_machines=fresh_names)
                    # Native pack_data just packed each fresh machine's *current* on-disk state,
                    # so any dirty flag an offline edit set before this deploy is already
                    # reflected — discard it rather than leaving it to trigger a spurious
                    # live-push on some future redeploy.
                    self.registry.pop_dirty_machines(name, fresh_names)

                dirty = self.registry.pop_dirty_machines(name, already_running)
                if dirty:
                    self._live_push(name, lab, dirty)
                return lab
        finally:
            self._end_transition(name)

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

    def _live_push(self, name: str, lab: Lab, target_names: set[str]) -> None:
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
                dirs = list(machine.fs.walk.dirs())
                if dirs:
                    quoted = " ".join(shlex.quote(d) for d in dirs)
                    self._exec_checked(name, machine_name, f"mkdir -p {quoted}", action_label="mkdir")
                for file_path in machine.fs.walk.files():
                    try:
                        files[file_path] = machine.fs.readtext(file_path)
                    except UnicodeDecodeError:
                        continue  # binary — this live-push path is text-only

            boot_script = self._boot_script(lab, machine)
            has_startup = bool(boot_script.strip())
            if has_startup:
                files["/tmp/.kathara_boot.sh"] = boot_script
            if files:
                self.copy_files(name, machine_name, files)
            if has_startup:
                self.exec_command(name, machine_name, "sh /tmp/.kathara_boot.sh", wait=False)

    def undeploy_lab(
        self,
        name: str,
        selected_machines: Optional[set[str]] = None,
        excluded_machines: Optional[set[str]] = None,
        selected_links: Optional[set[str]] = None,
    ) -> None:
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
        # concurrent undeploy_lab on the same name doesn't fail fast, it just queues up behind
        # _mutate_lock and then runs the facade call a second time against a lab already brought
        # down by the first — a confusing lower-level error instead of a clean "try again".
        self._check_not_transitioning(name)
        self._begin_transition(name)
        try:
            with self._mutate_lock:
                lab = self.registry.get(name)
                if lab is None and not self.store.lab_dir(name).is_dir():
                    raise LabNotFoundError(f"Lab `{name}` not found.")
                self._facade().undeploy_lab(
                    lab_name=name,
                    selected_machines=selected_machines,
                    excluded_machines=excluded_machines,
                    selected_links=selected_links,
                )
                if lab is not None:
                    machine_names = self._resolve_targets(set(lab.machines.keys()), selected_machines, excluded_machines)
                    self._clear_undeployed_state(lab, machine_names, selected_links)

                # A full undeploy brings the whole lab down, so restore the topology to the saved
                # configuration (lab.conf) — discarding any runtime-only model changes such as
                # interfaces added/removed live. Skipped for a partial undeploy, which must not
                # disturb the machines left running (and their live state).
                full_undeploy = selected_machines is None and excluded_machines is None and selected_links is None
                if full_undeploy:
                    self._reload_lab_from_disk(name)
        finally:
            self._end_transition(name)

    def rename_lab(self, name: str, new_name: str) -> Lab:
        """Rename a **non-deployed** lab (its directory, and its key in the registry).

        A lab's name is its directory name and the identity Kathara derives container/network names
        from, so this is rejected with 409 while the lab is deployed — undeploy first. Nothing
        inside the lab is rewritten: ``lab.conf`` is not regenerated (the name never appears in it —
        a ``LAB_NAME`` key is dropped at import time), and device files/startup scripts/``lab.layout``
        travel with the directory.

        The model is rebuilt from the moved directory (``_reload_lab_from_disk``) rather than
        mutating ``lab.name`` in place, so the ``Lab`` — and every machine's ``fs`` — is re-anchored
        on the new path, and the pending-files state is re-read under the new key.
        """
        clean = lab_store.sanitize_lab_name(name)
        clean_new = lab_store.sanitize_lab_name(new_name)
        self._check_not_transitioning(clean)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(clean)  # raises LabNotFoundError if unknown
            if clean_new == clean:
                return lab
            if any(m.api_object is not None for m in lab.machines.values()):
                raise LabRenameLockedError(
                    f"Cannot rename `{clean}` while it is deployed. Undeploy it first."
                )
            # The destination name is claimed the same way a create claims it — otherwise this
            # check-then-move races an import of `clean_new` exactly as two unguarded creates race
            # each other. Acquired *after* `_mutate_lock`, never before: creates take
            # `_claiming_name` alone and never reach for `_mutate_lock` while holding it, so this
            # ordering cannot close a cycle.
            with self._claiming_name(clean_new):
                self._assert_name_free(clean_new)
                self.store.rename_lab(clean, clean_new)
                try:
                    if not self._reload_lab_from_disk(clean_new):
                        raise ApiError(f"Lab `{clean}` could not be reloaded after renaming.")
                except Exception:
                    self.store.rename_lab(clean_new, clean)  # roll the directory back
                    raise
                self.registry.remove(clean)
                return self.registry.get(clean_new)

    def delete_lab(self, name: str) -> None:
        self._check_not_transitioning(name)
        with self._mutate_lock:
            if self.registry.get(name) is None and not self.store.lab_dir(name).is_dir():
                raise LabNotFoundError(f"Lab `{name}` not found.")
            try:
                self._facade().undeploy_lab(lab_name=name)
            except DockerDaemonConnectionError:
                # A lab's directory is plain disk I/O and needs no daemon to remove — and with no
                # daemon reachable, there is nothing that could still be running to undeploy first.
                # Any other failure here (the daemon *is* up but the undeploy itself fails) must
                # keep propagating: deleting the directory out from under live containers is worse
                # than leaving the lab undeleted.
                logger.warning("Docker daemon unreachable while deleting lab `%s`; skipping undeploy", name)
        # Claimed like a create does: unregistering and removing the directory are what *release*
        # the name, and without the lock they can land in the middle of a concurrent import of the
        # same name — deleting the directory that import had just written.
        with self._claiming_name(lab_store.sanitize_lab_name(name)):
            self.registry.remove(name)
            self.store.delete_lab(name)

    # -- machines -------------------------------------------------------------

    def get_machine_api_object(self, lab_name: str, machine_name: str):
        """Return backend-native API object for a running machine.

        Used by features that require manager-specific low-level capabilities
        (for example interactive TTY websocket bridging on Docker).
        """
        self._get_running_machine(lab_name, machine_name)
        getter = getattr(self._facade(), "get_machine_api_object", None)
        if not callable(getter):
            raise NotSupportedError("Live TTY is not supported by the current Kathara manager.")
        return getter(machine_name, lab_name=lab_name)

    def available_shells(self, lab_name: str, machine_name: str) -> list[str]:
        """Return the supported shells actually present (executable) in the *running* device, in
        canonical order — used to populate the live-terminal shell picker. Falls back to the full
        supported set if the device can't be probed."""
        self._get_running_machine(lab_name, machine_name)  # 409 if the device isn't running
        # One probe: echo the name of each known shell whose resolved binary is executable — the same
        # path the live-TTY session would exec (see docker_tty.resolve_shell_path).
        probe = "".join(f"[ -x {path} ] && echo {name}\n" for name, path in SHELL_PATHS.items())
        try:
            stdout, _, _ = self.exec_command(lab_name, machine_name, ["sh", "-lc", probe], wait=False)
        except Exception:
            stdout = None
        found = {ln.strip() for ln in (stdout or b"").decode("utf-8", "replace").splitlines() if ln.strip()}
        available = [name for name in SHELL_PATHS if name in found]
        return available or list(SHELL_PATHS)

    def add_machine(self, lab_name: str, spec: MachineCreate) -> Machine:
        # Adding a device is a *configuration* edit, so it's appended to lab.conf (unlike runtime
        # interface changes, which stay live-only). It is deployed live only when the lab is already
        # running — mirroring interface edits (config on a stopped lab, runtime on a live one).
        #
        # `lab`/`lab_deployed` are (re)read *inside* the lock, not before it — matching
        # update_machine/update_lab_conf/rename_lab. Reading them outside the lock would let a
        # concurrent deploy_lab/undeploy_lab run first: a stale `lab_deployed=False` would skip
        # deploying a device on a lab that's actually now running, and a stale `lab` object could be
        # an orphan the registry no longer tracks (undeploy_lab replaces it via _reload_lab_from_disk).
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            lab_deployed = any(m.api_object is not None for m in lab.machines.values())
            # Render + validate the lab.conf block *before* creating or deploying anything, so a
            # spec that can't be represented (name clash, interface-number gap) fails with no side
            # effects instead of leaving a device behind or an unloadable file on disk.
            base = self._lab_conf_base_text(lab_name)
            new_conf = lab_conf_edit.add_device(base, spec) if base is not None else None
            machine = lab_builder.build_machine(lab, spec)
            if lab_deployed:
                try:
                    self._facade().deploy_machine(machine)
                except Exception:
                    # Take the device back out of the model. Without this, a failed deploy leaves a
                    # device that exists in the topology but in neither lab.conf (not written yet,
                    # see below) nor the backend — and it would keep reappearing until the lab is
                    # reloaded from disk. Nothing on disk to clean up: build_machine only builds
                    # the model, and `machine.fs` is non-None only for a folder that already
                    # existed (Machine.__init__), which is not ours to delete.
                    self._compact_interfaces(machine)
                    lab.remove_machine(name=spec.name, delete_fs=False)
                    raise
            if new_conf is not None:
                self.store.write_lab_conf_text(lab_name, new_conf)
        return machine

    def update_machine(self, lab_name: str, machine_name: str, spec: MachineUpdate) -> Machine:
        """Replace a stopped device's full option set (image/mem/.../volumes) from ``spec``.

        This is a configuration edit, not a runtime one — rejected with 409 while the lab is
        deployed (mirroring ``update_lab_conf``'s gate exactly), unlike ``add_machine``, which is
        allowed to also deploy live. There is no live-redeploy path here: editing options only
        ever takes effect from the lab's next deploy.
        """
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            if any(m.api_object is not None for m in lab.machines.values()):
                raise LabConfLockedError(
                    f"Cannot edit device options while `{lab_name}` is deployed. Undeploy it first."
                )
            machine = lab.get_machine(machine_name)  # raises MachineNotFoundError
            # Render + validate the lab.conf edit *before* mutating the live model, so a spec that
            # can't be represented fails with no side effects (mirrors add_machine's ordering).
            base = self._lab_conf_base_text(lab_name)
            new_conf = lab_conf_edit.replace_device_options(base, machine_name, spec) if base is not None else None
            lab_builder.apply_options(machine, spec)
            if new_conf is not None:
                self.store.write_lab_conf_text(lab_name, new_conf)
            return machine

    def remove_machine(self, lab_name: str, machine_name: str, keep_links: bool = False) -> None:
        # `lab`/`machine` are (re)read *inside* the lock — see add_machine's comment on why reading
        # them beforehand would let a concurrent deploy_lab/undeploy_lab run first and act on
        # stale state (e.g. a `machine` whose interfaces changed since, or a `lab` the registry
        # already replaced).
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            machine = lab.get_machine(machine_name)
            link_names = {iface.link.name for iface in machine.interfaces.values() if iface is not None}
            self._facade().undeploy_machine(machine, keep_links=keep_links)
            # link_names=None means "check every link in the lab" to _clear_undeployed_state, so a
            # kept link set must be the empty set (not None) to mean "check none of them".
            self._clear_undeployed_state(lab, {machine_name}, set() if keep_links else link_names)
            # The facade only undeploys — it leaves the device in the model, where it would keep
            # reappearing in the topology/devices forever. Drop it from the Lab too (and its
            # on-disk files).
            # Guard against None interface slots (a known upstream disconnect bug can leave them, and
            # Lab.remove_machine dereferences interface.link without a None check).
            self._compact_interfaces(machine)
            # delete_fs=False: Kathara's own delete_fs uses removedir(), which fails on a non-empty
            # device folder — clean the fs ourselves recursively (see _remove_machine_fs).
            lab.remove_machine(name=machine_name, delete_fs=False)
            self._remove_machine_fs(lab, machine_name)
            # Drop the device's lines from the persisted lab.conf — every other line in the file
            # (comments, other devices, unmodelled options) stays byte-identical.
            self._edit_lab_conf(lab_name, lambda text: lab_conf_edit.remove_device(text, machine_name))

    @staticmethod
    def _remove_machine_fs(lab: Lab, machine_name: str) -> None:
        """Recursively delete a device's on-disk files: its ``<name>.startup``/``.shutdown`` scripts
        and its ``<name>/`` folder (Kathara's own ``delete_fs`` can't — it uses ``removedir``, which
        fails on a non-empty folder)."""
        for fname in (f"{machine_name}.startup", f"{machine_name}.shutdown"):
            if lab.fs.exists(fname):
                lab.fs.remove(fname)
        if lab.fs.exists(machine_name):
            lab.fs.removetree(machine_name)

    def connect_machine(
        self,
        lab_name: str,
        machine_name: str,
        link_name: str,
        interface_number: Optional[int] = None,
        mac_address: Optional[str] = None,
    ) -> Machine:
        # `lab`/`machine`/`link`, and — critically — the running-vs-stopped branch below, are all
        # decided *inside* the lock (see add_machine's comment on why). Deciding the branch from a
        # `machine.api_object` read taken before the lock could see "stopped" and then have a
        # concurrent deploy_lab start the device before this function's own critical section runs:
        # the interface would be written to lab.conf instead of connected live, silently invisible
        # to the now-running container.
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            machine = lab.get_machine(machine_name)
            link = lab.get_or_new_link(link_name)

            # For stopped devices, update the topology model directly so interfaces can be
            # prepared before deploy (supports explicit interface numbering). This is a "static"
            # edit — persist it to lab.conf so it survives a reload / is applied on the next deploy.
            if machine.api_object is None:
                # Resolve the interface number against the *on-disk* configuration — the same
                # source the text edit itself reads — and hand the resolved number to the live
                # model too, so lab.conf and the model can never disagree about eth numbering.
                base = self._lab_conf_base_text(lab_name)
                number = interface_number
                new_conf = None
                if base is not None:
                    if number is None:
                        number = lab_conf_edit.next_interface_number(base, machine_name)
                    new_conf = lab_conf_edit.add_interface(base, machine_name, number, link_name, mac_address)
                machine.add_interface(link, number=number, mac_address=mac_address)
                if new_conf is not None:
                    self.store.write_lab_conf_text(lab_name, new_conf)
                return machine

            if interface_number is not None:
                raise NotSupportedError(
                    "Explicit interface_number is only supported when the device is not running."
                )

            # Kathara starts a device with no interfaces in Docker's `none` network mode, and Docker
            # refuses to attach any network to such a container. Checked here because Kathara's own
            # connect adds the interface to the model and creates the collision domain before
            # Docker refuses, leaving a phantom interface behind an unreadable daemon error.
            if self._started_without_network(machine):
                raise NotSupportedError(
                    f"Device `{machine_name}` was started without any interface, so its Docker "
                    "container was created with networking disabled. So it cannot be connected to any" \
                    " link at runtime. Stop the lab, connect the device, then start the lab again."
                )

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
        self, lab_name: str, machine_name: str, link_name: str, keep_link: bool = False
    ) -> None:
        # `lab`/`machine`/`link` and the running-vs-stopped branch are all decided *inside* the
        # lock — same reasoning as connect_machine above (and add_machine's comment): deciding it
        # from a read taken before the lock risks acting on a device whose running state has
        # since changed under a concurrent deploy_lab/undeploy_lab.
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            machine = lab.get_machine(machine_name)
            link = lab.get_link(link_name)

            # For stopped devices, update the topology model only (a "static" lab.conf edit) and
            # persist.
            if machine.api_object is None:
                # Remove the interface line and renumber the device's higher interfaces: a gap is
                # an error for both this project's parser and Kathara's own Machine.check, so a
                # bare line delete would leave a lab.conf that can no longer be loaded or deployed.
                self._edit_lab_conf(
                    lab_name, lambda text: lab_conf_edit.remove_interface(text, machine_name, link_name)
                )
                machine.remove_interface(link)
                self._renumber_interfaces(machine)
                return

            # Running device: live disconnect. Compact the None slot Kathara leaves behind so
            # subsequent reads don't crash (runtime change — not persisted to lab.conf).
            self._facade().disconnect_machine_from_link(machine, link, keep_link=keep_link)
            self._compact_interfaces(machine)

    def copy_files(self, lab_name: str, machine_name: str, files: dict[str, str]) -> None:
        guest_to_host = {path: io.BytesIO(content.encode("utf-8")) for path, content in files.items()}
        # `_get_running_machine` (lab/machine lookup + the running check) belongs inside the lock:
        # checked outside it, a concurrent undeploy_lab/remove_machine could stop the device
        # between the check and the copy, so `self._facade().copy_files` would run against a
        # machine whose `api_object` this call never actually confirmed was still live.
        with self._mutate_lock:
            machine = self._get_running_machine(lab_name, machine_name)
            self._facade().copy_files(machine, guest_to_host)

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

    def _get_running_machine(self, lab_name: str, machine_name: str) -> Machine:
        lab = self.get_lab_or_reconstruct(lab_name)
        machine = lab.get_machine(machine_name)
        if machine.api_object is None:
            # MachineNotRunningError formats its own "Device `<name>` is not running." message.
            raise MachineNotRunningError(machine_name)
        return machine

    def _running_guest_path(self, lab_name: str, machine_name: str, path: str) -> tuple[Machine, str]:
        """Assert the device is running and return ``(machine, normalized_guest_path)`` — the common
        preamble of every ``fs_*`` runtime-filesystem method."""
        machine = self._get_running_machine(lab_name, machine_name)
        return machine, self.normalize_guest_path(path)

    def _exec_checked(
        self,
        lab_name: str,
        machine_name: str,
        command: Union[str, list[str]],
        *,
        wait: bool = True,
        action_label: str,
    ) -> tuple[bytes, bytes]:
        stdout, stderr, exit_code = self.exec_command(lab_name, machine_name, command, wait=wait)
        # Some backends can return None for empty streams; normalize so callers can decode safely.
        stdout = stdout if stdout is not None else b""
        stderr = stderr if stderr is not None else b""
        if exit_code != 0:
            err = stderr.decode("utf-8", errors="replace").strip()
            raise ApiError(f"{action_label} failed on `{machine_name}`: {err or f'exit code {exit_code}'}")
        return stdout, stderr

    def fs_list_directory(self, lab_name: str, machine_name: str, path: str) -> list[FsEntry]:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        quoted = shlex.quote(normalized)
        # `-H` dereferences `path` itself when it's a symlink (e.g. Debian/Ubuntu's merged-usr
        # `/bin -> usr/bin`) without following symlinks encountered among the listed children —
        # plain `find` (`-P`) treats a symlinked `path` as a leaf at depth 0, so with `-mindepth 1`
        # excluding that depth-0 node, listing a symlinked directory silently returns zero entries.
        #
        # The name goes last and each entry ends in NUL, the one byte a filename cannot contain: a
        # name may hold tabs or newlines, but the five fields before it never do, so splitting on
        # the first five tabs always leaves the name whole.
        cmd = f"find -H {quoted} -mindepth 1 -maxdepth 1 -printf '%y\\t%Y\\t%s\\t%m\\t%T@\\t%f\\0'"
        stdout, _ = self._exec_checked(
            lab_name,
            machine_name,
            ["sh", "-lc", cmd],
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
                    mode=mode,
                    mtime=mtime,
                )
            )
        # Same order as the offline tree and the host browser — directories first, then
        # case-insensitive by name — rather than whatever `find` happened to emit.
        return sorted(entries, key=lambda e: (not e.is_dir, e.name.lower()))

    # Exit code used to signal "path is a directory" from the combined test+cat below — distinct
    # from `cat`'s own exit codes (1 on error) and from a shell's own low-numbered exit codes.
    _FS_READ_IS_DIR_EXIT = 90

    def fs_read_bytes(self, lab_name: str, machine_name: str, path: str) -> bytes:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        quoted = shlex.quote(normalized)
        # A single exec instead of a `test -d` probe followed by a separate `cat` — halves the
        # docker-exec round trips for every Runtime FS file open.
        cmd = f"[ -d {quoted} ] && exit {self._FS_READ_IS_DIR_EXIT}; cat {quoted}"
        stdout, stderr, exit_code = self.exec_command(lab_name, machine_name, ["sh", "-lc", cmd], wait=False)
        if exit_code == self._FS_READ_IS_DIR_EXIT:
            raise ApiError(f"Path `{normalized}` is a directory. Use list to navigate it.")
        if exit_code != 0:
            err = (stderr or b"").decode("utf-8", errors="replace").strip()
            raise ApiError(f"Read file `{normalized}` failed: {err or f'exit code {exit_code}'}")
        return stdout or b""

    def fs_read_text(self, lab_name: str, machine_name: str, path: str) -> str:
        raw = self.fs_read_bytes(lab_name, machine_name, path)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise BinaryFileError("File is not UTF-8 text. Use download for binary files.") from exc

    def get_startup_log(self, lab_name: str, machine_name: str) -> str:
        """The device's boot-time startup log: `/var/log/startup.log`, the redirected stdout+stderr
        of its `.startup` script followed by its lab.conf `exec_commands` (see Kathara's
        `DockerMachine.STARTUP_COMMANDS`). The file doesn't exist until the device actually has a
        `.startup` script to run — treated as "no log yet" (empty string) rather than an error,
        since polling this while a device is still booting is the whole point.
        """
        self._get_running_machine(lab_name, machine_name)
        stdout, _, exit_code = self.exec_command(lab_name, machine_name, ["cat", "/var/log/startup.log"], wait=False)
        if exit_code != 0:
            return ""
        return (stdout or b"").decode("utf-8", errors="replace")

    def is_startup_finished(self, lab_name: str, machine_name: str) -> bool:
        """Whether the device's startup commands (`.startup` script + `exec_commands`) have finished
        executing — mirrors Kathara's own internal check (`DockerMachine._wait_startup_execution`):
        the very last of its startup commands is `touch /tmp/EOS`, so the marker's existence is the
        signal. Must call `exec_command` with `wait=False` here — `wait=True` would itself block on
        this same condition via Kathara's blocking wait, defeating the point of polling for it.
        """
        self._get_running_machine(lab_name, machine_name)
        _, _, exit_code = self.exec_command(lab_name, machine_name, ["test", "-f", "/tmp/EOS"], wait=False)
        return exit_code == 0

    def fs_write_text(self, lab_name: str, machine_name: str, path: str, content: str) -> int:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        self.copy_files(lab_name, machine_name, {normalized: content})
        return len(content.encode("utf-8"))

    def fs_upload_bytes(self, lab_name: str, machine_name: str, path: str, content: bytes) -> int:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        # Re-resolved inside the lock, for the reason `copy_files` spells out: the check above is
        # the same early 409 every other fs_* method gives, not the one the copy can rely on. The
        # binary twin of `fs_write_text`, which gets this shape for free by delegating to
        # `copy_files` — not reusable here, since that method encodes its values as UTF-8 text.
        with self._mutate_lock:
            machine = self._get_running_machine(lab_name, machine_name)
            self._facade().copy_files(machine, {normalized: io.BytesIO(content)})
        return len(content)

    def fs_mkdir(self, lab_name: str, machine_name: str, path: str) -> None:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        self._exec_checked(
            lab_name,
            machine_name,
            ["mkdir", "-p", normalized],
            wait=False,
            action_label=f"Create directory `{normalized}`",
        )

    def fs_move(self, lab_name: str, machine_name: str, source_path: str, destination_path: str) -> None:
        _, source = self._running_guest_path(lab_name, machine_name, source_path)
        destination = self.normalize_guest_path(destination_path)
        self._exec_checked(
            lab_name,
            machine_name,
            ["mv", "--", source, destination],
            wait=False,
            action_label=f"Move `{source}`",
        )

    def fs_copy(self, lab_name: str, machine_name: str, source_path: str, destination_path: str) -> None:
        # Like `mv` above, `cp -a` copies *into* an existing destination directory rather than
        # replacing it — a pre-existing quirk shared with move, sidestepped by the frontend
        # deleting a confirmed directory collision before calling this.
        _, source = self._running_guest_path(lab_name, machine_name, source_path)
        destination = self.normalize_guest_path(destination_path)
        self._exec_checked(
            lab_name,
            machine_name,
            ["cp", "-a", "--", source, destination],
            wait=False,
            action_label=f"Copy `{source}`",
        )

    def fs_delete(self, lab_name: str, machine_name: str, path: str, recursive: bool = False) -> None:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        if recursive:
            self._exec_checked(
                lab_name,
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
            lab_name,
            machine_name,
            ["sh", "-lc", cmd],
            wait=False,
            action_label=f"Delete `{normalized}`",
        )

    # -- links ----------------------------------------------------------------

    def add_link(self, lab_name: str, link_name: str, external: Optional[list[str]] = None) -> Link:
        # `lab`/`link` read *inside* the lock (see add_machine's comment on why), along with the
        # `link.external` model mutation — building it outside the lock is the same class of
        # issue as reading stale state: a concurrent operation on this lab could run in between.
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            link = lab.get_or_new_link(link_name)
            if external:
                for iface in external:
                    link.external.append(lab_builder.build_external_link(iface))
            self._facade().deploy_link(link)
        return link

    def remove_link(self, lab_name: str, link_name: str) -> None:
        # Running-machine check decided *inside* the lock — same reasoning as add_machine/
        # connect_machine/disconnect_machine: a read taken before the lock could see "all stopped"
        # and then have a concurrent deploy_lab start a machine before this function's own critical
        # section runs.
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
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

            self._facade().undeploy_link(link)

            # Every attached machine is stopped (checked above): persist the removal to lab.conf,
            # the same way disconnect_machine's stopped branch does for a single interface.
            machine_names = list(link.machines.keys())

            def edit(text: str) -> str:
                for machine_name in machine_names:
                    text = lab_conf_edit.remove_interface(text, machine_name, link_name)
                return text

            self._edit_lab_conf(lab_name, edit)

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
        lab_name: str,
        machine_name: str,
        command: Union[str, list[str]],
        wait: bool = False,
    ) -> tuple[bytes, bytes, int]:
        return self._facade().exec(
            machine_name, command, lab_name=lab_name, wait=wait, stream=False
        )

    # -- stats ----------------------------------------------------------------

    # Kathara's own `DockerMachine.get_machines_stats` has no delay for an *empty* container
    # list -- a bare `while True: yield dict()` -- so without a floor below, opening this stream
    # against an undeployed (or since-undeployed) lab pins a CPU core and hammers the Docker
    # daemon with back-to-back container listings. This restores the ~1 sample/second cadence
    # Docker's own stats API already imposes once machines are running (DockerMachineStats reads
    # from `container.stats(stream=True)`), so the floor is a no-op in the deployed steady state
    # -- a real sample already takes at least that long to arrive.
    _MIN_STATS_INTERVAL_S = 1.0

    def machines_stats_stream(self, lab_name: str) -> Generator[list, None, None]:
        # A plain (non-generator) function, deliberately: this must raise *synchronously*, when
        # the caller calls it, not lazily on first iteration. `routers/stats.py` wraps the
        # returned generator straight into an already-started `EventSourceResponse` — by the time
        # anything iterates it, a 200 has already gone out and a raised LabNotFoundError could no
        # longer become a 404. Checking here, before returning the inner generator, is what makes
        # an unknown lab name a clean 404 instead of a stream that opens fine and never emits.
        if self.registry.get(lab_name) is None and not self.store.lab_dir(lab_name).is_dir():
            self.get_lab_or_reconstruct(lab_name)  # raises LabNotFoundError unless running under this name

        def _stream():
            last_yield = 0.0
            for stats_dict in self._facade().get_machines_stats(lab_name=lab_name):
                elapsed = time.monotonic() - last_yield
                if elapsed < self._MIN_STATS_INTERVAL_S:
                    time.sleep(self._MIN_STATS_INTERVAL_S - elapsed)
                last_yield = time.monotonic()
                yield list(stats_dict.values())

        return _stream()


