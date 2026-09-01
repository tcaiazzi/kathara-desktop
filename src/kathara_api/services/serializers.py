"""Serialize Kathara model objects into API response schemas.

The Kathara models expose no ``to_dict()``; this module bridges them to the Pydantic
response schemas.
"""

from typing import Any

from Kathara.model.Lab import Lab
from Kathara.model.Link import Link
from Kathara.model.Machine import Machine

from ..schemas.lab import LabDetail, LabMetadata, LabSummary
from ..schemas.link import LinkDetail
from ..schemas.machine import InterfaceModel, MachineDetail, PortMapping, Ulimit, VolumeMount
from ..schemas.stats import LinkStats, MachineStats
from .lab_store import _KNOWN_META_KEYS


def _ports_to_schema(ports: dict) -> list[PortMapping]:
    """Convert Kathara port meta ``{(host, proto): guest}`` to PortMapping list."""
    result = []
    for (host_port, protocol), guest_port in ports.items():
        result.append(
            PortMapping(host_port=host_port, guest_port=guest_port, protocol=protocol)
        )
    return result


def _volumes_to_schema(volumes: dict) -> list[VolumeMount]:
    """Convert Kathara volume meta ``{host_path: {guest_path, mode}}`` to a VolumeMount list."""
    return [
        VolumeMount(host_path=host_path, guest_path=v["guest_path"], mode=v["mode"])
        for host_path, v in volumes.items()
    ]


def _ulimits_to_schema(ulimits: dict) -> list[Ulimit]:
    """Convert Kathara ulimit meta ``{name: {soft, hard}}`` to a Ulimit list."""
    return [Ulimit(name=name, soft=v["soft"], hard=v["hard"]) for name, v in ulimits.items()]


def machine_to_detail(machine: Machine) -> MachineDetail:
    """Serialize a Machine, reflecting running state if it is deployed."""
    running = machine.api_object is not None

    status = None
    if running:
        status = getattr(machine.api_object, "status", None)

    interfaces: list[InterfaceModel] = []
    for num, iface in machine.interfaces.items():
        if iface is None:
            continue
        link = getattr(iface, "link", None)
        if link is None or getattr(link, "name", None) is None:
            continue
        interfaces.append(
            InterfaceModel(
                num=num,
                link=link.name,
                mac_address=getattr(iface, "mac_address", None),
            )
        )

    return MachineDetail(
        name=machine.name,
        image=machine.get_image(),
        mem=machine.meta.get("mem"),
        cpus=machine.meta.get("cpus"),
        ports=_ports_to_schema(machine.get_ports()),
        envs={k: str(v) for k, v in machine.get_envs().items()},
        sysctls=machine.get_sysctls(),
        exec_commands=machine.get_exec_commands(),
        # Read straight from `meta` rather than the `is_privileged()`/`is_ipv6_enabled()`/
        # `get_volumes()` getters: those resolve lab-level metadata overrides and setting-file
        # defaults this API doesn't expose, and `get_volumes()` additionally raises
        # `MountDeniedError` under a restrictive mount policy — wrong for a plain "what did this
        # device declare" read used to populate an edit form.
        volumes=_volumes_to_schema(machine.meta.get("volumes", {})),
        ulimits=_ulimits_to_schema(machine.meta.get("ulimits", {})),
        interfaces=interfaces,
        privileged=bool(machine.meta.get("privileged", False)),
        # `is_bridged()` happens to be a plain `meta` read with a False default, unlike the
        # getters the comment above rules out — but reading `meta` directly here keeps every flag
        # on this form answering the same question: what did *this device* declare.
        bridged=bool(machine.meta.get("bridged", False)),
        ipv6=machine.meta.get("ipv6"),
        shell=machine.meta.get("shell"),
        num_terms=machine.meta.get("num_terms"),
        entrypoint=machine.meta.get("entrypoint"),
        args=machine.meta.get("args"),
        metas={k: str(v) for k, v in machine.meta.items() if k not in _KNOWN_META_KEYS},
        running=running,
        status=status,
    )


def link_to_detail(link: Link) -> LinkDetail:
    return LinkDetail(
        name=link.name,
        machines=list(link.machines.keys()),
        external=[ext.get_full_name() for ext in link.external],
        running=link.api_object is not None,
    )


def _lab_metadata(lab: Lab) -> LabMetadata:
    return LabMetadata(
        description=lab.description,
        version=lab.version,
        author=lab.author,
        email=lab.email,
        web=lab.web,
    )


def _is_deployed(lab: Lab) -> bool:
    return any(m.api_object is not None for m in lab.machines.values())


def lab_to_summary(lab: Lab) -> LabSummary:
    return LabSummary(
        name=lab.name,
        hash=lab.hash,
        n_machines=len(lab.machines),
        n_links=len(lab.links),
        deployed=_is_deployed(lab),
    )


def lab_to_detail(lab: Lab) -> LabDetail:
    """Serialize a lab, including its devices and collision domains."""
    return LabDetail(
        name=lab.name,
        hash=lab.hash,
        n_machines=len(lab.machines),
        n_links=len(lab.links),
        deployed=_is_deployed(lab),
        metadata=_lab_metadata(lab),
        machines=[machine_to_detail(m) for m in lab.machines.values()],
        links=[link_to_detail(link) for link in lab.links.values()],
    )


def machine_stats_to_schema(stats: Any) -> MachineStats:
    return MachineStats.model_validate(stats.to_dict())


def link_stats_to_schema(stats: Any) -> LinkStats:
    return LinkStats.model_validate(stats.to_dict())
