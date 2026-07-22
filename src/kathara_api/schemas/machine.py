"""Schemas describing Kathara devices (machines)."""

from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

MACHINE_NAME_PATTERN = r"^[a-z0-9_]{1,30}$"


class PortMapping(BaseModel):
    """A published port mapping (host <-> guest)."""

    host_port: int = Field(ge=1, le=65535)
    guest_port: int = Field(ge=1, le=65535)
    protocol: Literal["tcp", "udp", "sctp"] = "tcp"


class VolumeMount(BaseModel):
    """A host directory bind-mounted inside the device."""

    host_path: str
    guest_path: str
    mode: Literal["ro", "rw"] = "rw"


class Ulimit(BaseModel):
    """A resource ulimit applied to the device."""

    name: str
    soft: int
    hard: Optional[int] = None


class InterfaceAttach(BaseModel):
    """Request-side description of a device interface on a collision domain."""

    link: str = Field(pattern=r"^\w+$")
    number: Optional[int] = Field(default=None, ge=0)
    mac_address: Optional[str] = None


class InterfaceModel(BaseModel):
    """Response-side description of a deployed/declared interface."""

    num: int
    link: str
    mac_address: Optional[str] = None


class MachineCreate(BaseModel):
    """JSON description of a device to create."""

    name: str = Field(pattern=MACHINE_NAME_PATTERN)
    image: Optional[str] = None
    mem: Optional[str] = None
    cpus: Optional[float] = None
    ports: list[PortMapping] = Field(default_factory=list)
    envs: dict[str, str] = Field(default_factory=dict)
    sysctls: dict[str, Union[str, int]] = Field(default_factory=dict)
    exec_commands: list[str] = Field(default_factory=list)
    volumes: list[VolumeMount] = Field(default_factory=list)
    ulimits: list[Ulimit] = Field(default_factory=list)
    privileged: bool = False
    bridged: bool = False
    ipv6: Optional[bool] = None
    shell: Optional[str] = None
    interfaces: list[InterfaceAttach] = Field(default_factory=list)


class MachineDetail(BaseModel):
    """Response describing a device and (if deployed) its running state."""

    name: str
    image: Optional[str] = None
    mem: Optional[str] = None
    cpus: Optional[float] = None
    ports: list[PortMapping] = Field(default_factory=list)
    envs: dict[str, Union[str, int]] = Field(default_factory=dict)
    sysctls: dict[str, Union[str, int]] = Field(default_factory=dict)
    exec_commands: list[str] = Field(default_factory=list)
    interfaces: list[InterfaceModel] = Field(default_factory=list)
    bridged: bool = False
    running: bool = False
    status: Optional[str] = None

    model_config = ConfigDict(extra="ignore")
