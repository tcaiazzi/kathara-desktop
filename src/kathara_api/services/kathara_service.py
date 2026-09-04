"""Adapter that wraps the singleton Kathara facade for the REST API.

Design notes:
- The Kathara facade and ``Setting`` are process-wide singletons and Kathara is not safe for
  concurrent *independent* mutating calls, so all state-changing operations are serialized behind
  a single re-entrant lock. Read-only operations (stats, exec, reconstruction) run concurrently.
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
from pathlib import Path
from typing import Any, BinaryIO, Callable, Generator, Optional, Union

import fs.copy
import fs.path
from Kathara.exceptions import (
    InvocationError,
    LabNotFoundError,
    MachineNotFoundError,
    MachineNotRunningError,
    NotSupportedError,
)
from Kathara.manager.Kathara import Kathara
from Kathara.model.Lab import Lab
from Kathara.model.Machine import Machine
from Kathara.setting.Setting import Setting
from Kathara.utils import is_admin
from Kathara.webhooks.DockerHubApi import DockerHubApi
from pydantic import ValidationError

from ..config import get_settings
from ..errors import (
    ApiError,
    BinaryFileError,
    LabAlreadyRegisteredError,
    LabConfLockedError,
    LabRenameLockedError,
    LabTransitioningError,
    PathNotFoundError,
    SettingsLockedError,
)
from ..schemas.filesystem import FsEntry
from ..schemas.examples import ExampleSummary
from ..schemas.gallery import GalleryCatalog, GalleryLabSummary
from ..schemas.lab import LabConfView, LabCreate, LabLayout
from ..schemas.machine import MachineCreate, MachineUpdate
from . import examples, lab_builder, lab_conf_edit, lab_gallery, lab_import, lab_store
from .docker_tty import SHELL_PATHS
from .lab_store import LabStore
from .registry import LabRegistry

logger = logging.getLogger("kathara_api")

# Reserved "machine name" for files/dirs queued directly under the lab root (no device) — the Lab
# Configuration tab's tree root. Structurally impossible for a real device to collide with: device
# names are validated against MACHINE_NAME_PATTERN (schemas/machine.py), which is lowercase-only.
ROOT_MACHINE = "ROOT"


class KatharaService:
    """Thread-safe wrapper around ``Kathara.get_instance()``."""

    # How long a fetched Docker Hub image list stays valid before the next call re-fetches it.
    # DockerHubApi.get_tagged_images() has no caching of its own and fans out one HTTP request per
    # official image (~20-30) on every call — fine for the CLI's one-shot settings menu, too slow
    # and too chatty to redo on every "Add device"/options-editor open in a long-lived UI session.
    _IMAGES_CACHE_TTL = 300

    def __init__(self, store: Optional[LabStore] = None) -> None:
        self._instance: Optional[Kathara] = None
        self._mutate_lock = threading.RLock()
        self._init_lock = threading.Lock()
        self._images_cache: Optional[list[str]] = None
        self._images_cache_at: float = 0.0
        self._images_cache_lock = threading.Lock()
        # Names of labs currently inside deploy_lab/undeploy_lab — see _check_not_transitioning.
        # A separate, always-uncontended lock, deliberately not `_mutate_lock`: deploy_lab holds
        # that one for the whole (potentially slow) facade call, so checking membership through it
        # would block the check itself for just as long, defeating the point of a fast-fail guard.
        self._transitioning: set[str] = set()
        self._transitioning_lock = threading.Lock()
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
                    self._instance = Kathara.get_instance()
        return self._instance

    def apply_startup_settings(self, settings: dict[str, Any]) -> None:
        """Apply settings before the facade is created (used at app startup)."""
        if settings:
            Setting.get_instance().load_from_dict(settings)

    def update_settings(self, settings: dict[str, Any]) -> None:
        """Override settings at runtime.

        Every setting except ``manager_type`` is read fresh by the Kathara framework at the
        point of use, so it's safe to change any of them at any time. ``manager_type`` picks the
        concrete manager class exactly once, inside ``Kathara.get_instance()``'s constructor, and
        there's no supported way to swap it out afterward for the life of this process — so an
        actual change to it is rejected once the facade has been instantiated, rather than
        silently accepted but never taking effect.
        """
        if self._instance is not None and "manager_type" in settings:
            current = Setting.get_instance().manager_type
            if settings["manager_type"] != current:
                raise SettingsLockedError(
                    "`manager_type` cannot be changed after the Kathara manager has been "
                    "initialized for this backend session — restart the backend to switch "
                    "managers. Other settings can still be updated freely."
                )
        Setting.get_instance().load_from_dict(settings)

    def get_settings_view(self) -> dict[str, Any]:
        setting = Setting.get_instance()
        # _to_dict() holds core settings; addons.merge() adds manager-specific ones.
        return setting.addons.merge(setting._to_dict())

    def system_info(self) -> dict[str, Any]:
        facade = self._facade()
        return {
            "manager": facade.get_formatted_manager_name(),
            "version": facade.get_release_version(),
            # Hardcoded rather than `Kathara.get_available_managers_name()`: that call eagerly
            # imports Kathara's Kubernetes manager (and the 80MB+ `kubernetes` package) even
            # though this app only ever drives Docker. Keep the label identical to what Kathara
            # itself reports for "docker" so the UI is unaffected for the one manager we support.
            "available_managers": {"docker": "Docker (Kathara)"},
            "is_admin": is_admin(),
        }

    def list_available_images(self) -> list[str]:
        """Official Kathara device images published on Docker Hub (the ``kathara/`` org), via
        Kathara's own CLI-settings lookup (``DockerHubApi.get_tagged_images``) — the same source
        the `kathara settings` terminal menu uses to offer a default-image picker. Cached
        in-process for ``_IMAGES_CACHE_TTL`` seconds; raises ``HTTPConnectionError`` (mapped to a
        502 by ``errors.py``) if Docker Hub can't be reached, which callers should treat as
        non-fatal — mirrors the CLI's own behavior of silently falling back to manual entry.
        """
        with self._images_cache_lock:
            if self._images_cache is not None and time.monotonic() - self._images_cache_at < self._IMAGES_CACHE_TTL:
                return self._images_cache
        images = DockerHubApi.get_tagged_images()
        with self._images_cache_lock:
            self._images_cache = images
            self._images_cache_at = time.monotonic()
        return images

    def wipe(self) -> None:
        """Undeploy every lab kathara-ide itself has registered and deployed.

        Unlike the Kathara CLI's own ``wipe(all_users=False)``, which force-undeploys *every*
        running scenario for the OS user regardless of who deployed it, this only touches labs
        this backend is managing — it must not reach out and kill scenarios some other tool (the
        CLI, another Kathara frontend) started. Routed through ``undeploy_lab`` per registered lab
        so the usual post-undeploy bookkeeping (cleared api_object, topology reloaded from disk)
        happens exactly as it would for a single manual undeploy.
        """
        with self._mutate_lock:
            for lab in self.registry.all():
                if any(m.api_object is not None for m in lab.machines.values()):
                    self.undeploy_lab(lab.name)

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
        machine = lab.machines.get(machine_name)
        if machine is None:
            return
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

    def _fs_for(self, lab: Lab, machine_name: str):
        """The real (osfs) fs backing ``machine_name``'s offline files — the lab's own root
        directory for ``ROOT_MACHINE``, or a registered device's own subdirectory. ``None`` if
        ``machine_name`` is neither ``ROOT_MACHINE`` nor a registered device."""
        if machine_name == ROOT_MACHINE:
            return lab.fs
        machine = lab.machines.get(machine_name)
        return machine.fs if machine is not None else None

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
        ``import_lab``/``upload_lab``), so there is nothing left to materialize. Kathara's own
        ``Machine.pack_data`` reads a machine's files straight off ``machine.fs`` and its
        ``<name>.startup``/``shared.startup``/``shared.shutdown`` straight off ``lab.fs`` at
        deploy time — a machine whose subfolder already exists on disk picks up ``machine.fs``
        automatically (``Machine.__init__``), so nothing needs writing here for that to work.
        """
        return self._build_and_register(t.payload, self.store.lab_dir(name))

    def create_lab(self, spec: LabCreate) -> Lab:
        lab_dir = self.store.ensure_lab_dir(spec.name)
        lab = self._build_and_register(spec, lab_dir)
        # JSON-created labs have no source lab.conf, so one is generated from the model —
        # written directly here since the directory was just created and nothing else has
        # touched it yet (no atomic swap needed, unlike LabStore.write_lab/extract_zip).
        self.store.write_lab_conf(lab_dir, lab)
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

        Used only as the folder-based-import bootstrap in ``_lab_conf_base_text`` now — every
        other offline edit works on the stored ``lab.conf`` *text* directly (``lab_conf_edit``),
        never through this model round trip.
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

    # -- lab.conf / folder import ----------------------------------------------

    def import_lab(
        self,
        name: str,
        files: dict[str, str],
        dirs: Optional[list[str]] = None,
        skipped: Optional[list[str]] = None,
    ) -> tuple[Lab, list[str]]:
        """Create a lab from a lab.conf/.startup/folder description, writing every supplied file
        to disk verbatim (the JSON twin of ``upload_lab``) and queuing it for deploy."""
        clean = lab_store.sanitize_lab_name(name)
        if self.registry.get(clean) is not None or self.store.lab_dir(clean).exists():
            raise LabAlreadyRegisteredError(f"Lab `{clean}` already exists.")
        t = lab_import.translate_lab_files(files, clean, skipped)
        if t.errors:
            raise ApiError("; ".join(t.errors))
        # Verbatim + atomic: write_lab writes into a sibling `.<name>.tmp` dir and os.replace()s
        # it into place, so a crash mid-write never leaves a half-populated lab directory. This
        # must run *before* _adopt_lab_dir: Lab(path=...) opens an osfs on the directory, and
        # Machine.__init__ only picks up an already-existing `<name>/` subfolder as `machine.fs`
        # at construction time — building first would leave every machine with `fs = None` and
        # nothing would ever be packed at deploy.
        self.store.write_lab(clean, files, dirs or [])
        try:
            lab = self._adopt_lab_dir(clean, t)
        except Exception:
            self.store.delete_lab(clean)
            raise
        return lab, t.warnings

    def _adopt_populated_dir(self, clean_name: str) -> tuple[Lab, list[str]]:
        """Parse an already-populated, on-disk lab directory and register it.

        Shared tail of ``upload_lab`` and ``install_example`` — they differ only in *how* the
        directory got populated (zip extraction vs. a verbatim copy of a bundled example), never
        in how the populated directory becomes a registered Lab. Rolls the directory back if
        parsing or registration fails, same as both callers did before this was factored out.
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

        Binary-safe (unlike ``import_lab``, whose ``files`` are JSON/text-only): the archive is
        extracted to disk exactly as uploaded — comments, quoting, ``shared.startup``/
        ``shared.shutdown``, binaries and all — then parsed the same way as a JSON-described
        import. Machine subfolders that already exist on disk after extraction are picked up
        automatically as ``machine.fs`` (see ``Machine.__init__``), so any binary files travel to
        the deployed container via Kathara's native ``pack_data`` even though the pending-files
        model (which only round-trips text) can't represent them.
        """
        clean_name = lab_store.sanitize_lab_name(name)
        if self.registry.get(clean_name) is not None or self.store.lab_dir(clean_name).exists():
            raise LabAlreadyRegisteredError(f"Lab `{clean_name}` already exists.")

        self.store.extract_zip(clean_name, zip_data)
        lab, warnings = self._adopt_populated_dir(clean_name)
        if deploy:
            lab = self.deploy_lab(clean_name)
        return lab, warnings

    def list_example_labs(self) -> list[ExampleSummary]:
        """Bundled example network scenarios, each flagged with whether it's already installed —
        see services/examples.py and the frontend's welcome screen."""
        return examples.list_examples(set(self.store.lab_names()))

    def list_gallery_labs(self, refresh: bool = False) -> GalleryCatalog:
        """The upstream Kathara-Labs catalog, each entry flagged with whether it's already
        installed — the remote twin of ``list_example_labs``. See services/lab_gallery.py."""
        catalog = lab_gallery.fetch_catalog(refresh=refresh)
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
                    title=entry.title,
                    description=entry.description,
                    n_files=entry.n_files,
                    size_bytes=entry.size_bytes,
                    slides_url=entry.slides_url,
                    repo_url=entry.repo_url,
                    installed=entry.name in installed,
                )
                for entry in catalog.entries.values()
            ],
        )

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
        if self.registry.get(clean_name) is not None or self.store.lab_dir(clean_name).exists():
            raise LabAlreadyRegisteredError(f"Lab `{clean_name}` already exists.")

        files = lab_gallery.download_lab_files(entry)
        self.store.write_lab(clean_name, files)
        return self._adopt_populated_dir(clean_name)

    def install_example(self, example_id: str, name: Optional[str] = None) -> tuple[Lab, list[str]]:
        """Create a lab from one of the bundled example network scenarios.

        Structurally identical to ``upload_lab`` — the only difference is *how* the lab
        directory gets populated (a verbatim copy of a bundled example, instead of a zip
        extraction) — see ``_adopt_populated_dir``, which both share. Installing is a create, not
        an upsert: an existing lab under the target name is a 409, exactly like upload_lab/
        import_lab, so retrying an install never silently overwrites something the user changed.
        """
        clean_name = lab_store.sanitize_lab_name(name or example_id)
        if self.registry.get(clean_name) is not None or self.store.lab_dir(clean_name).exists():
            raise LabAlreadyRegisteredError(f"Lab `{clean_name}` already exists.")

        source = examples.example_dir(example_id)  # raises ExampleNotFoundError (404) if unknown
        self.store.copy_lab_dir(clean_name, source)
        return self._adopt_populated_dir(clean_name)

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
        """Each device's real ``<machine>.startup`` content (``""`` if it doesn't exist) — a fresh
        scan, not a cache. Backs the topology node-info panel's boot-time IP preview."""
        lab = self.get_lab_or_reconstruct(lab_name)
        result: dict[str, str] = {}
        for name in lab.machines:
            fname = f"{name}.startup"
            result[name] = lab.fs.readtext(fname) if lab.fs.exists(fname) else ""
        return result

    def fs_list_offline(self, lab_name: str, path: str) -> list[FsEntry]:
        """A directory listing straight off the real fs — no synthesized entries. A device with
        nothing on disk yet simply doesn't appear at the root, the same way an empty/nonexistent
        directory has no listing on a normal filesystem; it starts existing the moment something
        is written under it (`fs_write_text_offline`/`fs_mkdir_offline`/etc.), and stops existing
        again once its last real content is deleted (see `fs_delete_offline`)."""
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

    def fs_read_text_offline(self, lab_name: str, path: str) -> str:
        if path.strip("/") == "lab.conf":
            return self.read_lab_conf(lab_name).content
        lab = self.get_lab_or_reconstruct(lab_name)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)
        if target_fs is None or not target_fs.exists(guest):
            raise PathNotFoundError(f"Path `{path}` not found.")
        if target_fs.isdir(guest):
            raise ApiError(f"`{path}` is a directory. Use list to navigate it.")
        try:
            return target_fs.readtext(guest)
        except UnicodeDecodeError as exc:
            raise BinaryFileError("File is not UTF-8 text. Use download for binary files.") from exc

    def fs_read_bytes_offline(self, lab_name: str, path: str) -> bytes:
        lab = self.get_lab_or_reconstruct(lab_name)
        owner, guest = self._offline_fs_owner(lab, path)
        target_fs = self._fs_for(lab, owner)
        if target_fs is None or not target_fs.exists(guest):
            raise PathNotFoundError(f"Path `{path}` not found.")
        if target_fs.isdir(guest):
            raise ApiError(f"`{path}` is a directory. Use list to navigate it.")
        return target_fs.readbytes(guest)

    def fs_write_text_offline(self, lab_name: str, path: str, content: str) -> int:
        if path.strip("/") == "lab.conf":
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
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            owner, guest = self._offline_fs_owner(lab, path)
            if owner == ROOT_MACHINE:
                target_fs = lab.fs
            else:
                machine = lab.machines.get(owner)
                if machine is None:
                    raise ApiError(f"Unknown device `{owner}`.")
                if machine.fs is None:
                    machine.fs = lab.fs.makedir(owner, recreate=True)
                target_fs = machine.fs
            parent = posixpath.dirname(guest)
            if parent and parent != "/":
                target_fs.makedirs(parent, recreate=True)
            target_fs.writebytes(guest, content)
            dirty = self._dirty_target_for(lab, path)
            if dirty:
                self.registry.mark_dirty(lab_name, dirty)
        return len(content)

    def fs_mkdir_offline(self, lab_name: str, path: str) -> None:
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
        if path.strip("/") == "lab.conf":
            raise ApiError("lab.conf can't be deleted.")
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            owner, guest = self._offline_fs_owner(lab, path)

            # The lab root itself is never a valid delete target — `DELETE /labs/{lab}` is what
            # removes a lab. Checked via a normalized comparison, not `path`/`guest` directly: a
            # naive string check is exactly how the `lab.conf` guard above gets bypassed by "/",
            # since "/", "", "//", "/." and "pc1/.." all resolve to the same root directory once
            # pyfilesystem gets hold of them (`fs.path.normpath` collapses all of them to "" or
            # "/", matching what `target_fs.removetree` would actually delete).
            if owner == ROOT_MACHINE and fs.path.normpath(guest) in ("", "/"):
                raise ApiError("The lab root can't be deleted. Delete the lab instead.")

            if owner != ROOT_MACHINE and guest == "/":
                # Deleting a device's own folder removes it entirely — machine.fs stops existing
                # (matching fs_list_offline, which then stops showing it) rather than leaving an
                # empty shell behind; it starts existing again the moment anything new is written
                # under this device. <name>.startup is a separate, sibling entry and untouched.
                machine = lab.machines.get(owner)
                if machine is None:
                    raise PathNotFoundError(f"Path `{path}` not found.")
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

    def fs_move_offline(self, lab_name: str, source_path: str, destination_path: str) -> None:
        if source_path.strip("/") == "lab.conf" or destination_path.strip("/") == "lab.conf":
            raise ApiError("lab.conf can't be moved.")
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            source_owner, source_guest = self._offline_fs_owner(lab, source_path)
            dest_owner, dest_guest = self._offline_fs_owner(lab, destination_path)
            src_fs = self._fs_for(lab, source_owner)
            if src_fs is None or not src_fs.exists(source_guest):
                raise PathNotFoundError(f"Path `{source_path}` not found.")

            if dest_owner == ROOT_MACHINE:
                dst_fs = lab.fs
            else:
                dst_machine = lab.machines.get(dest_owner)
                if dst_machine is None:
                    raise ApiError(f"Unknown device `{dest_owner}`.")
                if dst_machine.fs is None:
                    dst_machine.fs = lab.fs.makedir(dest_owner, recreate=True)
                dst_fs = dst_machine.fs

            parent = posixpath.dirname(dest_guest)
            if parent and parent != "/":
                dst_fs.makedirs(parent, recreate=True)

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
        if destination_path.strip("/") == "lab.conf":
            raise ApiError("lab.conf can't be replaced by copy — edit it directly.")
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            source_owner, source_guest = self._offline_fs_owner(lab, source_path)
            dest_owner, dest_guest = self._offline_fs_owner(lab, destination_path)
            src_fs = self._fs_for(lab, source_owner)
            if src_fs is None or not src_fs.exists(source_guest):
                raise PathNotFoundError(f"Path `{source_path}` not found.")

            if dest_owner == ROOT_MACHINE:
                dst_fs = lab.fs
            else:
                dst_machine = lab.machines.get(dest_owner)
                if dst_machine is None:
                    raise ApiError(f"Unknown device `{dest_owner}`.")
                if dst_machine.fs is None:
                    dst_machine.fs = lab.fs.makedir(dest_owner, recreate=True)
                dst_fs = dst_machine.fs

            parent = posixpath.dirname(dest_guest)
            if parent and parent != "/":
                dst_fs.makedirs(parent, recreate=True)

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
            try:
                self._facade().update_lab_from_api(lab)
            except LabNotFoundError:
                # Some managers raise when nothing is running under this name; the Docker manager
                # instead enriches with whatever containers exist (none) and never raises. Either
                # way, keep the registered (config) model as-is.
                pass
            return lab

        # Not registered: try to rebuild from the running backend state.
        try:
            reconstructed = self._facade().get_lab_from_api(lab_name=name)
        except LabNotFoundError as exc:
            raise LabNotFoundError(f"Lab `{name}` not found.") from exc

        # get_lab_from_api returns an empty Lab when nothing is running under that name.
        if not reconstructed.machines:
            raise LabNotFoundError(f"Lab `{name}` not found.")
        return reconstructed

    def list_labs(self) -> list[Lab]:
        labs = self.registry.all()
        for lab in labs:
            try:
                self._facade().update_lab_from_api(lab)
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
        # Marked as transitioning for the whole call, not just the facade section below — a
        # lab.conf edit/offline-fs write/structural change arriving anywhere in this window should
        # fail fast via _check_not_transitioning rather than queue up behind _mutate_lock.
        self._begin_transition(name)
        try:
            if selected_machines and excluded_machines:
                raise InvocationError("You can either select or exclude devices.")

            lab = self.get_lab_or_reconstruct(name)
            all_names = set(lab.machines.keys())

            # Mirror the facade's own validation (it would otherwise never run for this call, since
            # below we always pass it a freshly-computed `selected_machines`, not the caller's raw
            # selected/excluded_machines).
            for label, requested in (("selected", selected_machines), ("excluded", excluded_machines)):
                if requested is not None and not requested <= all_names:
                    missing = requested - all_names
                    raise MachineNotFoundError(f"The following devices are not in the network scenario: {missing}.")

            target_names = self._resolve_targets(all_names, selected_machines, excluded_machines)

            # Already-running machines can't be recreated — Kathara's facade raises
            # MachineAlreadyExistsError for them — so only machines about to be *freshly* created are
            # passed to it. Their files are already on disk by now: an import/upload wrote them there
            # verbatim (see _adopt_lab_dir) and any pre-deploy edit was written through immediately by
            # fs_write_text_offline/etc. — so Kathara's own deploy machinery (Machine.pack_data) packs
            # them straight from the real (osfs) fs, with nothing to materialize here. Already-running
            # targets instead get any *changed* file pushed live via ``_live_push`` (the dirty set —
            # see registry.mark_dirty — not everything, so an untouched machine isn't redundantly
            # re-pushed and its startup script re-executed on every redeploy), the only way to reach a
            # container that already exists.
            pre_running = {m.name for m in lab.machines.values() if m.api_object is not None}
            fresh_names = target_names - pre_running
            already_running = target_names & pre_running

            if fresh_names:
                with self._mutate_lock:
                    self._facade().deploy_lab(lab, selected_machines=fresh_names)
                # Native pack_data just packed each fresh machine's *current* on-disk state, so any
                # dirty flag an offline edit set before this deploy is already reflected — discard it
                # rather than leaving it to trigger a spurious live-push on some future redeploy.
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
                        continue  # binary — this live-push path is text-only, same as before

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
        self._begin_transition(name)
        try:
            with self._mutate_lock:
                lab = self.registry.get(name)
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
            if self.registry.get(clean_new) is not None or self.store.lab_dir(clean_new).exists():
                raise LabAlreadyRegisteredError(f"Lab `{clean_new}` already exists.")

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
            self._facade().undeploy_lab(lab_name=name)
        self.registry.remove(name)
        self.store.delete_lab(name)

    # -- machines -------------------------------------------------------------

    def get_machine(self, lab_name: str, machine_name: str) -> Machine:
        lab = self.get_lab_or_reconstruct(lab_name)
        return lab.get_machine(machine_name)

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
            # The facade only undeploys — it leaves the device in the model, so it kept reappearing
            # in the topology/devices forever. Actually drop it from the Lab (and its on-disk files).
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

            self._facade().connect_machine_to_link(
                machine,
                link,
                mac_address=mac_address,
            )
        return machine

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
        # `_get_running_machine` (lab/machine lookup + the running check) moved inside the lock —
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

    def fs_list_directory(self, lab_name: str, machine_name: str, path: str) -> list[dict[str, Any]]:
        _, normalized = self._running_guest_path(lab_name, machine_name, path)
        quoted = shlex.quote(normalized)
        # `-H` dereferences `path` itself when it's a symlink (e.g. Debian/Ubuntu's merged-usr
        # `/bin -> usr/bin`) without following symlinks encountered among the listed children —
        # plain `find` (`-P`) treats a symlinked `path` as a leaf at depth 0, so with `-mindepth 1`
        # excluding that depth-0 node, listing a symlinked directory silently returns zero entries.
        cmd = f"find -H {quoted} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%Y\\t%s\\t%m\\t%T@\\n'"
        stdout, _ = self._exec_checked(
            lab_name,
            machine_name,
            ["sh", "-lc", cmd],
            wait=False,
            action_label=f"List directory `{normalized}`",
        )

        entries: list[dict[str, Any]] = []
        for raw_line in stdout.decode("utf-8", errors="replace").splitlines():
            if not raw_line.strip():
                continue
            parts = raw_line.split("\t", 5)
            if len(parts) != 6:
                continue
            name, kind, target_kind, size_raw, mode, mtime_raw = parts
            child_path = f"/{name}" if normalized == "/" else f"{normalized}/{name}"
            entry: dict[str, Any] = {
                "name": name,
                "path": child_path,
                # Treat symlinks to directories as directories for UI navigation.
                "is_dir": kind == "d" or (kind == "l" and target_kind == "d"),
                "mode": mode,
            }
            try:
                entry["size"] = int(size_raw)
            except ValueError:
                entry["size"] = None
            try:
                entry["mtime"] = float(mtime_raw)
            except ValueError:
                entry["mtime"] = None
            entries.append(entry)
        # Same order as the offline tree and the host browser — directories first, then
        # case-insensitive by name — rather than whatever `find` happened to emit.
        return sorted(entries, key=lambda e: (not e["is_dir"], e["name"].lower()))

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
        machine, normalized = self._running_guest_path(lab_name, machine_name, path)
        with self._mutate_lock:
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

    def add_link(self, lab_name: str, link_name: str, external: Optional[list[str]] = None):
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
        self._check_not_transitioning(lab_name)
        with self._mutate_lock:
            lab = self.get_lab_or_reconstruct(lab_name)
            link = lab.get_link(link_name)
            self._facade().undeploy_link(link)

            # Keep the in-memory model consistent with the operation: drop all
            # interfaces attached to this collision domain and remove the link
            # from the lab map so it no longer appears in topology/list views.
            for machine_name in list(link.machines.keys()):
                machine = lab.machines.get(machine_name)
                if machine is not None:
                    try:
                        machine.remove_interface(link)
                    except Exception:
                        # If backend state changed first, best effort to keep going.
                        pass

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

    def exec_stream(
        self,
        lab_name: str,
        machine_name: str,
        command: Union[str, list[str]],
        wait: bool = False,
    ):
        return self._facade().exec(
            machine_name, command, lab_name=lab_name, wait=wait, stream=True
        )

    # -- stats ----------------------------------------------------------------

    def machines_stats_stream(self, lab_name: str) -> Generator[list, None, None]:
        for stats_dict in self._facade().get_machines_stats(lab_name=lab_name):
            yield list(stats_dict.values())

    @staticmethod
    def _first_sample(gen, default=None):
        """Pull the first item from a lazy stats generator, always closing it afterwards. Returns
        ``default`` when the generator is empty (``StopIteration``)."""
        try:
            return next(gen)
        except StopIteration:
            return default
        finally:
            gen.close()

    def machines_stats_snapshot(self, lab_name: str) -> list:
        sample = self._first_sample(self._facade().get_machines_stats(lab_name=lab_name))
        return list(sample.values()) if sample is not None else []

    def machine_stats_snapshot(self, lab_name: str, machine_name: str):
        # get_machine_stats *yields None* (it doesn't stop) for a device that isn't running, so guard
        # the None sentinel as well as an empty generator — both mean "no live device".
        sample = self._first_sample(self._facade().get_machine_stats(machine_name, lab_name=lab_name))
        if sample is None:
            # MachineNotRunningError formats its own "Device `<name>` is not running." message.
            raise MachineNotRunningError(machine_name)
        return sample
