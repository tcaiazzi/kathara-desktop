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
from ..schemas.machine import InterfaceModel, MachineDetail, PortMapping
from ..schemas.stats import LinkStats, MachineStats


def _ports_to_schema(ports: dict) -> list[PortMapping]:
    """Convert Kathara port meta ``{(host, proto): guest}`` to PortMapping list."""
    result = []
    for (host_port, protocol), guest_port in ports.items():
        result.append(
            PortMapping(host_port=host_port, guest_port=guest_port, protocol=protocol)
        )
    return result


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
        envs=machine.get_envs(),
        sysctls=machine.get_sysctls(),
        exec_commands=machine.get_exec_commands(),
        interfaces=interfaces,
        bridged=machine.is_bridged(),
        num_terms=machine.meta.get("num_terms"),
        entrypoint=machine.meta.get("entrypoint"),
        args=machine.meta.get("args"),
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
