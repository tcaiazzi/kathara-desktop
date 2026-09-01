"""On-disk persistence of labs as standard Kathara lab directories.

Every lab is written to ``<root>/<name>/`` as a real Kathara lab directory (``lab.conf``,
``<machine>.startup``, ``shared.startup``, ``<machine>/…``, ``shared/…``). This is what lets labs
survive a server restart — the in-memory ``LabRegistry`` alone does not. The store is deliberately
free of any Kathara-facade/deploy concerns: it only reads and writes directories.

``gen_lab_conf`` regenerates a ``lab.conf`` from a populated ``Lab`` object (Kathara ships parsers
but no writer), so JSON-created labs — which have no source ``lab.conf`` — can still be persisted in
the same on-disk format as uploaded ones.
"""

import io
import json
import logging
import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, BinaryIO, Optional, Union

from Kathara.exceptions import LabNotFoundError
from Kathara.model.Lab import Lab

from ..errors import ApiError, LabAlreadyRegisteredError

logger = logging.getLogger("kathara_api")

# Lab names double as directory names, so they must be a safe, single path segment.
LAB_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# The fixed topology layout of a lab, stored next to lab.conf/lab.ext/lab.dep so it travels with the
# lab directory (zip download/upload, git, server restarts). JSON body; unknown to Kathara itself and
# ignored by this project's lab.conf/folder parser (see lab_import.translate_lab_files).
LAYOUT_FILENAME = "lab.layout"

LAB_CONF_FILENAME = "lab.conf"

# A lab.conf is a handful of lines; this is a sanity ceiling on what a hand-dropped file in the
# labs directory will be read back as (cf. LAYOUT_MAX_NODES in schemas/lab.py), not a limit any
# generated or legitimately-imported file could ever approach.
MAX_LAB_CONF_BYTES = 1 << 20

# Meta keys handled generically as scalar `machine[key]="value"` lines (in this order).
_SCALAR_META_ORDER = (
    "mem", "cpus", "shell", "ipv6", "privileged", "bridged", "num_terms", "entrypoint", "args",
)

# Meta keys already emitted explicitly above (scalars) or by the container-typed loops below, plus
# `bridged_iface`, which the manager derives at deploy time rather than something authored in
# lab.conf. Everything else in `device.meta` is a pass-through option (see
# `lab_builder.apply_options`) and gets its own `name[key]="value"` line, sorted for stability.
_KNOWN_META_KEYS = frozenset(_SCALAR_META_ORDER) | {
    "image", "exec_commands", "ports", "envs", "sysctls", "ulimits", "volumes", "bridged_iface",
}


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
    image = meta.get("image")
    lines.append(f'{name}[image]="{image if image else "kathara/base"}"')

    for key in _SCALAR_META_ORDER:
        value = meta.get(key)
        if value not in (None, "", False):
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
    for key in sorted(set(meta) - _KNOWN_META_KEYS):
        lines.append(f'{name}[{key}]={conf_value(meta[key])}')

    return lines


def gen_lab_conf(lab: Lab) -> str:
    """Serialize a populated ``Lab`` back into ``lab.conf`` text.

    Round-trips through both this project's parser (``lab_import.parse_lab_conf``) and Kathara's
    own ``LabParser``. MACs are only appended when set (no trailing ``/None``), lab metadata lines
    are emitted, and container-typed metas (envs/sysctls/ports/ulimits/volumes/exec) are expanded
    into their proper one-line-each directives.

    The only remaining caller of this generator is ``create_lab`` (a JSON-described lab has no
    source ``lab.conf`` to preserve). Every other path — import, upload, editor save, structural
    edits — persists the lab's ``lab.conf`` verbatim instead; see ``LabStore.write_lab_conf_text``.
    """
    lines: list[str] = []

    metadata = [
        ("LAB_NAME", lab.name),
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
    """Reads and writes labs as directories under a single storage root."""

    def __init__(self, root: Union[str, Path]) -> None:
        self.root = Path(root)

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

    def write_lab(self, name: str, files: dict[str, Union[str, bytes]], dirs: list[str] | None = None) -> Path:
        """Write a lab directory verbatim from a path->content map, atomically.

        Content is written into a sibling ``.<name>.tmp`` dir and then ``os.replace``d onto the final
        path, so a crash mid-write never leaves a half-populated lab directory.
        """
        name = sanitize_lab_name(name)
        self.ensure_root()
        final = self.lab_dir(name)
        tmp = self.root / f".{name}.tmp"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)
        try:
            for rel, content in files.items():
                self._write_file(tmp, rel, content)
            for rel_dir in dirs or []:
                self._safe_join(tmp, rel_dir).mkdir(parents=True, exist_ok=True)
            if final.exists():
                shutil.rmtree(final)
            os.replace(tmp, final)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return final

    def read_lab(self, path: Union[str, Path]) -> tuple[dict[str, str], list[str]]:
        """Read a lab directory back into a text path->content map plus empty-dir list.

        Binary files are skipped (they can't be represented in the text-based pending model used
        for queued-but-not-yet-deployed state); the native-fs deploy path reads binaries straight
        off disk instead.
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
                rel = os.path.relpath(abs_path, base).replace(os.sep, "/")
                try:
                    files[rel] = abs_path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, ValueError):
                    continue  # binary file — not representable as text here
        return files, dirs

    def write_lab_conf(self, lab_dir: Path, lab: Lab) -> None:
        """Regenerate and (over)write ``lab_dir/lab.conf`` from ``lab`` (see ``gen_lab_conf``)."""
        self._atomic_write_text(lab_dir / LAB_CONF_FILENAME, gen_lab_conf(lab))

    def lab_conf_path(self, name: str) -> Path:
        return self.lab_dir(name) / LAB_CONF_FILENAME  # lab_dir sanitizes the name

    def read_lab_conf_text(self, name: str) -> Optional[str]:
        """Verbatim ``lab.conf`` text for ``name``, or ``None`` when the lab has no such file.

        Reads bytes and decodes explicitly rather than ``Path.read_text`` — which performs
        universal-newline translation — so a CRLF file comes back exactly as written; a surgical
        edit (``lab_conf_edit``) must be able to put back, byte for byte, every line it did not
        touch. A file that is oversized or not valid UTF-8 is treated as "nothing editable here"
        (``None``) rather than raising, mirroring ``read_lab``'s own binary-file handling.
        """
        path = self.lab_conf_path(name)
        if not path.is_file():
            return None
        try:
            data = path.read_bytes()
        except OSError:
            logger.warning("Could not read %s for lab `%s`", LAB_CONF_FILENAME, name, exc_info=True)
            return None
        if len(data) > MAX_LAB_CONF_BYTES:
            logger.warning("Ignoring oversized %s for lab `%s` (%d bytes)", LAB_CONF_FILENAME, name, len(data))
            return None
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            logger.warning("Ignoring non-UTF-8 %s for lab `%s`", LAB_CONF_FILENAME, name)
            return None

    def write_lab_conf_text(self, name: str, text: str) -> Path:
        """Write ``lab.conf`` verbatim and atomically (tmp file + ``os.replace``).

        Used by every path that must preserve the caller's exact bytes — an import/upload's
        source file, an editor save, a surgical structural edit — as opposed to ``write_lab_conf``,
        which regenerates the file from a ``Lab`` model (lossy, and only still used by
        ``create_lab`` for JSON-described labs that have no source file to preserve).
        """
        directory = self.lab_dir(name)  # sanitizes name
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{name}` not found.")
        final = directory / LAB_CONF_FILENAME
        self._atomic_write_text(final, text)
        return final

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

    def layout_path(self, name: str) -> Path:
        return self.lab_dir(name) / LAYOUT_FILENAME  # lab_dir sanitizes the name

    def read_layout(self, name: str) -> Optional[dict[str, Any]]:
        """Parsed ``lab.layout``, or ``None`` when absent/unreadable/not an object.

        A hand-edited or truncated layout file must never break the topology view, so parse errors
        are logged and treated the same as "no layout".
        """
        path = self.layout_path(name)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Ignoring unreadable %s for lab `%s`", LAYOUT_FILENAME, name, exc_info=True)
            return None
        if not isinstance(data, dict):
            logger.warning("Ignoring %s for lab `%s`: not a JSON object", LAYOUT_FILENAME, name)
            return None
        return data

    def write_layout(self, name: str, data: dict[str, Any]) -> Path:
        """Write ``lab.layout`` atomically (tmp file + ``os.replace``), or raise ``LabNotFoundError``."""
        directory = self.lab_dir(name)  # sanitizes name
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{name}` not found.")
        final = directory / LAYOUT_FILENAME
        tmp = directory / f".{LAYOUT_FILENAME}.tmp"
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, final)
        return final

    def delete_layout(self, name: str) -> bool:
        """Remove ``lab.layout`` if present; returns whether a file was actually removed."""
        path = self.layout_path(name)
        if not path.is_file():
            return False
        path.unlink()
        return True

    def delete_lab(self, name: str) -> None:
        directory = self.lab_dir(name)
        if directory.exists():
            shutil.rmtree(directory)

    def rename_lab(self, old_name: str, new_name: str) -> Path:
        """Rename a lab directory in place — the lab's name *is* its directory name.

        Everything the lab owns travels with the directory (``lab.conf`` verbatim, device folders,
        startup scripts, ``lab.layout``), so nothing is rewritten. Both names are sanitized, so the
        rename can never escape the storage root, and ``os.rename`` within it is atomic. Refuses to
        clobber an existing lab; renaming to the same name is a no-op.
        """
        old_clean = sanitize_lab_name(old_name)
        new_clean = sanitize_lab_name(new_name)
        source = self.lab_dir(old_clean)
        if not source.is_dir():
            raise LabNotFoundError(f"Lab `{old_clean}` not found.")
        if new_clean == old_clean:
            return source
        target = self.lab_dir(new_clean)
        if target.exists():
            raise LabAlreadyRegisteredError(f"Lab `{new_clean}` already exists.")
        os.rename(source, target)
        return target

    def extract_zip(self, name: str, data: BinaryIO) -> Path:
        """Extract an uploaded .zip into ``<root>/<name>/``, binary-safe and zip-slip-safe.

        Every member's *content* is extracted verbatim (empty directories are created, not
        skipped, and each file's Unix permission bits — e.g. an executable startup script — are
        restored from the archive). A single common wrapper folder (``mylab/lab.conf`` →
        ``lab.conf``) is the one deliberate exception: it is stripped, and the lab root is
        re-anchored on whichever directory actually contains ``lab.conf``, so *paths* may shift
        even though every file's *bytes and mode* never do.
        """
        name = sanitize_lab_name(name)
        self.ensure_root()
        final = self.lab_dir(name)
        tmp = self.root / f".{name}.tmp"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)
        try:
            # Read fully into a real BytesIO rather than handing zipfile the raw upload object:
            # FastAPI backs `UploadFile.file` with a `SpooledTemporaryFile`, which on Python < 3.11
            # has no `seekable()` (added in gh-95913) — zipfile's `_SharedFile` reads that attribute
            # unconditionally, so `zipfile.ZipFile(data)` crashes with an AttributeError on 3.10.
            # BytesIO always satisfies the full file-like protocol, on every supported Python version.
            with zipfile.ZipFile(io.BytesIO(data.read())) as archive:
                for member in archive.infolist():
                    rel = member.filename.lstrip("/")
                    if not rel:
                        continue
                    if member.is_dir():
                        self._safe_join(tmp, rel).mkdir(parents=True, exist_ok=True)
                        continue
                    target = self._safe_join(tmp, rel)  # rejects zip-slip (../ escapes)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                    # The upper 16 bits of external_attr hold the Unix mode when the archive was
                    # created on a Unix system (create_system == 3); 0 there means "no permission
                    # bits recorded" (e.g. a Windows-authored zip), so leave the OS default alone.
                    mode = member.external_attr >> 16
                    if mode:
                        os.chmod(target, mode)
            lab_root = self._find_lab_root(tmp)
            if final.exists():
                shutil.rmtree(final)
            if lab_root == tmp:
                os.replace(tmp, final)
            else:
                os.replace(lab_root, final)
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        return final

    def zip_lab(self, name: str) -> io.BytesIO:
        """Zip the lab's on-disk directory into an in-memory buffer, or raise ``LabNotFoundError``.

        Files are stored at the archive root (``lab.conf``, ``pc1.startup``, ``pc1/…``), so a plain
        ``unzip`` and this store's own ``extract_zip`` both round-trip the result cleanly.
        """
        directory = self.lab_dir(name)  # sanitizes name
        if not directory.is_dir():
            raise LabNotFoundError(f"Lab `{name}` not found.")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            for root, _dirs, files in os.walk(directory):
                for filename in files:
                    abs_path = Path(root) / filename
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

    @staticmethod
    def _safe_join(base: Path, rel: str) -> Path:
        """Join ``rel`` under ``base``, rejecting any path that escapes it (zip-slip / traversal)."""
        base_resolved = base.resolve()
        target = (base_resolved / rel).resolve()
        if target != base_resolved and base_resolved not in target.parents:
            raise ApiError(f"Unsafe path in lab archive: {rel!r}")
        return target

    @staticmethod
    def _find_lab_root(base: Path) -> Path:
        """Locate the directory that is the actual lab root within a freshly extracted tree."""
        if (base / "lab.conf").exists():
            return base
        subdirs = [p for p in base.iterdir() if p.is_dir()]
        files = [p for p in base.iterdir() if p.is_file()]
        if len(subdirs) == 1 and not files:
            # Single wrapper folder — with or without a lab.conf (folder-based lab).
            return subdirs[0]
        return base
