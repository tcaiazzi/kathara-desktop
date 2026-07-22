"""Schemas for importing a standard Kathara lab directory (lab.conf/.startup/folders)."""

from typing import Optional

from pydantic import BaseModel, Field

from .lab import LabDetail


class LabImportRequest(BaseModel):
    """Raw contents of a standard Kathara lab directory, as collected by a client.

    ``files`` maps lab-relative paths (e.g. ``lab.conf``, ``pc1.startup``,
    ``shared/etc/motd``) to their UTF-8 text content. Binary files can't be pushed over
    REST, so the caller should omit them and list their names in ``skipped_files`` (used
    only to surface a warning).
    """

    name: str
    files: dict[str, str] = Field(default_factory=dict)
    dirs: list[str] = Field(default_factory=list)
    skipped_files: list[str] = Field(default_factory=list)
    deploy: bool = False


class LabImportPreview(BaseModel):
    """Dry-run parse result of a lab directory, without creating anything."""

    machine_count: int
    domains: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class LabImportResult(LabDetail):
    """Response for a successful import, including any non-fatal parse warnings."""

    warnings: list[str] = Field(default_factory=list)


class _FilesDirsBase(BaseModel):
    """Shared shape for a queued files/dirs payload."""

    files: dict[str, str] = Field(default_factory=dict)
    dirs: list[str] = Field(default_factory=list)


class PendingMachineFiles(_FilesDirsBase):
    """Files/dirs/startup script queued to be applied to a machine on its next deploy."""

    startup: str = ""


class PendingFilesUpdate(_FilesDirsBase):
    """Merge request for a single machine's queued files (e.g. explorer edits)."""

    startup: Optional[str] = None


class SharedPendingFilesUpdate(_FilesDirsBase):
    """Merge request applied to every machine's queued files (``shared/`` semantics)."""
