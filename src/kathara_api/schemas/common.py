"""Shared response schemas."""

from pydantic import BaseModel


class Message(BaseModel):
    """A simple textual acknowledgement."""

    detail: str


class ErrorResponse(BaseModel):
    """Uniform error body returned by the exception handlers."""

    detail: str
    error_type: str
