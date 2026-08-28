"""Translate JSON lab descriptions into Kathara model objects.

The Kathara ``Machine.update_meta`` accepts most options as *lists of strings* in the same
textual format used by ``lab.conf`` / ``vstart``. This module formats the structured schema
into those forms. Volumes are handled separately since ``update_meta`` does not process them.
"""

import re
from typing import Optional

from Kathara.model.ExternalLink import ExternalLink
from Kathara.model.Lab import Lab
from Kathara.model.Machine import Machine

from ..schemas.lab import LabCreate
from ..schemas.machine import MachineCreate

# A host interface spec optionally carrying a trailing VLAN tag, e.g. "eth0" or "eth0.100".
_VLAN_SUFFIX_RE = re.compile(r"^(?P<iface>.+)\.(?P<vlan>\d+)$")


def build_external_link(spec: str) -> ExternalLink:
    """Build an ``ExternalLink`` from a ``lab.ext``-style spec (``iface`` or ``iface.<vlan>``).

    Kathara's own ``ExtParser`` splits the trailing ``.<vlan>`` into a separate integer tag. Passing
    the whole ``"eth0.100"`` string as the interface name (leaving ``vlan=None``) would make the
    manager treat it as a literal interface and never create the VLAN sub-interface at deploy — so we
    mirror ``ExtParser``: split off the ``.<digits>`` suffix and validate the tag in ``[1, 4094]``.
    """
    spec = spec.strip()
    match = _VLAN_SUFFIX_RE.match(spec)
    if not match:
        return ExternalLink(spec)
    iface, vlan = match.group("iface"), int(match.group("vlan"))
    if not 1 <= vlan <= 4094:
        raise ValueError(f"VLAN ID must be in range [1, 4094], got {vlan}.")
    return ExternalLink(iface, vlan)


def _format_port(port) -> str:
    """`host:guest/proto` as expected by Machine.add_meta('port', ...)."""
    return f"{port.host_port}:{port.guest_port}/{port.protocol}"


def _format_ulimit(ulimit) -> str:
    """`name=soft[:hard]` as expected by Machine.add_meta('ulimit', ...)."""
    if ulimit.hard is None:
        return f"{ulimit.name}={ulimit.soft}"
    return f"{ulimit.name}={ulimit.soft}:{ulimit.hard}"


def _format_volume(volume) -> str:
    """`host|guest|mode` as expected by Machine.add_meta('volume', ...)."""
    return f"{volume.host_path}|{volume.guest_path}|{volume.mode}"


def _machine_kwargs(spec: MachineCreate) -> dict:
    """Build the kwargs dict consumed by ``Machine.update_meta``."""
    kwargs: dict = {}
    if spec.image is not None:
        kwargs["image"] = spec.image
    if spec.mem is not None:
        kwargs["mem"] = spec.mem
    if spec.cpus is not None:
        kwargs["cpus"] = spec.cpus
    if spec.privileged:
        kwargs["privileged"] = True
    if spec.bridged:
        kwargs["bridged"] = True
    if spec.ipv6 is not None:
        kwargs["ipv6"] = spec.ipv6
    if spec.shell is not None:
        kwargs["shell"] = spec.shell
    if spec.exec_commands:
        kwargs["exec_commands"] = list(spec.exec_commands)
    if spec.ports:
        kwargs["ports"] = [_format_port(p) for p in spec.ports]
    if spec.envs:
        kwargs["envs"] = [f"{k}={v}" for k, v in spec.envs.items()]
    if spec.sysctls:
        kwargs["sysctls"] = [f"{k}={v}" for k, v in spec.sysctls.items()]
    if spec.ulimits:
        kwargs["ulimits"] = [_format_ulimit(u) for u in spec.ulimits]
    if spec.num_terms is not None:
        kwargs["num_terms"] = spec.num_terms
    if spec.entrypoint is not None:
        kwargs["entrypoint"] = spec.entrypoint
    if spec.args is not None:
        kwargs["args"] = spec.args
    return kwargs


# Meta keys already handled explicitly (by `_machine_kwargs`/`update_meta` or the volume loop
# below) or derived by the manager at deploy time. A `MachineCreate.metas` pass-through entry
# using one of these names is ignored rather than applied — most importantly `volume`, whose
# special handling in Kathara's own `Machine.add_meta` turns a value into a host bind mount, and
# `bridged_iface`, which Kathara's `Machine.check` folds into interface-numbering validation.
# Pass-through metas are assigned straight into `machine.meta` (never through `add_meta`), so this
# list is what stands between an arbitrary lab.conf/JSON key and re-opening either hole.
_RESERVED_META_KEYS = frozenset(
    {
        "image", "mem", "cpus", "shell", "ipv6", "privileged", "bridged", "bridged_iface",
        "num_terms", "entrypoint", "args",
        "exec", "exec_commands", "port", "ports", "env", "envs", "sysctl", "sysctls",
        "ulimit", "ulimits", "volume", "volumes",
    }
)


def build_machine(lab: Lab, spec: MachineCreate) -> Machine:
    """Create a single Machine (with interfaces and volumes) inside ``lab``."""
    machine = lab.new_machine(spec.name, **_machine_kwargs(spec))

    for volume in spec.volumes:
        machine.add_meta("volume", _format_volume(volume))

    for key, value in spec.metas.items():
        if key in _RESERVED_META_KEYS:
            continue
        machine.meta[key] = value

    for iface in spec.interfaces:
        lab.connect_machine_to_link(
            spec.name,
            iface.link,
            machine_iface_number=iface.number,
            mac_address=iface.mac_address,
        )

    return machine


def build_lab(spec: LabCreate, path: Optional[str] = None) -> Lab:
    """Build a complete Kathara ``Lab`` from a JSON description.

    ``path``, when given, must already exist on disk (pyfilesystem2's ``osfs://`` backend
    requires it) and makes this an OS-backed lab: ``lab.fs`` becomes a real directory instead of
    an in-memory one, so Kathara's native deploy (``Machine.pack_data``) can pack real files/
    startup scripts into the container over the Docker API.
    """
    lab = Lab(spec.name, path=path)

    meta = spec.metadata
    lab.description = meta.description
    lab.version = meta.version
    lab.author = meta.author
    lab.email = meta.email
    lab.web = meta.web

    # Declare explicit collision domains first (implicit ones are created on connect).
    for link in spec.links:
        new_link = lab.get_or_new_link(link.name)
        for external in link.external:
            new_link.external.append(build_external_link(external))

    for machine_spec in spec.machines:
        build_machine(lab, machine_spec)

    lab.check_integrity()

    return lab
