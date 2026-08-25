"""Schemas describing Kathara network scenarios (labs)."""

import math
import re
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from .link import LinkCreate, LinkDetail
from .machine import MachineCreate, MachineDetail

# Topology node ids, as built by the frontend's computeTopology: `dev:<machine>` / `cd:<link>`.
LAYOUT_NODE_ID_RE = re.compile(r"^(dev|cd):[^\s/]{1,64}$")

# The layout is written verbatim into the user's lab directory, so its size is bounded here rather
# than trusting the client (a lab has a handful of nodes; this is only a sanity ceiling).
LAYOUT_MAX_NODES = 2000


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


class LayoutPoint(BaseModel):
    """Canvas coordinates of one topology node."""

    x: float
    y: float

    @field_validator("x", "y")
    @classmethod
    def _finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("coordinate must be a finite number")
        return value


class LabLayout(BaseModel):
    """A lab's fixed topology layout — the content of its ``lab.layout`` file.

    Keys are topology node ids (``dev:<machine>`` / ``cd:<collision domain>``). An empty ``nodes``
    map means "no fixed layout" (what ``GET`` returns when the file is absent).
    """

    version: int = 1
    nodes: dict[str, LayoutPoint] = Field(default_factory=dict)

    @field_validator("nodes")
    @classmethod
    def _check_nodes(cls, nodes: dict[str, LayoutPoint]) -> dict[str, LayoutPoint]:
        if len(nodes) > LAYOUT_MAX_NODES:
            raise ValueError(f"too many layout nodes (max {LAYOUT_MAX_NODES})")
        for node_id in nodes:
            if not LAYOUT_NODE_ID_RE.match(node_id):
                raise ValueError(f"invalid layout node id `{node_id}` (expected `dev:<name>` or `cd:<name>`)")
        return nodes


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
