"""Surgical, line-level edits to ``lab.conf`` text.

Every offline structural edit used to rebuild an in-memory ``Lab`` from disk and re-serialize the
whole file with ``lab_store.gen_lab_conf``, which silently dropped everything the IDE's model does
not carry: comments, line ordering, quoting style, ``[volume]``/``[num_terms]``/``[entrypoint]``/
``[args]`` and any option this API doesn't interpret. Every function here instead takes the file's
full text and returns it with only the lines it must touch changed — anything else, including
lines this project's own parser only warns about, survives byte for byte.

Line classification is delegated to ``lab_import``'s own regex/constants (``CONF_LINE_RE``,
``LAB_META_KEYS``, ``RESERVED_NAMES``), so this module can never disagree with the parser about
what a line means. Every public operation re-parses (and, for structural changes, rebuilds) its
own result and refuses to return text that would not load back — see ``validate``.
"""

import re
from dataclasses import dataclass
from enum import Enum, auto
from typing import Optional

from Kathara.exceptions import MachineAlreadyExistsError, MachineCollisionDomainError, MachineNotFoundError
from Kathara.model.Lab import Lab

from ..errors import ApiError
from ..schemas.machine import MachineCreate, MachineUpdate
from . import lab_builder, lab_import, lab_store


class _Kind(Enum):
    BLANK = auto()
    COMMENT = auto()
    INTERFACE = auto()
    META = auto()
    LAB_META = auto()
    OTHER = auto()


@dataclass
class _Line:
    """One physical line of a ``lab.conf`` file, classified and, for a directive line, taken apart
    into the pieces ``CONF_LINE_RE`` matched — enough to reassemble it byte-for-byte, or to rewrite
    only the one token an edit needs to change."""

    raw: str
    kind: _Kind
    indent: str = ""
    trailer: str = ""
    device: Optional[str] = None
    arg: Optional[str] = None
    number: Optional[int] = None
    quote: str = ""
    value: Optional[str] = None
    comment: str = ""

    def render(self) -> str:
        if self.kind in (_Kind.INTERFACE, _Kind.META):
            body = f"{self.device}[{self.arg}]={self.quote}{self.value}{self.quote}{self.comment}"
            return f"{self.indent}{body}{self.trailer}"
        if self.kind == _Kind.LAB_META:
            # `self.value` already carries its own quote characters as literal text (mirroring
            # _classify, which never splits a LAB_META value into separate quote/inner parts —
            # there's nothing else to reassemble here, unlike the bracketed directive lines above).
            return f"{self.indent}{self.device}={self.value}{self.trailer}"
        return self.raw


def _classify(raw: str) -> _Line:
    stripped = raw.strip()
    if not stripped:
        return _Line(raw=raw, kind=_Kind.BLANK)
    if stripped.startswith("#"):
        return _Line(raw=raw, kind=_Kind.COMMENT)

    indent = raw[: len(raw) - len(raw.lstrip())]
    trailer = raw[len(raw.rstrip()) :] if raw.strip() else ""

    m = lab_import.CONF_LINE_RE.match(stripped)
    if m:
        device, arg, quote, value, comment = m.group(1), m.group(2), m.group(3) or "", m.group(4), m.group(5) or ""
        if arg.isdigit():
            return _Line(
                raw=raw, kind=_Kind.INTERFACE, indent=indent, trailer=trailer,
                device=device, arg=arg, number=int(arg), quote=quote, value=value, comment=comment,
            )
        return _Line(
            raw=raw, kind=_Kind.META, indent=indent, trailer=trailer,
            device=device, arg=arg, quote=quote, value=value, comment=comment,
        )

    eq = stripped.find("=")
    key = stripped[:eq].strip() if eq >= 0 else stripped
    if eq > 0 and key in lab_import.LAB_META_KEYS:
        return _Line(
            raw=raw, kind=_Kind.LAB_META, indent=indent, trailer=trailer,
            device=key, value=stripped[eq + 1 :],
        )
    return _Line(raw=raw, kind=_Kind.OTHER)


def _split_text(text: str) -> tuple[list[str], str, bool]:
    """Split ``text`` into physical lines plus enough information to reassemble it exactly:
    the dominant line terminator (CRLF if any line uses it, else LF) and whether the text ended
    with a trailing newline at all."""
    terminator = "\r\n" if "\r\n" in text else "\n"
    trailing_newline = text.endswith(("\n", "\r"))
    body = text[:-1] if trailing_newline and not text.endswith("\r\n") else text
    if trailing_newline and text.endswith("\r\n"):
        body = text[:-2]
    lines = re.split(r"\r\n|\r|\n", body) if body or not trailing_newline else []
    if body == "" and trailing_newline:
        lines = [""]
    return lines, terminator, trailing_newline


class LabConfDoc:
    """A ``lab.conf`` as an editable list of classified physical lines.

    ``render()`` of a document that was never mutated is byte-identical to the text it was built
    from, including CRLF line endings and a missing final newline.
    """

    def __init__(self, text: str) -> None:
        raw_lines, self._terminator, self._trailing_newline = _split_text(text)
        self._lines: list[_Line] = [_classify(line) for line in raw_lines]

    def render(self) -> str:
        body = self._terminator.join(line.render() for line in self._lines)
        if self._trailing_newline and not (len(self._lines) == 1 and self._lines[0].kind == _Kind.BLANK and self._lines[0].raw == ""):
            body += self._terminator
        elif self._trailing_newline:
            body = self._terminator
        return body

    # -- read-only index --------------------------------------------------

    def device_names(self) -> list[str]:
        seen: dict[str, None] = {}
        for line in self._lines:
            if line.kind in (_Kind.INTERFACE, _Kind.META) and line.device not in seen:
                seen[line.device] = None
        return list(seen.keys())

    def has_device(self, device: str) -> bool:
        return any(line.kind in (_Kind.INTERFACE, _Kind.META) and line.device == device for line in self._lines)

    def _device_line_indices(self, device: str) -> list[int]:
        return [
            i for i, line in enumerate(self._lines)
            if line.kind in (_Kind.INTERFACE, _Kind.META) and line.device == device
        ]

    def _interface_line_indices(self, device: str) -> list[int]:
        return [
            i for i, line in enumerate(self._lines)
            if line.kind == _Kind.INTERFACE and line.device == device
        ]

    def _meta_line_indices(self, device: str) -> list[int]:
        return [
            i for i, line in enumerate(self._lines)
            if line.kind == _Kind.META and line.device == device
        ]

    def interface_links(self, device: str) -> dict[int, str]:
        """``{interface number: collision domain name}`` for ``device`` (MAC suffix stripped)."""
        out: dict[int, str] = {}
        for i in self._interface_line_indices(device):
            line = self._lines[i]
            cd = line.value.split("/", 1)[0] if line.value else line.value
            out[line.number] = cd
        return out

    def next_interface_number(self, device: str) -> int:
        return len(self._interface_line_indices(device))

    def meta_line_indices(self, device: str, key: str) -> list[int]:
        return [i for i in self._meta_line_indices(device) if self._lines[i].arg == key]

    def lab_meta_line_indices(self, key: str) -> list[int]:
        return [i for i, line in enumerate(self._lines) if line.kind == _Kind.LAB_META and line.device == key]

    # -- mutators -----------------------------------------------------------

    def insert_device_block(self, lines: list[str]) -> None:
        """Append a new device block at the end of the file, preceded by a single blank
        separator line if the file doesn't already end in one."""
        if self._lines and self._lines[-1].kind != _Kind.BLANK:
            self._lines.append(_Line(raw="", kind=_Kind.BLANK))
        elif not self._lines:
            pass
        for raw in lines:
            self._lines.append(_classify(raw))
        self._trailing_newline = True

    def _remove_indices(self, indices: set[int]) -> None:
        if not indices:
            return
        sorted_idx = sorted(indices)
        # Collapse a blank line this deletion would double up: for each maximal contiguous run of
        # removed indices, if the lines immediately before and after the run are both blank, drop
        # the one after too (or the one before, if the run reaches end of file). A run starting at
        # index 0 has no "before" line at all, so an after-blank there is a leading blank once the
        # run is gone — collapse it the same way as the end-of-file case.
        runs: list[list[int]] = []
        for i in sorted_idx:
            if runs and runs[-1][-1] == i - 1:
                runs[-1].append(i)
            else:
                runs.append([i])
        extra: set[int] = set()
        for run in runs:
            before, after = run[0] - 1, run[-1] + 1
            before_blank = before >= 0 and before not in indices and self._lines[before].kind == _Kind.BLANK
            after_blank = after < len(self._lines) and after not in indices and self._lines[after].kind == _Kind.BLANK
            if after_blank and (before_blank or after == len(self._lines) - 1 or run[0] == 0):
                extra.add(after)
            elif before_blank and after >= len(self._lines):
                extra.add(before)
        all_removed = indices | extra
        self._lines = [line for i, line in enumerate(self._lines) if i not in all_removed]

    def delete_device(self, device: str) -> None:
        self._remove_indices(set(self._device_line_indices(device)))

    def _quote_from(self, index: Optional[int]) -> str:
        # `""` (unquoted) is a legitimate quote style copied from a real anchor line — only the
        # "no anchor at all" case falls back to a default, so this must not `or`-coalesce an
        # empty-but-valid quote into the default.
        if index is None:
            return '"'
        return self._lines[index].quote

    def insert_interface(self, device: str, number: int, link: str, mac_address: Optional[str] = None) -> None:
        value = f"{link}/{mac_address}" if mac_address else link
        iface_idx = self._interface_line_indices(device)
        meta_idx = self._meta_line_indices(device)
        if iface_idx:
            anchor = max(iface_idx, key=lambda i: self._lines[i].number)
            quote = self._quote_from(anchor)
            indent = self._lines[anchor].indent
            insert_at = anchor + 1
        elif meta_idx:
            anchor = min(meta_idx)
            quote = self._quote_from(anchor)
            indent = self._lines[anchor].indent
            insert_at = anchor
        else:
            quote = '"'
            indent = ""
            insert_at = len(self._lines)
        new_line = _Line(
            raw="", kind=_Kind.INTERFACE, indent=indent, device=device,
            arg=str(number), number=number, quote=quote, value=value,
        )
        self._lines.insert(insert_at, new_line)

    def remove_interface(self, device: str, link: str) -> Optional[int]:
        for i in self._interface_line_indices(device):
            line = self._lines[i]
            cd = line.value.split("/", 1)[0] if line.value else line.value
            if cd == link:
                removed_number = line.number
                self._remove_indices({i})
                return removed_number
        return None

    def renumber_interfaces(self, device: str) -> None:
        indices = self._interface_line_indices(device)
        for new_number, i in enumerate(sorted(indices, key=lambda i: self._lines[i].number)):
            self._lines[i].arg = str(new_number)
            self._lines[i].number = new_number

    def set_meta(self, device: str, key: str, rendered_value: str, quote: str) -> None:
        existing = self.meta_line_indices(device, key)
        if existing:
            i = existing[-1]
            self._lines[i].quote = quote
            self._lines[i].value = rendered_value
            return
        dev_lines = self._device_line_indices(device)
        insert_at = (max(dev_lines) + 1) if dev_lines else len(self._lines)
        indent = self._lines[dev_lines[-1]].indent if dev_lines else ""
        self._lines.insert(
            insert_at,
            _Line(raw="", kind=_Kind.META, indent=indent, device=device, arg=key, quote=quote, value=rendered_value),
        )

    def unset_meta(self, device: str, key: str) -> None:
        self._remove_indices(set(self.meta_line_indices(device, key)))

    def set_meta_group(self, device: str, key: str, values: list[str]) -> None:
        """Replace every ``device[key]=...`` line with exactly one line per ``values``, in order,
        always double-quoted (matching ``lab_store.gen_device_lines``' convention for the
        container-typed metas: ports/envs/sysctls/ulimits/volumes/exec commands). Unlike
        ``set_meta``, which can only ever hold one line per key, this is for a key that
        legitimately repeats N times — N old lines in, N new lines out, replaced in place rather
        than deleted-then-appended, so a hand-edited file's group doesn't relocate to the end of
        the block on every save.

        Removal goes through ``_remove_indices`` (not a raw slice) so an emptied group gets the
        same double-blank-line collapsing every other removal in this class gets. Because that can
        remove more lines than just this key's own (an adjacent now-redundant blank), the insertion
        point for the replacement lines is tracked by *line object identity* rather than a
        precomputed numeric index, which `_remove_indices` would otherwise invalidate.
        """
        existing = self.meta_line_indices(device, key)
        existing_set = set(existing)

        if not values:
            self._remove_indices(existing_set)
            return

        insert_at_end = False
        anchor_line: Optional[_Line] = None
        if existing:
            anchor_idx = min(existing) - 1
            if anchor_idx >= 0:
                anchor_line = self._lines[anchor_idx]
            indent = self._lines[min(existing)].indent
        else:
            dev_lines = self._device_line_indices(device)
            if dev_lines:
                anchor_line = self._lines[dev_lines[-1]]
                indent = anchor_line.indent
            else:
                insert_at_end = True
                indent = ""

        self._remove_indices(existing_set)

        if insert_at_end:
            insert_at = len(self._lines)
        elif anchor_line is None:
            insert_at = 0
        else:
            insert_at = next(i for i, line in enumerate(self._lines) if line is anchor_line) + 1

        new_lines = [
            _Line(raw="", kind=_Kind.META, indent=indent, device=device, arg=key, quote='"', value=value)
            for value in values
        ]
        self._lines[insert_at:insert_at] = new_lines

    def device_meta_keys(self, device: str) -> set[str]:
        """Every distinct ``[key]`` currently used by ``device``'s META-kind lines."""
        return {self._lines[i].arg for i in self._meta_line_indices(device)}

    def set_lab_metadata(self, key: str, rendered_value: Optional[str]) -> None:
        existing = self.lab_meta_line_indices(key)
        if rendered_value is None:
            self._remove_indices(set(existing))
            return
        if existing:
            i = existing[-1]
            self._lines[i].value = rendered_value
            return
        all_lab_meta = [i for i, line in enumerate(self._lines) if line.kind == _Kind.LAB_META]
        insert_at = (max(all_lab_meta) + 1) if all_lab_meta else 0
        self._lines.insert(insert_at, _Line(raw="", kind=_Kind.LAB_META, device=key, value=rendered_value))


# -- module-level operations --------------------------------------------------


def parse_errors(text: str) -> list[str]:
    """Whether ``text`` would fail to parse — ``lab_import.parse_lab_conf(text).errors``."""
    return lab_import.parse_lab_conf(text).errors


def validate(text: str) -> None:
    """Raise unless ``text`` both parses and builds a working ``Lab`` — the same two steps the
    restart path runs (``KatharaService._translate_lab_dir`` / ``_reload_lab_from_disk``). An
    edit that fails this would make the lab unloadable, so it is refused instead of written.
    """
    t = lab_import.translate_lab_files({"lab.conf": text}, "_lab_conf_edit_validate")
    if t.errors:
        raise ApiError("This edit would leave lab.conf unloadable: " + "; ".join(t.errors))
    lab_builder.build_lab(t.payload)


def device_names(text: str) -> list[str]:
    return LabConfDoc(text).device_names()


def interface_links(text: str, device: str) -> dict[int, str]:
    return LabConfDoc(text).interface_links(device)


def next_interface_number(text: str, device: str) -> int:
    return LabConfDoc(text).next_interface_number(device)


def _render_device_block(spec: MachineCreate) -> list[str]:
    """Render a new device's ``lab.conf`` lines from a ``MachineCreate`` spec, reusing
    ``lab_store.gen_device_lines`` (the same formatter that renders a whole generated file) so a
    device appended here looks exactly like one ``gen_lab_conf`` would have written."""
    scratch = Lab("_lab_conf_edit_scratch")
    machine = lab_builder.build_machine(scratch, spec)
    return lab_store.gen_device_lines(machine)


def add_device(text: str, spec: MachineCreate) -> str:
    """Append a new device block, rendered from ``spec``, at the end of the file.

    Raises ``MachineAlreadyExistsError`` if the device already has any line in the file,
    ``ApiError`` for a reserved name or a spec whose result wouldn't load back (e.g. non-sequential
    interface numbers).
    """
    doc = LabConfDoc(text)
    if doc.has_device(spec.name):
        raise MachineAlreadyExistsError(f"Device `{spec.name}` already exists.")
    if spec.name in lab_import.RESERVED_NAMES:
        raise ApiError(f"`{spec.name}` is a reserved name, it can't be used for a device.")
    doc.insert_device_block(_render_device_block(spec))
    new_text = doc.render()
    validate(new_text)
    return new_text


def remove_device(text: str, device: str) -> str:
    """Delete every line belonging to ``device`` — including lines interleaved into other
    devices' blocks. Comment lines are never deleted. Unknown device: returns ``text`` unchanged.
    """
    doc = LabConfDoc(text)
    if not doc.has_device(device):
        return text
    doc.delete_device(device)
    return doc.render()


def add_interface(text: str, device: str, number: Optional[int], link: str, mac_address: Optional[str] = None) -> str:
    """Insert one ``device[number]="link"`` (or ``"link/mac"``) line next to the device's existing
    interface lines, matching their quoting style. ``number=None`` picks the next free slot.

    Raises ``MachineNotFoundError`` for an unknown device and ``MachineCollisionDomainError`` when
    ``number`` is already taken or the device is already attached to ``link``. A ``number`` that
    leaves a gap is refused by the final ``validate`` call.
    """
    doc = LabConfDoc(text)
    if not doc.has_device(device):
        raise MachineNotFoundError(f"Device `{device}` not found.")
    links = doc.interface_links(device)
    if number is None:
        number = doc.next_interface_number(device)
    if number in links:
        raise MachineCollisionDomainError(f"Device `{device}` already has an interface number {number}.")
    if link in links.values():
        raise MachineCollisionDomainError(f"Device `{device}` is already connected to `{link}`.")
    doc.insert_interface(device, number, link, mac_address)
    new_text = doc.render()
    validate(new_text)
    return new_text


def remove_interface(text: str, device: str, link: str, *, renumber: bool = True) -> str:
    """Delete ``device``'s interface line for collision domain ``link`` and, by default, renumber
    its higher-numbered interfaces down so numbering stays sequential from 0 (a gap is an error
    for both this project's parser and Kathara's own ``Machine.check``, so a bare line delete
    would leave a ``lab.conf`` that can no longer be loaded or deployed). Unknown device/link:
    returns ``text`` unchanged.
    """
    doc = LabConfDoc(text)
    if not doc.has_device(device):
        return text
    removed = doc.remove_interface(device, link)
    if removed is None:
        return text
    if renumber:
        doc.renumber_interfaces(device)
    return doc.render()


def renumber_interfaces(text: str, device: str) -> str:
    """Compact ``device``'s interface numbers to ``0..n-1`` in place, preserving their relative
    order. Idempotent — a repair for hand-written or previously-corrupted files."""
    doc = LabConfDoc(text)
    if not doc.has_device(device):
        return text
    doc.renumber_interfaces(device)
    return doc.render()


def set_meta(text: str, device: str, key: str, value) -> str:
    """Set ``device[key]=value``. Rewrites the last existing occurrence in place, or appends one
    at the end of the device's lines. Rejects a value containing a quote character (unrepresentable
    in ``lab.conf`` — see ``lab_store.conf_value``)."""
    doc = LabConfDoc(text)
    rendered = lab_store.conf_value(value)
    quote = '"' if rendered.startswith('"') else ""
    inner = rendered.strip('"') if quote else rendered
    doc.set_meta(device, key, inner, quote)
    new_text = doc.render()
    validate(new_text)
    return new_text


def unset_meta(text: str, device: str, key: str) -> str:
    """Remove all ``device[key]=…`` lines. Absent: unchanged."""
    doc = LabConfDoc(text)
    if not doc.has_device(device):
        return text
    doc.unset_meta(device, key)
    return doc.render()


# Scalar meta keys, and the six keys that repeat (one line per list/dict entry) — used by
# `replace_device_options` to know which lines are "modeled" (so anything else left on the device
# is a pass-through `metas` entry, not one this function forgot to handle).
_SCALAR_OPTION_KEYS = (
    "image", "mem", "cpus", "shell", "num_terms", "entrypoint", "args", "bridged", "privileged", "ipv6",
)
_GROUP_OPTION_KEYS = ("exec", "port", "env", "sysctl", "ulimit", "volume")


def _set_scalar(doc: "LabConfDoc", device: str, key: str, value) -> None:
    if value is None or value == "":
        doc.unset_meta(device, key)
        return
    rendered = lab_store.conf_value(value)
    quote = '"' if rendered.startswith('"') else ""
    inner = rendered.strip('"') if quote else rendered
    doc.set_meta(device, key, inner, quote)


def replace_device_options(text: str, device: str, spec: MachineUpdate) -> str:
    """Rewrite every lab.conf line this API models for ``device`` to match ``spec`` exactly — the
    machine-options analogue of ``add_device``, but for an existing device's block instead of a
    new one. Interface lines, comments, and every other device's lines are left untouched.

    Raises ``MachineNotFoundError`` if ``device`` has no lines in ``text`` at all.
    """
    doc = LabConfDoc(text)
    if not doc.has_device(device):
        raise MachineNotFoundError(f"Device `{device}` not found.")

    # `image` is always written, quoted, falling back to Kathara's own default — mirrors
    # `gen_device_lines`'s literal `name[image]="value"` line exactly (not run through
    # `conf_value`'s conditional quoting, which would leave an image name with no whitespace
    # unquoted and diverge from what a freshly created device's block looks like). Every other
    # scalar is omitted entirely when falsy, mirroring `gen_device_lines`' `value not in (None,
    # "", False)` guard: a boolean like `bridged`/`privileged`/`ipv6` set to False is
    # indistinguishable from "never set" in this project's own generator, so writing it explicitly
    # would be inconsistent with a freshly created device.
    doc.set_meta(device, "image", spec.image or "kathara/base", '"')
    _set_scalar(doc, device, "mem", spec.mem)
    _set_scalar(doc, device, "cpus", spec.cpus)
    _set_scalar(doc, device, "shell", spec.shell)
    _set_scalar(doc, device, "num_terms", spec.num_terms)
    _set_scalar(doc, device, "entrypoint", spec.entrypoint)
    _set_scalar(doc, device, "args", spec.args)
    _set_scalar(doc, device, "bridged", True if spec.bridged else None)
    _set_scalar(doc, device, "privileged", True if spec.privileged else None)
    _set_scalar(doc, device, "ipv6", True if spec.ipv6 else None)

    groups = {
        "exec": list(spec.exec_commands),
        "port": [lab_builder._format_port(p) for p in spec.ports],
        "env": [f"{k}={v}" for k, v in spec.envs.items()],
        "sysctl": [f"{k}={v}" for k, v in spec.sysctls.items()],
        "ulimit": [lab_builder._format_ulimit(u) for u in spec.ulimits],
        "volume": [lab_builder._format_volume(v) for v in spec.volumes],
    }
    for key, values in groups.items():
        doc.set_meta_group(device, key, values)

    # Anything left on the device that isn't one of the keys just handled above is a pass-through
    # `metas` entry (an option this API doesn't model explicitly) — reconcile it against `spec.metas`
    # rather than leaving stale ones behind or dropping ones the caller didn't touch.
    modeled = set(_SCALAR_OPTION_KEYS) | set(_GROUP_OPTION_KEYS)
    existing_passthrough = doc.device_meta_keys(device) - modeled
    for stale_key in existing_passthrough - set(spec.metas):
        doc.unset_meta(device, stale_key)
    for key, value in spec.metas.items():
        _set_scalar(doc, device, key, value)

    new_text = doc.render()
    validate(new_text)
    return new_text


def set_lab_metadata(text: str, key: str, value: Optional[str]) -> str:
    """Set/replace a ``LAB_*`` line (``key`` must be one of ``lab_import.LAB_META_KEYS``);
    ``value`` of ``None`` or ``""`` removes every occurrence."""
    if key not in lab_import.LAB_META_KEYS:
        raise ApiError(f"`{key}` is not a recognized lab.conf metadata key.")
    doc = LabConfDoc(text)
    rendered = None if not value else lab_store.conf_value(value).strip('"')
    quoted = None if rendered is None else f'"{rendered}"'
    doc.set_lab_metadata(key, quoted)
    new_text = doc.render()
    validate(new_text)
    return new_text
