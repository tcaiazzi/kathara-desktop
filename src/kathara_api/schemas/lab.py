"""Schemas describing Kathara network scenarios (labs)."""

from typing import Optional

from pydantic import BaseModel, Field

from .link import LinkCreate, LinkDetail
from .machine import MachineCreate, MachineDetail


class LabMetadata(BaseModel):
    """Optional descriptive metadata for a network scenario."""

    description: Optional[str] = None
    version: Optional[str] = None
    author: Optional[str] = None
    email: Optional[str] = None
    web: Optional[str] = None


class LabCreate(BaseModel):
    """JSON description of a network scenario to create."""

    name: str
    metadata: LabMetadata = Field(default_factory=LabMetadata)
    machines: list[MachineCreate] = Field(default_factory=list)
    links: list[LinkCreate] = Field(default_factory=list)


class LabConfUpdate(BaseModel):
    """Raw ``lab.conf`` text to apply to an existing, non-deployed lab."""

    content: str


class LabSummary(BaseModel):
    """Compact response describing a network scenario."""

    name: Optional[str] = None
    hash: str
    n_machines: int
    n_links: int
    deployed: bool


class LabDetail(LabSummary):
    """Full response describing a network scenario and its contents."""

    metadata: LabMetadata = Field(default_factory=LabMetadata)
    machines: list[MachineDetail] = Field(default_factory=list)
    links: list[LinkDetail] = Field(default_factory=list)


class DeployOptions(BaseModel):
    """Options for a deploy request."""

    selected_machines: Optional[list[str]] = None
    excluded_machines: Optional[list[str]] = None


class UndeployOptions(BaseModel):
    """Options for an undeploy request."""

    selected_machines: Optional[list[str]] = None
    excluded_machines: Optional[list[str]] = None
    selected_links: Optional[list[str]] = None
