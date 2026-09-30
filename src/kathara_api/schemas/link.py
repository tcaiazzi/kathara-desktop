"""Schemas describing Kathara collision domains (links)."""

from typing import Optional

from pydantic import BaseModel, Field

from ..lab_conf_options import COLLISION_DOMAIN_PATTERN


class LinkCreate(BaseModel):
    """JSON description of a collision domain to create."""

    name: str = Field(pattern=COLLISION_DOMAIN_PATTERN)
    external: list[str] = Field(default_factory=list)


class LinkDetail(BaseModel):
    """Response describing a collision domain."""

    name: str
    machines: list[str] = Field(default_factory=list)
    external: list[str] = Field(default_factory=list)
    running: bool = False
    # No device on it yet, so not in lab.conf: shown until one is connected, kept only for the
    # backend's session (see KatharaService.add_link).
    draft: bool = False
    # The Docker network plugin (e.g. `kathara/katharanp_vde`): the one its network was created
    # with while it is up, else the configured one a deploy would create it with.
    network_plugin: Optional[str] = None
