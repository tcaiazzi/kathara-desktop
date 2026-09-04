"""Schemas describing Kathara devices (machines)."""

import os
from pathlib import PurePosixPath
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
    """A host directory bind-mounted inside the device.

    Shared by both sources a volume can come from: the device options form and its host-path
    browser (JSON), and an imported ``lab.conf``'s ``[volume]`` (see
    ``lab_import._parse_volume``) — both are applied, and both get written back out as a
    ``pc[volume]="host|guest|mode"`` line, so both halves need the validation below regardless of
    where the value originated.
    """

    host_path: str
    guest_path: str
    mode: Literal["ro", "rw", "rx"] = "rw"

    @field_validator("host_path", "guest_path")
    @classmethod
    def _no_quotes(cls, value: str) -> str:
        # These are rendered into an always-double-quoted lab.conf line by
        # `lab_store.gen_device_lines`/`lab_conf_edit.set_meta_group`, neither of which routes
        # them through `lab_store.conf_value` — so without this a `"` here writes a malformed
        # line, and the whole lab stops parsing on the next reload.
        return reject_lab_conf_quotes(value)

    @field_validator("host_path")
    @classmethod
    def _host_path_absolute(cls, value: str) -> str:
        # Kathara resolves the host side with `os.path.abspath` (model/Machine.py), so a relative
        # path silently means "relative to the API process's working directory" — which differs
        # between the desktop app, Compose and a plain dev run. Reject it rather than mount
        # somewhere the user didn't mean.
        #
        # `os.path.isabs`, not PurePosixPath: this is a path on whatever host this backend runs
        # on, so on a Windows desktop install `C:\labs\data` — exactly what the shell's native
        # folder dialog returns there (services/desktop/src/integrations.ts) — has to be accepted.
        if not os.path.isabs(value):
            raise ValueError(f"must be an absolute path on the host, got {value!r}")
        return value

    @field_validator("guest_path")
    @classmethod
    def _guest_path_absolute(cls, value: str) -> str:
        # The guest side is always a path inside a Linux container, whatever the host OS.
        if not PurePosixPath(value).is_absolute():
            raise ValueError(f"must be an absolute path inside the device, got {value!r}")
        return value


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
