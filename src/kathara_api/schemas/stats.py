"""Schemas for device and collision-domain statistics.

These mirror the flat dicts returned by the Kathara stats objects' ``to_dict()``.
``extra="allow"`` keeps the schema tolerant to backend-specific / evolving fields.
"""

from typing import Optional

from pydantic import BaseModel, ConfigDict


class MachineStats(BaseModel):
    """Statistics for a single deployed device."""

    name: str
    container_name: Optional[str] = None
    status: Optional[str] = None
    image: Optional[str] = None
    pids: Optional[int] = None
    cpu_usage: Optional[str] = None
    mem_usage: Optional[str] = None
    mem_percent: Optional[str] = None
    net_usage: Optional[str] = None
    interfaces: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class LinkStats(BaseModel):
    """Statistics for a single deployed collision domain."""

    name: str
    network_name: Optional[str] = None
    containers: Optional[list] = None
    external: Optional[list] = None

    model_config = ConfigDict(extra="allow")
