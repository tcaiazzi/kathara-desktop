"""Schemas describing Kathara devices (machines)."""

from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .common import reject_lab_conf_quotes

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
    mode: Literal["ro", "rw", "rx"] = "rw"


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


class MachineOptionsBase(BaseModel):
    """Every device "option"/meta this API models explicitly, shared by creation and update —
    keeping the field list in exactly one place so the two request shapes can't drift apart."""

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
    num_terms: Optional[int] = Field(default=None, ge=0)
    entrypoint: Optional[str] = None
    args: Optional[str] = None
    # Options this API doesn't interpret (from an imported lab.conf, or authored directly), passed
    # to the device unchanged. Never routed through Kathara's `Machine.add_meta` (see
    # `lab_builder.apply_options`) — only assigned straight into `machine.meta` — so a key like
    # `volume` can't smuggle a host bind mount in through this side door.
    metas: dict[str, str] = Field(default_factory=dict)

    @field_validator("image", "mem", "shell", "entrypoint", "args")
    @classmethod
    def _no_quotes(cls, value: Optional[str]) -> Optional[str]:
        return value if value is None else reject_lab_conf_quotes(value)

    @field_validator("envs", "sysctls", "metas")
    @classmethod
    def _no_quotes_in_values(cls, values: dict) -> dict:
        for value in values.values():
            if isinstance(value, str):
                reject_lab_conf_quotes(value)
        return values


class MachineCreate(MachineOptionsBase):
    """JSON description of a device to create."""

    name: str = Field(pattern=MACHINE_NAME_PATTERN)
    interfaces: list[InterfaceAttach] = Field(default_factory=list)


class MachineUpdate(MachineOptionsBase):
    """Full replacement of an existing, non-deployed device's option set — every field is resent,
    not just the ones that changed (see `KatharaService.update_machine`)."""


class MachineDetail(BaseModel):
    """Response describing a device and (if deployed) its running state."""

    name: str
    image: Optional[str] = None
    mem: Optional[str] = None
    cpus: Optional[float] = None
    ports: list[PortMapping] = Field(default_factory=list)
    # `dict[str, str]`, matching MachineOptionsBase: this response feeds straight back into a PUT,
    # so a looser type here would produce a body its own request schema rejects.
    envs: dict[str, str] = Field(default_factory=dict)
    sysctls: dict[str, Union[str, int]] = Field(default_factory=dict)
    exec_commands: list[str] = Field(default_factory=list)
    volumes: list[VolumeMount] = Field(default_factory=list)
    ulimits: list[Ulimit] = Field(default_factory=list)
    interfaces: list[InterfaceModel] = Field(default_factory=list)
    privileged: bool = False
    bridged: bool = False
    ipv6: Optional[bool] = None
    shell: Optional[str] = None
    num_terms: Optional[int] = None
    entrypoint: Optional[str] = None
    args: Optional[str] = None
    metas: dict[str, str] = Field(default_factory=dict)
    running: bool = False
    status: Optional[str] = None

    model_config = ConfigDict(extra="ignore")


class StartupStatus(BaseModel):
    """A running device's boot-time startup progress: the live `/var/log/startup.log` tail and
    whether its startup commands (`.startup` script + `exec_commands`) have finished executing."""

    log: str
    finished: bool
