"""Schema for the result of importing a Kathara lab directory (lab.conf/.startup/folders)."""

from pydantic import Field

from .lab import LabDetail


class LabImportResult(LabDetail):
    """Response for a successful import, including any non-fatal parse warnings."""

    warnings: list[str] = Field(default_factory=list)
