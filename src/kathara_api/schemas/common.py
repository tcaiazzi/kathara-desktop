"""Shared response schemas."""

from pydantic import BaseModel


class Message(BaseModel):
    """A simple textual acknowledgement."""

    detail: str


class ErrorResponse(BaseModel):
    """Uniform error body returned by the exception handlers."""

    detail: str
    error_type: str


def reject_lab_conf_quotes(value: str) -> str:
    """Reject a string that cannot be written into a ``lab.conf`` directive value.

    ``lab.conf``'s own grammar (mirrored by ``CONF_LINE_RE`` in ``services/lab_import.py``, and
    identical in Kathara's own ``LabParser``) has no escape mechanism: a value's quote character is
    stripped on read (``strip_quotes``), and a value containing a `"`/`'` doesn't even match the
    line regex at all. Silently writing such a value would either mangle it or make the whole line
    (and on reload, the whole lab) unparseable — so it is rejected up front instead, with a clear
    validation error.
    """
    if '"' in value or "'" in value or "\n" in value or "\r" in value:
        raise ValueError("cannot contain a quote character (\" or ') or a newline — not representable in lab.conf")
    return value
