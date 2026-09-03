"""Schemas for runtime machine filesystem operations."""

from pydantic import BaseModel


class FsEntry(BaseModel):
    """A single filesystem node in a directory listing."""

    name: str
    path: str
    is_dir: bool
    size: int | None = None
    mode: str | None = None
    mtime: float | None = None


class FsListResponse(BaseModel):
    """Directory listing for a runtime machine path."""

    path: str
    entries: list[FsEntry]


class FsReadTextResponse(BaseModel):
    """Text file content fetched from a running machine."""

    path: str
    content: str


class FsWriteTextRequest(BaseModel):
    """Write or overwrite a text file on a running machine."""

    path: str
    content: str


class FsMkdirRequest(BaseModel):
    """Create a directory on a running machine."""

    path: str


class FsMoveRequest(BaseModel):
    """Move or rename a filesystem path."""

    source_path: str
    destination_path: str


class FsCopyRequest(BaseModel):
    """Copy a filesystem path to a new location."""

    source_path: str
    destination_path: str


class FsDeleteRequest(BaseModel):
    """Delete a file or directory from a running machine."""

    path: str
    recursive: bool = False


class FsUploadResponse(BaseModel):
    """Result of uploading a binary/text file to a machine path."""

    path: str
    size: int