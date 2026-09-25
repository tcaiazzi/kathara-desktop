"""On-disk persistence of labs as standard Kathara lab directories.

Every lab this app creates is written to ``<root>/<name>/`` as a real Kathara lab directory
(``lab.conf``, ``<machine>.startup``, ``shared.startup``, ``<machine>/…``, ``shared/…``). This is
what lets labs survive a server restart — the in-memory ``LabRegistry`` alone does not. The store is
deliberately free of any Kathara-facade/deploy concerns: it only reads and writes directories.

A lab is identified by its directory, not by its name: ``lab_id_for`` derives the id every other
layer uses (registry key, URL segment, Kathara's lab hash) from the directory's absolute path. So
only the *creation* methods take a name — they decide where under the root a new lab goes — and
every method that works on an existing lab takes its directory.

``gen_lab_conf`` regenerates a ``lab.conf`` from a populated ``Lab`` object (Kathara ships parsers
but no writer), so JSON-created labs — which have no source ``lab.conf`` — can still be persisted in
the same on-disk format as uploaded ones.
"""

import hashlib
import io
import json
import logging
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, BinaryIO, NamedTuple, Optional, Union

from Kathara import utils as kathara_utils
from Kathara.exceptions import LabNotFoundError
from Kathara.model.Lab import Lab

from ..config import format_mb, get_settings
from ..errors import ApiError, LabAlreadyRegisteredError
from ..lab_conf_options import (
    DEFAULT_IMAGE,
    IMAGE_KEY,
    LAB_CONF_FILENAME,
    MODELED_META_KEYS,
    SCALAR_OPTIONS,
)

logger = logging.getLogger("kathara_api")

# Lab names double as directory names, so they must be a safe, single path segment.
LAB_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# The fixed topology layout of a lab, stored next to lab.conf/lab.ext/lab.dep so it travels with the
# lab directory (zip download/upload, git, server restarts). JSON body; unknown to Kathara itself and
# ignored by this project's lab.conf/folder parser (see lab_import.translate_lab_files).
LAYOUT_FILENAME = "lab.layout"


# A lab.conf is a handful of lines; this is a sanity ceiling on what a hand-dropped file in the
# labs directory will be read back as (cf. LAYOUT_MAX_NODES in schemas/lab.py), not a limit any
# generated or legitimately-imported file could ever approach.
MAX_LAB_CONF_BYTES = 1 << 20

# The scalar render order and the "already has a home" set both come from `lab_conf_options` —
# see that module for why they are not spelled out here. Everything in `device.meta` that is *not*
# in MODELED_META_KEYS is a pass-through option (see `lab_builder.apply_options`) and gets its own
# `name[key]="value"` line, sorted for stability.


def lab_id_for(directory: Union[str, Path]) -> str:
    """The id of the lab stored in ``directory``: Kathara's own hash of its absolute path.

    Computed exactly the way ``kathara lstart`` computes a lab's hash (``LabParser.parse`` builds
    ``Lab(None, path)`` from ``utils.get_absolute_path``), so a lab started from the CLI in the same
    directory is the same lab here — same containers, same ``lab_hash`` label — and two labs whose
    directories share a basename don't collide. The directory need not exist yet: a creation path
    claims the id of the directory it is about to write.

    Kathara's hash first drops every non-ASCII character, so two directories whose paths differ
    only in those do share an id — as they would share containers under the CLI.
    ``KatharaService.open_lab`` refuses the second one rather than confuse the two.

    The one case where the CLI disagrees is a ``lab.conf`` with a ``LAB_NAME`` line: Kathara's
    ``LabParser`` then re-derives the hash from that name. This app never writes one
    (``gen_lab_conf``) and ignores one it reads, so only a hand-written ``LAB_NAME`` diverges.
    """
    return kathara_utils.generate_urlsafe_hash(kathara_utils.get_absolute_path(str(directory)))


class LabPlace(NamedTuple):
    """Where a lab lives: its directory (None for a lab known only from running containers), and
    whether that directory is under the labs root — a lab this app created or that was dropped
    there — rather than a folder opened from elsewhere."""

    directory: Optional[Path]
    managed: bool


def is_within(path: Path, base: Path) -> bool:
    """Whether ``path`` resolves to ``base`` or somewhere beneath it, symlinks followed."""
    resolved_base = base.resolve()
    resolved = path.resolve()
    return resolved == resolved_base or resolved_base in resolved.parents


def sanitize_lab_name(name: str) -> str:
    """Validate a lab name as a safe single path segment, or raise ``ApiError``."""
    candidate = (name or "").strip()
    if candidate in (".", "..") or "/" in candidate or "\\" in candidate or not LAB_NAME_RE.match(candidate):
        raise ApiError(
            f"Invalid lab name `{name}`. Use letters, digits, dot, dash or underscore (max 64 chars)."
        )
    return candidate


def conf_value(value: Any) -> str:
    """Render a single ``lab.conf`` value, quoting only when the bare form would be ambiguous.

    ``lab.conf`` has no escape mechanism (mirrored by ``lab_import.CONF_LINE_RE`` and identical in
    Kathara's own ``LabParser``): a value containing a quote character can't be represented at all,
    so it is rejected here as defense in depth (the API's own schema validators —
    ``schemas.common.reject_lab_conf_quotes`` — are meant to catch this before it ever reaches a
    ``Lab`` object). Quoting is applied only when the value contains whitespace or ``#`` (which
    would otherwise be parsed as a trailing comment), so a generated file stays close to what a
    human would write by hand.
    """
    text = str(value)
    if '"' in text or "'" in text or "\n" in text or "\r" in text:
        raise ApiError(f"Cannot write value {text!r} to lab.conf: it contains a quote or newline.")
    if not text or any(c.isspace() for c in text) or "#" in text:
        return f'"{text}"'
    return text


def gen_device_lines(device) -> list[str]:
    """Render one device's ``lab.conf`` body (interfaces, then options) — no leading/trailing
    blank line, so callers control block separation themselves.

    Shared by ``gen_lab_conf`` (whole-file generation for JSON-created labs) and
    ``lab_conf_edit.add_device`` (appending one new block to an existing, otherwise verbatim
    file) — a single formatting dialect for a generated device block.
    """
    lines: list[str] = []
    name = device.name

    for num in sorted(device.interfaces.keys()):
        iface = device.interfaces[num]
        if iface is None:
            continue
        link_name = iface.link.name
        if iface.mac_address:
            lines.append(f'{name}[{num}]="{link_name}/{iface.mac_address}"')
        else:
            lines.append(f'{name}[{num}]="{link_name}"')

    meta = device.meta
    image = meta.get(IMAGE_KEY)
    lines.append(f'{name}[{IMAGE_KEY}]="{image if image else DEFAULT_IMAGE}"')

    for key in SCALAR_OPTIONS:
        value = meta.get(key)
        # A falsy scalar is normally indistinguishable from an absent one and is left out.
        # `ipv6` is the exception: it is three-state, so False means "off" rather than "never
        # set" and has to be written (see lab_conf_edit.replace_device_options, which keeps the
        # same distinction on the edit path — a device created as disabled and one that follows
        # the global setting must not render the same).
        absent = (None, "") if key == "ipv6" else (None, "", False)
        if value not in absent:
            lines.append(f'{name}[{key}]={conf_value(value)}')

    for (host_port, protocol), guest_port in meta.get("ports", {}).items():
        lines.append(f'{name}[port]="{host_port}:{guest_port}/{protocol}"')
    for env_key, env_value in meta.get("envs", {}).items():
        lines.append(f'{name}[env]="{env_key}={env_value}"')
    for sysctl_key, sysctl_value in meta.get("sysctls", {}).items():
        lines.append(f'{name}[sysctl]="{sysctl_key}={sysctl_value}"')
    for ulimit_key, limits in meta.get("ulimits", {}).items():
        lines.append(f'{name}[ulimit]="{ulimit_key}={limits["soft"]}:{limits["hard"]}"')
    for host_path, volume in meta.get("volumes", {}).items():
        lines.append(f'{name}[volume]="{host_path}|{volume["guest_path"]}|{volume["mode"]}"')
    for command in meta.get("exec_commands", []):
        lines.append(f'{name}[exec]="{command}"')

    # Pass-through metas this API doesn't interpret (see lab_builder.apply_options), sorted for
    # stable output.
    for key in sorted(set(meta) - MODELED_META_KEYS):
        lines.append(f'{name}[{key}]={conf_value(meta[key])}')

    return lines


def gen_lab_conf(lab: Lab) -> str:
    """Serialize a populated ``Lab`` back into ``lab.conf`` text.

    Round-trips through both this project's parser (``lab_import.parse_lab_conf``) and Kathara's
    own ``LabParser``. MACs are only appended when set (no trailing ``/None``), lab metadata lines
    are emitted, and container-typed metas (envs/sysctls/ports/ulimits/volumes/exec) are expanded
    into their proper one-line-each directives.

    ``LAB_NAME`` is the one metadata key never written. Kathara's ``LabParser`` assigns it to
    ``lab.name``, whose setter re-derives the lab's hash from it, so a ``lab.conf`` carrying one
    makes ``kathara lstart`` hash the *name* instead of the directory — and deploy under a
    different identity than this app's (see ``lab_id_for``). The name lives in the directory name.

    Generating is only ever done where there is no user text to preserve, which is two callers:
    ``LabStore.write_lab_conf`` for a JSON-described lab (``create_lab``), and
    ``KatharaService._lab_conf_base_text`` for a folder-based import whose directory carries no
    ``lab.conf`` — that lab gains a real one on its first edit. Every other path, structural edits
    included, builds on the stored text and persists it verbatim; see
    ``LabStore.write_lab_conf_text``.
    """
    lines: list[str] = []

    metadata = [
        ("LAB_DESCRIPTION", lab.description),
        ("LAB_VERSION", lab.version),
        ("LAB_AUTHOR", lab.author),
        ("LAB_EMAIL", lab.email),
        ("LAB_WEB", lab.web),
    ]
    wrote_meta = False
    for key, value in metadata:
        if value:
            lines.append(f'{key}={conf_value(value)}')
            wrote_meta = True
    if wrote_meta:
        lines.append("")

    for device in lab.machines.values():
        lines.extend(gen_device_lines(device))
        lines.append("")

    return "\n".join(lines) + "\n"


class LabStore:
    """Creates labs as directories under a single storage root, and reads and writes lab
    directories wherever they are."""

    def __init__(self, root: Union[str, Path]) -> None:
        self.root = Path(root)
        # Digest of the lab.conf text this store last wrote into each lab directory — see
        # wrote_lab_conf, which lets the disk watcher tell this app's own writes from anyone else's.
        self._written_conf: dict[Path, str] = {}

    def ensure_root(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)

    def lab_dir(self, name: str) -> Path:
        return self.root / sanitize_lab_name(name)

    def ensure_lab_dir(self, name: str) -> Path:
        """Create (if absent) and return the lab's directory.

        Unlike ``write_lab``/``extract_zip``, this does not atomically swap the whole directory
        — it exists so a native ``osfs://`` ``Lab`` can be constructed against a directory that
        pyfilesystem2 requires to already exist, before any content is written into it.
        """
        self.ensure_root()
        directory = self.lab_dir(name)
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def lab_names(self) -> list[str]:
        """Names of every stored lab (subdirectories, excluding dotfiles/temp dirs)."""
        if not self.root.exists():
            return []
        return sorted(p.name for p in self.root.iterdir() if p.is_dir() and not p.name.startswith("."))

    def is_under_root(self, directory: Path) -> bool:
        """Whether ``directory`` is one of the root's own lab directories (see ``lab_dirs``).

        By where it is listed, not where it resolves to: a lab under the root that is itself a
        symlink to elsewhere is still one of the root's — deleted, never closed.
        """
        return Path(os.path.abspath(directory)).parent.resolve() == self.root.resolve()

    def lab_dirs(self) -> list[Path]:
        """The directory of every lab under the root, in ``lab_names`` order.

        Not sanitized: a directory dropped under the root by hand is a lab whatever its name, since
        nothing about a lab's identity depends on the name being a valid *new* lab name.
        """
        return [self.root / name for name in self.lab_names()]

    def write_lab(self, name: str, files: dict[str, Union[str, bytes]], dirs: list[str] | None = None) -> Path:
        """Write a lab directory verbatim from a path->content map, atomically.

        Content is written into a private scratch dir (``_new_scratch_dir``) and then
        ``os.replace``d onto the final path (``_publish``), so a crash mid-write never leaves a
        half-populated lab directory, and a concurrent write of the same lab never lands on top
        of a finished one.
        """
        name = sanitize_lab_name(name)
        final = self.lab_dir(name)
        tmp = self._new_scratch_dir(name)
        try:
            for rel, content in files.items():
                self._write_file(tmp, rel, content)
            for rel_dir in dirs or []:
                self._safe_join(tmp, rel_dir).mkdir(parents=True, exist_ok=True)
            self._publish(tmp, final, name)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return final

    def read_lab(self, path: Union[str, Path]) -> tuple[dict[str, str], list[str]]:
        """Read a lab directory back into a text path->content map plus empty-dir list.

        Binary files are skipped (they can't be represented in the text-based pending model used
        for queued-but-not-yet-deployed state); the native-fs deploy path reads binaries straight
        off disk instead. So is a file symlinked to somewhere outside the lab: a folder opened
        from anywhere may hold one, and following it would read a file that is not the lab's.
        ``os.walk`` already declines to descend into symlinked directories. Anything that is not a
        regular file (a FIFO would block the read forever) is skipped too.
        """
        base = Path(path)
        files: dict[str, str] = {}
        dirs: list[str] = []
        for root, dirnames, filenames in os.walk(base):
            rel_root = os.path.relpath(root, base)
            if rel_root != "." and not filenames and not dirnames:
                dirs.append(rel_root.replace(os.sep, "/"))
            for filename in filenames:
                abs_path = Path(root) / filename
                if not self._is_lab_file(abs_path, base):
                    continue
                rel = os.path.relpath(abs_path, base).replace(os.sep, "/")
                try:
                    files[rel] = abs_path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, ValueError):
                    continue  # binary file — not representable as text here
        return files, dirs

    @staticmethod
    def _is_lab_file(path: Path, base: Path) -> bool:
        """Whether ``path`` is a regular file that belongs to the lab in ``base``: not a symlink out
        of it, and not a FIFO, socket or device, which reading would block on or make no sense of."""
        if path.is_symlink() and not is_within(path, base):
            return False
        return path.is_file()

    @staticmethod
    def check_openable(directory: Path) -> None:
        """Refuse a directory too large to be a lab, before anything reads it into memory.

        Opening a folder reads every text file in it (``read_lab``), so opening the wrong one —
        a home directory, a source tree — must fail fast with a clear message rather than walk
        and load all of it. Bounded by the same caps an import enforces (``ApiSettings``), which
        the Settings page can raise for a lab that legitimately exceeds them; the walk stops as
        soon as either is crossed. Symlinked directories are not followed, as in ``read_lab``.
        """
        settings = get_settings()
        count = 0
        total = 0
        for root, _dirnames, filenames in os.walk(directory):
            for filename in filenames:
                count += 1
                if count > settings.max_files_per_lab:
                    raise ApiError(
                        f"`{directory}` holds more than {settings.max_files_per_lab} files, more than a "
                        "lab this app opens. Pick the lab's own folder, or raise the limit in Settings."
                    )
                try:
                    total += (Path(root) / filename).lstat().st_size
                except OSError:
                    continue
                if total > settings.max_bytes_per_lab:
                    raise ApiError(
                        f"`{directory}` holds more than {format_mb(settings.max_bytes_per_lab)}, more than a "
                        "lab this app opens. Pick the lab's own folder, or raise the limit in Settings."
                    )

    def write_lab_conf(self, lab_dir: Path, lab: Lab) -> None:
        """Regenerate and (over)write ``lab_dir/lab.conf`` from ``lab`` (see ``gen_lab_conf``)."""
        self._write_conf(lab_dir, gen_lab_conf(lab))

    def wrote_lab_conf(self, directory: Path, text: str) -> bool:
        """Whether ``text`` is exactly the ``lab.conf`` this store last wrote into ``directory``.

        How ``KatharaService.handle_disk_change`` tells a change the app made itself — which the
        disk watcher sees like any other — from one made outside it: every lab.conf write this app
        makes goes through ``write_lab_conf``/``write_lab_conf_text``, which record it. Compared by
        content rather than by timestamp, so an outside edit landing right after one of ours is
        never mistaken for it.
        """
        return self._written_conf.get(directory.resolve()) == self._digest(text)

    def forget_lab_conf(self, directory: Path) -> None:
        """Stop treating whatever this store last wrote into ``directory`` as its own: the file has
        since been changed by someone else (see ``KatharaService.handle_disk_change``)."""
        self._written_conf.pop(directory.resolve(), None)

    def _write_conf(self, directory: Path, text: str) -> Path:
        final = directory / LAB_CONF_FILENAME
        self._atomic_write_text(final, text)
        self._written_conf[directory.resolve()] = self._digest(text)
        return final

    @staticmethod
    def _digest(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    @staticmethod
    def lab_conf_path(directory: Path) -> Path:
        return directory / LAB_CONF_FILENAME

    def read_lab_conf_text(self, directory: Path) -> Optional[str]:
        """Verbatim ``lab.conf`` text of the lab in ``directory``, or ``None`` when it has no such file.

        Reads bytes and decodes explicitly rather than ``Path.read_text`` — which performs
        universal-newline translation — so a CRLF file comes back exactly as written; a surgical
        edit (``lab_conf_edit``) must be able to put back, byte for byte, every line it did not
        touch. A file that is oversized or not valid UTF-8 is treated as "nothing editable here"
        (``None``) rather than raising, mirroring ``read_lab``'s own binary-file handling.
        """
        path = self.lab_conf_path(directory)
        if not path.is_file() or not is_within(path, directory):
            # Also None for a lab.conf symlinked out of the lab — see read_lab.
            return None
        try:
            data = path.read_bytes()
        except OSError:
            logger.warning("Could not read %s", path, exc_info=True)
            return None
        if len(data) > MAX_LAB_CONF_BYTES:
            logger.warning("Ignoring oversized %s (%d bytes)", path, len(data))
            return None
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            logger.warning("Ignoring non-UTF-8 %s", path)
            return None

    def write_lab_conf_text(self, directory: Path, text: str) -> Path:
        """Write ``lab.conf`` verbatim and atomically (tmp file + ``os.replace``).

        Used by every path that must preserve the caller's exact bytes — an import/upload's
        source file, an editor save, a surgical structural edit — as opposed to ``write_lab_conf``,
        which regenerates the file from a ``Lab`` model (lossy, and only still used by
        ``create_lab`` for JSON-described labs that have no source file to preserve).
        """
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{directory.name}` not found.")
        return self._write_conf(directory, text)

    @staticmethod
    def _atomic_write_text(path: Path, text: str) -> None:
        """Write ``text`` to ``path`` via a tmp sibling + ``os.replace``, so a crash or a full disk
        never leaves a truncated file in its place. ``newline=""`` disables Python's own newline
        translation, so the caller's exact line endings (LF, CRLF, or a mix) survive untouched."""
        tmp = path.parent / f".{path.name}.tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.replace(tmp, path)

    # -- fixed topology layout (lab.layout) -----------------------------------

    @staticmethod
    def layout_path(directory: Path) -> Path:
        return directory / LAYOUT_FILENAME

    def read_layout(self, directory: Path) -> Optional[dict[str, Any]]:
        """Parsed ``lab.layout``, or ``None`` when absent/unreadable/not an object.

        Raises ``LabNotFoundError`` if the lab itself doesn't exist — distinct from "no layout",
        which is the normal case for a lab that simply never had one pinned and must not itself be
        a 404. A hand-edited or truncated layout file must never break the topology view, so parse
        errors are logged and treated the same as "no layout".
        """
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{directory.name}` not found.")
        path = self.layout_path(directory)
        if not path.is_file() or not is_within(path, directory):
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Ignoring unreadable %s", path, exc_info=True)
            return None
        if not isinstance(data, dict):
            logger.warning("Ignoring %s: not a JSON object", path)
            return None
        return data

    def write_layout(self, directory: Path, data: dict[str, Any]) -> Path:
        """Write ``lab.layout`` atomically (tmp file + ``os.replace``), or raise ``LabNotFoundError``."""
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{directory.name}` not found.")
        final = directory / LAYOUT_FILENAME
        tmp = directory / f".{LAYOUT_FILENAME}.tmp"
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, final)
        return final

    def delete_layout(self, directory: Path) -> bool:
        """Remove ``lab.layout`` if present; returns whether a file was actually removed.

        Raises ``LabNotFoundError`` if the lab itself doesn't exist, matching ``write_layout`` —
        deleting a nonexistent lab's layout has no sensible "nothing to do" reading the way an
        absent layout file does.
        """
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{directory.name}` not found.")
        path = self.layout_path(directory)
        if not path.is_file():
            return False
        path.unlink()
        return True

    @staticmethod
    def delete_lab(directory: Path) -> None:
        if directory.exists():
            shutil.rmtree(directory)

    @staticmethod
    def rename_lab(directory: Path, new_name: str) -> Path:
        """Rename a lab directory in place, next to where it already is, and return its new path.

        Everything the lab owns travels with the directory (``lab.conf`` verbatim, device folders,
        startup scripts, ``lab.layout``), so nothing is rewritten. The new name is sanitized, so the
        rename can never leave the directory's parent, and ``os.rename`` within it is atomic.
        Refuses to clobber an existing directory; renaming to the same name is a no-op.
        """
        new_clean = sanitize_lab_name(new_name)
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{directory.name}` not found.")
        if new_clean == directory.name:
            return directory
        target = directory.parent / new_clean
        if target.exists():
            raise LabAlreadyRegisteredError(f"Lab `{new_clean}` already exists.")
        os.rename(directory, target)
        return target

    def extract_zip(self, name: str, data: BinaryIO) -> Path:
        """Extract an uploaded .zip into ``<root>/<name>/``, binary-safe and zip-slip-safe.

        Every member's *content* is extracted verbatim (empty directories are created, not
        skipped, and each file's Unix permission bits — e.g. an executable startup script — are
        restored from the archive, minus setuid/setgid/sticky, which are always stripped; see the
        mask below). A single common wrapper folder (``mylab/lab.conf`` → ``lab.conf``) is the one
        deliberate exception: it is stripped, and the lab root is re-anchored on whichever
        directory actually contains ``lab.conf``, so *paths* may shift even though every file's
        *bytes* never do.

        Bounded against a zip bomb at every level (ApiSettings, config.py — the same caps a gallery
        install enforces): the raw upload, the member count, and each member's declared size (the
        realistic zip-bomb shape: an honest but highly compressible payload) — plus, in
        ``_copy_with_cap``, the actual bytes written, as defense in depth.
        """
        settings = get_settings()
        name = sanitize_lab_name(name)
        final = self.lab_dir(name)
        tmp = self._new_scratch_dir(name)
        try:
            # Read fully into a real BytesIO rather than handing zipfile the raw upload object:
            # FastAPI backs `UploadFile.file` with a `SpooledTemporaryFile`, which on Python < 3.11
            # has no `seekable()` (added in gh-95913) — zipfile's `_SharedFile` reads that attribute
            # unconditionally, so `zipfile.ZipFile(data)` crashes with an AttributeError on 3.10.
            # BytesIO always satisfies the full file-like protocol, on every supported Python
            # version — `_read_bounded` is what keeps this from being an unconditional full read.
            raw = self._read_bounded(data, settings.max_bytes_per_lab)
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                members = archive.infolist()
                if len(members) > settings.max_files_per_lab:
                    raise ApiError(
                        f"This archive has {len(members)} entries, more than the "
                        f"{settings.max_files_per_lab} this import allows."
                    )
                written = 0
                for member in members:
                    rel = member.filename.lstrip("/")
                    if not rel:
                        continue
                    if member.is_dir():
                        self._safe_join(tmp, rel).mkdir(parents=True, exist_ok=True)
                        continue
                    if member.file_size > settings.max_bytes_per_file:
                        # Fast pre-check on the archive's own declared size — real enforcement is
                        # _copy_with_cap below, which counts bytes actually written instead of
                        # trusting this field, but there's no reason to open+extract a member this
                        # already rules out.
                        raise ApiError(
                            f"`{rel}` is {format_mb(member.file_size)}, more than the "
                            f"{format_mb(settings.max_bytes_per_file)} this import allows."
                        )
                    target = self._safe_join(tmp, rel)  # rejects zip-slip (../ escapes)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as src, open(target, "wb") as dst:
                        written += self._copy_with_cap(
                            src, dst, rel, settings.max_bytes_per_file, written, settings.max_bytes_per_lab
                        )
                    # The upper 16 bits of external_attr hold the Unix mode when the archive was
                    # created on a Unix system (create_system == 3); 0 there means "no permission
                    # bits recorded" (e.g. a Windows-authored zip), so leave the OS default alone.
                    #
                    # Masked to the permission bits, deliberately dropping setuid/setgid/sticky:
                    # `external_attr >> 16` is the archive's full st_mode, and S_ISUID/S_ISGID/
                    # S_ISVTX all fall inside the range chmod(2) honours, so an uploaded .zip could
                    # otherwise deposit a setuid file straight into the labs directory *on the
                    # host*. That matters most when the backend was relaunched elevated to deploy a
                    # privileged lab (see services/desktop): the extracted file is then root-owned
                    # and setuid. (Measured: the bits do *not* reach a deployed container — Kathara
                    # does not carry a packed device file's mode across, and makes the startup
                    # script executable itself — so the host directory is the whole blast radius.)
                    # 0o777 keeps the execute bit, which is the only reason modes are preserved at
                    # all (see this docstring) and what the zip_lab -> extract_zip round-trip needs.
                    mode = (member.external_attr >> 16) & 0o777
                    if mode:
                        os.chmod(target, mode)
            lab_root = self._find_lab_root(tmp)
            self._publish(lab_root, final, name)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return final

    def copy_lab_dir(self, name: str, source: Path) -> Path:
        """Copy an already-populated lab directory (e.g. a bundled example) into ``<root>/<name>/``,
        verbatim — file bytes and Unix mode bits preserved — atomically.

        Structurally mirrors ``extract_zip``: the same scratch-dir + ``os.replace`` swap, so a
        crash mid-copy never leaves a half-populated lab directory. Deliberately not ``write_lab``:
        that writes from ``read_lab``'s newline-normalized, binary-stripped text map, which is not
        "verbatim" — a bundled example's ``lab.layout``/startup scripts must travel exactly as
        they are on disk, not round-tripped through the text model first.
        """
        name = sanitize_lab_name(name)
        final = self.lab_dir(name)
        tmp = self._new_scratch_dir(name)
        try:
            # dirs_exist_ok: `_new_scratch_dir` already created `tmp` (atomically, which is the
            # point), whereas copytree otherwise insists on creating the destination itself.
            shutil.copytree(source, tmp, dirs_exist_ok=True)
            self._publish(tmp, final, name)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return final

    @staticmethod
    def zip_lab(directory: Path) -> io.BytesIO:
        """Zip a lab directory into an in-memory buffer, or raise ``LabNotFoundError``.

        Files are stored at the archive root (``lab.conf``, ``pc1.startup``, ``pc1/…``), so a plain
        ``unzip`` and this store's own ``extract_zip`` both round-trip the result cleanly.
        """
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{directory.name}` not found.")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            for root, _dirs, files in os.walk(directory):
                for filename in files:
                    abs_path = Path(root) / filename
                    # The download must not carry what the lab filesystem API refuses to read: a
                    # file symlinked from outside the lab (see read_lab).
                    if not LabStore._is_lab_file(abs_path, directory):
                        continue
                    arcname = os.path.relpath(abs_path, directory)
                    archive.write(abs_path, arcname)
        buf.seek(0)
        return buf

    # -- internals ------------------------------------------------------------

    def _write_file(self, base: Path, rel: str, content: Union[str, bytes]) -> None:
        target = self._safe_join(base, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        # write_bytes for both branches: Path.write_text performs universal-newline translation on
        # the platform's default, which would silently rewrite a CRLF source file — this path
        # (write_lab) is used for verbatim-import writes, so it must not touch line endings.
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_bytes(content.encode("utf-8"))

    def _new_scratch_dir(self, name: str) -> Path:
        """A private, uniquely-named scratch directory for one in-flight write of ``name``.

        Unique rather than a single ``.<name>.tmp`` per lab: with a shared spelling, two
        concurrent writes of the same lab tear each other's tree down (each one begins by
        ``rmtree``-ing whatever is already there) and then collide on ``mkdir``, surfacing to
        the client as a 500 with the absolute host path in it. ``mkdtemp`` also creates the
        directory atomically, so there is no exists-then-create window left to lose. The leading
        dot keeps it invisible to ``lab_names()``, which filters dotfiles.
        """
        self.ensure_root()
        return Path(tempfile.mkdtemp(dir=self.root, prefix=f".{name}.", suffix=".tmp"))

    @staticmethod
    def _publish(source: Path, final: Path, name: str) -> None:
        """``os.replace`` a finished scratch tree onto its final path, refusing to clobber.

        Every caller is a lab-*creation* path, and the service asserts the directory is free under
        its per-lab lock before calling in — so a ``final`` that exists here means a concurrent
        create won the race for this directory, and it is *that lab's*. Clobbering it —
        ``rmtree(final)`` before the replace — is precisely how a completed import loses every
        one of its files to a racer that goes on to fail with a 409 anyway.
        """
        if final.exists():
            raise LabAlreadyRegisteredError(f"Lab `{name}` already exists.")
        os.replace(source, final)

    @staticmethod
    def _safe_join(base: Path, rel: str) -> Path:
        """Join ``rel`` under ``base``, rejecting any path that escapes it (zip-slip / traversal)."""
        base_resolved = base.resolve()
        target = (base_resolved / rel).resolve()
        if target != base_resolved and base_resolved not in target.parents:
            raise ApiError(f"Unsafe path in lab archive: {rel!r}")
        return target

    @staticmethod
    def _read_bounded(data: BinaryIO, cap: int) -> bytes:
        """Read `data` fully, refusing once the total exceeds `cap` — bounds the whole upload
        before ``zipfile`` ever sees it, rather than trusting the archive's own idea of its size
        (an empty/near-empty read fully into memory is exactly the shape of a zip bomb's input).
        """
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = data.read(1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > cap:
                raise ApiError(f"Upload is larger than the {format_mb(cap)} this import allows.")
            chunks.append(chunk)
        return b"".join(chunks)

    @staticmethod
    def _copy_with_cap(src: BinaryIO, dst: BinaryIO, rel: str, per_file_cap: int, written_so_far: int, total_cap: int) -> int:
        """Copy `src` into `dst` in chunks, returning the byte count actually written.

        Checked against bytes actually read off the stream, not `ZipInfo.file_size` (the archive's
        own *declared* uncompressed size, already checked as a fast pre-check before this even
        runs, so a genuinely-large member — the realistic zip-bomb shape: an honest, highly
        compressible payload — is already rejected before extraction starts). Counting real bytes
        here anyway is defense in depth against that declared size and the real output ever
        disagreeing, by whatever means — verified that a *plain* undersized `file_size` isn't
        actually such a means: `zipfile.ZipExtFile.read` already enforces it and raises
        `BadZipFile` (a CRC mismatch) as soon as the real stream turns out longer, before handing
        back a single extra byte. `written_so_far` carries the running total across every member
        already extracted, so the cumulative per-lab cap can't be defeated by many small files
        each individually under `per_file_cap`.
        """
        written = 0
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            written += len(chunk)
            if written > per_file_cap:
                raise ApiError(f"`{rel}` is larger than the {format_mb(per_file_cap)} this import allows.")
            if written_so_far + written > total_cap:
                raise ApiError(f"This archive is larger than the {format_mb(total_cap)} this import allows.")
            dst.write(chunk)
        return written

    @staticmethod
    def _find_lab_root(base: Path) -> Path:
        """Locate the directory that is the actual lab root within a freshly extracted tree."""
        if (base / LAB_CONF_FILENAME).exists():
            return base
        subdirs = [p for p in base.iterdir() if p.is_dir()]
        files = [p for p in base.iterdir() if p.is_file()]
        if len(subdirs) == 1 and not files:
            # Single wrapper folder — with or without a lab.conf (folder-based lab).
            return subdirs[0]
        return base
