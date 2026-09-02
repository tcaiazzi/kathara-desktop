"""Schemas for the bundled example network scenarios (see services/examples.py)."""

from typing import Optional

from pydantic import BaseModel


class ExampleSummary(BaseModel):
    """One bundled example, as listed on the frontend's welcome screen."""

    # The directory name under the examples catalog; also the default lab name when installed.
    id: str
    description: Optional[str] = None
    author: Optional[str] = None
    n_machines: int
    # Whether a lab with this id already exists in the labs directory — the frontend renders
    # "Open" instead of "Create" when true.
    installed: bool


class ExampleCreate(BaseModel):
    """Request to install a bundled example as a real, on-disk lab."""

    id: str
    # Target lab name; defaults to `id` when omitted.
    name: Optional[str] = None
