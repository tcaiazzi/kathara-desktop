"""Schemas for Kathara settings and system information."""

from typing import Optional

from pydantic import BaseModel, ConfigDict


class SystemInfo(BaseModel):
    """Environment information about the running Kathara manager."""

    manager: str
    version: str
    available_managers: dict[str, str]


class SettingsView(BaseModel):
    """A safe view of the current Kathara settings."""

    manager_type: str
    image: str

    model_config = ConfigDict(extra="allow")


class SettingsUpdate(BaseModel):
    """Settings overrides forwarded to ``Setting.load_from_dict``.

    Any extra keys are passed through as-is (manager-specific addon settings).
    """

    manager_type: Optional[str] = None
    image: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class ImageCheckRequest(BaseModel):
    """Request body for checking image availability."""

    image: str
