"""Parse a standard Kathara lab directory (lab.conf/.startup/folders) into a LabCreate
plus a per-machine "pending" file/startup spec applied after deploy.

Everything a device carries here is kept verbatim: ``<machine>.startup`` is passed through
unmodified (Kathara's native deploy already runs ``shared.startup`` then ``<machine>.startup``
then any ``exec`` directives on its own — see ``DockerMachine.STARTUP_COMMANDS`` — so nothing needs
composing here). A top-level ``shared/`` folder isn't applied to any device yet; it is left alone
on disk and reported as a warning (see ``translate_lab_files``).
"""

import re
from dataclasses import dataclass, field
from typing import Optional

from ..schemas.lab import LabCreate, LabMetadata
from ..schemas.lab_import import PendingMachineFiles
from ..schemas.link import LinkCreate
from ..schemas.machine import InterfaceAttach, MachineCreate, PortMapping, Ulimit

RESERVED_NAMES = {"shared", "_test"}
LAB_META_KEYS = {"LAB_NAME", "LAB_DESCRIPTION", "LAB_VERSION", "LAB_AUTHOR", "LAB_EMAIL", "LAB_WEB"}
CONF_LINE_RE = re.compile(r"""^([a-z0-9_]{1,30})\[(\w+)\]=(["']?)([^"']+)\3(\s+#.*)?$""")
# A top-level `KEY=value` line that isn't a known LAB_* key: preserved, not applied (see parse_lab_conf).
TOP_LEVEL_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
STARTUP_NAME_RE = re.compile(r"^([a-z0-9_]{1,30})\.startup$")


@dataclass
class _ConfMachine:
    name: str
    image: Optional[str] = None
    mem: Optional[str] = None
    cpus: Optional[float] = None
    ipv6: Optional[bool] = None
    shell: Optional[str] = None
    privileged: bool = False
    bridged: bool = False
    ports: list = field(default_factory=list)
    envs: dict = field(default_factory=dict)
    sysctls: dict = field(default_factory=dict)
    ulimits: list = field(default_factory=list)
    execs: list = field(default_factory=list)
    num_terms: Optional[int] = None
    entrypoint: Optional[str] = None
    args: Optional[str] = None
    # Options this parser does not interpret, kept so they reach the Kathara model untouched
    # (last one wins, mirroring Kathara's own `assign_meta_to_machine`).
    metas: dict = field(default_factory=dict)
    interfaces: list = field(default_factory=list)
    unsupported: list = field(default_factory=list)


@dataclass
class _ParsedConf:
    machines: dict
    metadata: dict
    errors: list
    warnings: list = field(default_factory=list)


def _parse_bool(value: str) -> Optional[bool]:
    s = value.strip().lower()
    if s in {"y", "yes", "t", "true", "on", "1"}:
        return True
    if s in {"n", "no", "f", "false", "off", "0"}:
        return False
    return None


def _parse_port(value: str) -> Optional[PortMapping]:
    if "/" in value:
        ports, proto = value.split("/", 1)
    else:
        ports, proto = value, "tcp"
    proto = (proto or "tcp").lower()
    if proto not in ("tcp", "udp", "sctp"):
        return None
    if ":" in ports:
        host, guest = ports.split(":", 1)
    else:
        host, guest = "3000", ports
    try:
        return PortMapping(host_port=int(host), guest_port=int(guest), protocol=proto)
    except ValueError:
        return None


def _parse_ulimit(value: str) -> Optional[Ulimit]:
    m = re.match(r"^(\w+)=(-?\d+)(?::(-?\d+))?$", value)
    if not m:
        return None
    soft = int(m.group(2))
    hard = int(m.group(3)) if m.group(3) is not None else soft
    return Ulimit(name=m.group(1), soft=soft, hard=hard)


def _apply_conf_option(machine: _ConfMachine, opt: str, value: str, line_no: int, errors: list) -> None:
    if opt == "image":
        machine.image = value
    elif opt == "mem":
        machine.mem = value
    elif opt in ("cpus", "cpu"):
        try:
            machine.cpus = float(value)
        except ValueError:
            errors.append(f'line {line_no}: invalid cpus "{value}"')
    elif opt == "ipv6":
        b = _parse_bool(value)
        if b is not None:
            machine.ipv6 = b
    elif opt == "shell":
        machine.shell = value
    elif opt == "privileged":
        machine.privileged = _parse_bool(value) is True
    elif opt == "exec":
        machine.execs.append(value)
    elif opt == "port":
        p = _parse_port(value)
        if p:
            machine.ports.append(p)
        else:
            errors.append(f'line {line_no}: invalid port "{value}"')
    elif opt == "sysctl":
        i = value.find("=")
        k = value[:i] if i >= 0 else ""
        v = value[i + 1 :] if i >= 0 else ""
        if i > 0 and re.match(r"^net\.([\w-]+\.)+[\w-]+$", k):
            machine.sysctls[k] = int(v) if re.match(r"^-?\d+$", v) else v
        else:
            errors.append(f'line {line_no}: invalid sysctl "{value}" (must be net.*=value)')
    elif opt == "env":
        i = value.find("=")
        if i > 0:
            machine.envs[value[:i]] = value[i + 1 :]
        else:
            errors.append(f'line {line_no}: invalid env "{value}"')
    elif opt == "ulimit":
        u = _parse_ulimit(value)
        if u:
            machine.ulimits.append(u)
        else:
            errors.append(f'line {line_no}: invalid ulimit "{value}"')
    elif opt == "bridged":
        machine.bridged = _parse_bool(value) is True
    elif opt == "num_terms":
        try:
            machine.num_terms = int(value)
        except ValueError:
            machine.unsupported.append(
                f"{machine.name}[num_terms] (line {line_no}) — not an integer, kept in lab.conf but not applied"
            )
    elif opt == "entrypoint":
        machine.entrypoint = value
    elif opt == "args":
        machine.args = value
    elif opt == "volume":
        # Deliberately not applied: a lab.conf can name any host path, and this API is reachable
        # over the network. The directive stays in lab.conf untouched.
        machine.unsupported.append(
            f"{machine.name}[volume] (line {line_no}) — host volumes aren't applied by the API "
            f"(kept in lab.conf)"
        )
    else:
        machine.metas[opt] = value
        machine.unsupported.append(
            f"{machine.name}[{opt}] (line {line_no}) — option not interpreted by the API "
            f"(kept in lab.conf, passed to the device unchanged)"
        )


def strip_quotes(value: str) -> str:
    """Strip all single/double quotes from a lab.conf value (matching Kathara's own parser)."""
    return re.sub(r"""["']""", "", value)


def parse_lab_conf(text: str) -> _ParsedConf:
    """Parse ``lab.conf`` contents into per-machine options and lab metadata."""
    machines: dict[str, _ConfMachine] = {}
    metadata: dict[str, str] = {}
    errors: list[str] = []
    warnings: list[str] = []

    def get(name: str) -> _ConfMachine:
        return machines.setdefault(name, _ConfMachine(name))

    for idx, raw in enumerate(re.split(r"\r?\n", text)):
        line = raw.strip()
        line_no = idx + 1
        if not line or line.startswith("#"):
            continue
        m = CONF_LINE_RE.match(line)
        if m:
            key, arg, raw_value = m.group(1), m.group(2), m.group(4)
            value = strip_quotes(raw_value)
            if key in RESERVED_NAMES:
                errors.append(f'line {line_no}: "{key}" is a reserved name')
                continue
            machine = get(key)
            if arg.isdigit():
                cd, mac = value, None
                if "/" in value:
                    parts = [p for p in value.split("/") if p]
                    if len(parts) != 2:
                        errors.append(f'line {line_no}: invalid interface "{value}"')
                        continue
                    cd, mac = parts
                if not re.match(r"^\w+$", cd):
                    errors.append(f'line {line_no}: invalid collision domain "{cd}"')
                    continue
                machine.interfaces.append(InterfaceAttach(link=cd, number=int(arg), mac_address=mac))
            else:
                _apply_conf_option(machine, arg, value, line_no, errors)
        else:
            eq = line.find("=")
            key = line[:eq].strip() if eq >= 0 else line
            if eq > 0 and key in LAB_META_KEYS:
                metadata[key.replace("LAB_", "").lower()] = strip_quotes(line[eq + 1 :]).strip()
            elif eq > 0 and TOP_LEVEL_KEY_RE.match(key):
                # An unrecognized `KEY=value` line is *not* fatal (Kathara's own LabParser raises
                # here). `errors` propagate to KatharaService._translate_lab_dir, which drops the
                # lab from the registry — so a strict parser would make a stored lab silently
                # disappear on the next restart. Errors are reserved for a topology we cannot
                # represent; anything else is a warning and stays in lab.conf as written.
                warnings.append(f'line {line_no}: unknown key "{key}" — kept in lab.conf, not applied')
            else:
                errors.append(f'line {line_no}: cannot parse "{line}"')

    for machine in machines.values():
        nums = sorted(i.number for i in machine.interfaces)
        for expected, actual in enumerate(nums):
            if actual != expected:
                errors.append(
                    f"{machine.name}: non-sequential interface numbers (expected eth{expected}, got eth{actual})"
                )

    return _ParsedConf(machines=machines, metadata=metadata, errors=errors, warnings=warnings)


def parse_lab_ext(text: str) -> list[LinkCreate]:
    """Parse ``lab.ext`` contents into external-interface link declarations."""
    links: dict[str, LinkCreate] = {}
    for raw in re.split(r"\r?\n", text):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(\w+)\s+(\w+)(\.\d+)?$", line)
        if not m:
            continue
        name, iface, suffix = m.group(1), m.group(2), m.group(3) or ""
        link = links.setdefault(name, LinkCreate(name=name, external=[]))
        link.external.append(iface + suffix)
    return list(links.values())


def _collect_folder(files: dict, prefix: str) -> dict:
    out = {}
    for path, text in files.items():
        if not path.startswith(prefix) or path == prefix:
            continue
        out["/" + path[len(prefix) :]] = text
    return out


def _collect_folder_dirs(files: dict, dirs: list, prefix: str) -> list:
    out: set = set()

    def add_guest_dir(rel: str) -> None:
        clean = rel.strip().strip("/")
        if not clean:
            return
        parts = clean.split("/")
        for i in range(1, len(parts) + 1):
            out.add("/" + "/".join(parts[:i]))

    for path in files:
        if not path.startswith(prefix) or path == prefix:
            continue
        rel = path[len(prefix) :]
        slash = rel.rfind("/")
        if slash > 0:
            add_guest_dir(rel[:slash])

    for d in dirs or []:
        if not d.startswith(prefix):
            continue
        rel = d[len(prefix) :]
        if rel:
            add_guest_dir(rel)

    return sorted(out)


@dataclass
class LabImportTranslation:
    payload: LabCreate
    pending: dict
    machine_count: int
    domains: list
    errors: list
    warnings: list


def translate_lab_files(
    files: dict[str, str],
    lab_name: str,
    dirs: Optional[list[str]] = None,
    skipped: Optional[list[str]] = None,
) -> LabImportTranslation:
    """Translate a lab directory's file contents into a LabCreate + per-machine pending files.

    ``files`` maps lab-relative paths to UTF-8 text (binary files must already be excluded
    by the caller; pass their names in ``skipped`` only so a warning can be surfaced).
    """
    dirs = dirs or []
    errors: list[str] = []
    warnings: list[str] = []

    conf_text = files.get("lab.conf")
    if conf_text is not None:
        parsed = parse_lab_conf(conf_text)
    else:
        # Folder fallback: machine names are top-level subfolders (+ *.startup files).
        names: set[str] = set()
        for path in files:
            seg = path.split("/")[0]
            if "/" in path and seg not in RESERVED_NAMES:
                names.add(seg)
            m = STARTUP_NAME_RE.match(path)
            if m and m.group(1) not in RESERVED_NAMES:
                names.add(m.group(1))
        machines = {n: _ConfMachine(n) for n in names}
        parsed = _ParsedConf(
            machines=machines,
            metadata={},
            errors=[] if names else ["no lab.conf and no machine folders found"],
        )
        if names:
            warnings.append("no lab.conf — machines derived from folders (no interfaces defined)")

    errors.extend(parsed.errors)
    warnings.extend(parsed.warnings)
    for machine in parsed.machines.values():
        warnings.extend(machine.unsupported)

    ext_text = files.get("lab.ext")
    links = parse_lab_ext(ext_text) if ext_text is not None else []

    machine_specs = [
        MachineCreate(
            name=m.name,
            image=m.image,
            mem=m.mem,
            cpus=m.cpus,
            ipv6=m.ipv6,
            shell=m.shell,
            privileged=m.privileged,
            bridged=m.bridged,
            ports=m.ports,
            envs=m.envs,
            sysctls=m.sysctls,
            ulimits=m.ulimits,
            exec_commands=list(m.execs),
            num_terms=m.num_terms,
            entrypoint=m.entrypoint,
            args=m.args,
            metas=dict(m.metas),
            interfaces=m.interfaces,
        )
        for m in parsed.machines.values()
    ]

    # A `shared/` folder isn't applied to any device yet: Kathara's `Machine.pack_data` doesn't
    # pack it, and the CLI's `/shared` bind mount is disabled per-lab under Docker-outside-of-Docker
    # (see lab_builder.build_lab). Rather than merge its contents into every machine (which would
    # rewrite files that don't belong to the source archive, breaking verbatim import), it is left
    # on disk untouched and simply not surfaced as pending state — with a warning so the omission is
    # visible instead of silent.
    if _collect_folder(files, "shared/"):
        warnings.append("shared/ folder is not applied to devices yet — left on disk, ignored")

    pending: dict[str, PendingMachineFiles] = {}
    for m in parsed.machines.values():
        mfiles = _collect_folder(files, f"{m.name}/")
        mdirs = _collect_folder_dirs(files, dirs, f"{m.name}/")
        # Verbatim: the device's own <name>.startup, unmodified. shared.startup and exec_commands
        # are not folded in here — Kathara's native deploy already runs shared.startup then
        # <name>.startup then exec_commands (see DockerMachine.STARTUP_COMMANDS); composing them
        # here would run them a second time and would silently rewrite the source file on save.
        pending[m.name] = PendingMachineFiles(
            files=mfiles, dirs=mdirs, startup=files.get(f"{m.name}.startup", "")
        )

    if skipped:
        shown = ", ".join(skipped[:4]) + ("…" if len(skipped) > 4 else "")
        warnings.append(f"skipped {len(skipped)} binary/non-UTF-8 file(s): {shown}")

    domains: set[str] = set()
    for m in parsed.machines.values():
        for i in m.interfaces:
            domains.add(i.link)
    for link in links:
        domains.add(link.name)

    # LAB_NAME is a recognized lab.conf key but LabMetadata has no "name" field (the lab's
    # name comes from the target name given to the import, not from the file); drop it.
    metadata_kwargs = {k: v for k, v in parsed.metadata.items() if k in LabMetadata.model_fields}
    payload = LabCreate(
        name=lab_name,
        metadata=LabMetadata(**metadata_kwargs),
        machines=machine_specs,
        links=links,
    )

    return LabImportTranslation(
        payload=payload,
        pending=pending,
        machine_count=len(parsed.machines),
        domains=sorted(domains),
        errors=errors,
        warnings=warnings,
    )
