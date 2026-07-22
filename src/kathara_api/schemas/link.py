"""Schemas describing Kathara collision domains (links)."""

from pydantic import BaseModel, Field


class LinkCreate(BaseModel):
    """JSON description of a collision domain to create."""

    name: str = Field(pattern=r"^\w+$")
    external: list[str] = Field(default_factory=list)


class LinkDetail(BaseModel):
    """Response describing a collision domain."""

    name: str
    machines: list[str] = Field(default_factory=list)
    external: list[str] = Field(default_factory=list)
    running: bool = False
