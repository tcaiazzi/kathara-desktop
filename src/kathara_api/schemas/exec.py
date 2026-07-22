"""Schemas for command execution on devices."""

from typing import Union

from pydantic import BaseModel


class ExecRequest(BaseModel):
    """A command to execute inside a running device."""

    command: Union[str, list[str]]
    # Wait for the device's startup commands to finish before executing. Defaults to False:
    # a REST call should run immediately and not block on (or interactively skip) startup scripts.
    wait: bool = False


class ExecResult(BaseModel):
    """Result of a synchronous command execution."""

    machine: str
    stdout: str
    stderr: str
    exit_code: int


class CopyFilesRequest(BaseModel):
    """Copy in-line file contents into a running device.

    Maps guest paths to their (UTF-8) textual contents.
    """

    files: dict[str, str]
