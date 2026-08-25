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

from ..errors import ApiError

logger = logging.getLogger("kathara_api")

# Lab names double as directory names, so they must be a safe, single path segment.
LAB_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# The fixed topology layout of a lab, stored next to lab.conf/lab.ext/lab.dep so it travels with the
# lab directory (zip download/upload, git, server restarts). JSON body; unknown to Kathara itself and
# ignored by this project's lab.conf/folder parser (see lab_import.translate_lab_files).
LAYOUT_FILENAME = "lab.layout"

# Meta keys handled generically as scalar `machine[key]="value"` lines (in this order).
_SCALAR_META_ORDER = ("mem", "cpus", "shell", "ipv6", "privileged", "bridged", "num_terms")


def sanitize_lab_name(name: str) -> str:
    """Validate a lab name as a safe single path segment, or raise ``ApiError``."""
    candidate = (name or "").strip()
    if candidate in (".", "..") or "/" in candidate or "\\" in candidate or not LAB_NAME_RE.match(candidate):
        raise ApiError(
            f"Invalid lab name `{name}`. Use letters, digits, dot, dash or underscore (max 64 chars)."
        )
    return candidate


def gen_lab_conf(lab: Lab) -> str:
    """Serialize a populated ``Lab`` back into ``lab.conf`` text.

    Round-trips through both this project's parser (``lab_import.parse_lab_conf``) and Kathara's
    own ``LabParser``. MACs are only appended when set (no trailing ``/None``), lab metadata lines
    are emitted, and container-typed metas (envs/sysctls/ports/ulimits/volumes/exec) are expanded
    into their proper one-line-each directives.
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
            lines.append(f'{key}="{value}"')
            wrote_meta = True
    if wrote_meta:
        lines.append("")

    for device in lab.machines.values():
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
                lines.append(f'{name}[{key}]="{value}"')

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
        (lab_dir / "lab.conf").write_text(gen_lab_conf(lab), encoding="utf-8")

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

    def extract_zip(self, name: str, data: BinaryIO) -> Path:
        """Extract an uploaded .zip into ``<root>/<name>/``, binary-safe and zip-slip-safe.

        A single common wrapper folder (``mylab/lab.conf`` → ``lab.conf``) is stripped, and the lab
        root is re-anchored on whichever directory actually contains ``lab.conf``.
        """
        name = sanitize_lab_name(name)
        self.ensure_root()
        final = self.lab_dir(name)
        tmp = self.root / f".{name}.tmp"
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)
        try:
            with zipfile.ZipFile(data) as archive:
                for member in archive.infolist():
                    if member.is_dir():
                        continue
                    rel = member.filename.lstrip("/")
                    if not rel:
                        continue
                    target = self._safe_join(tmp, rel)  # rejects zip-slip (../ escapes)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as src, open(target, "wb") as dst:
                        shutil.copyfileobj(src, dst)
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
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")

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
