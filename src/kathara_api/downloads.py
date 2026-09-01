"""``Content-Disposition`` construction for the binary download endpoints."""

from urllib.parse import quote


def _ascii_fallback(filename: str) -> str:
    """``filename`` reduced to characters that are safe inside a quoted header string.

    A ``"`` or ``\\`` would end/escape the quoted string and a control character (CR/LF included)
    would be an outright header-injection attempt, so each is replaced by ``_``. Replaced rather
    than rejected: the file's *content* is what the caller asked for, the suggested name is
    presentation only — and the real, unmangled name still travels in the ``filename*`` form below.
    """
    safe = "".join("_" if c in ('"', "\\") or not (0x20 <= ord(c) < 0x7F) else c for c in filename)
    return safe or "download"


def attachment_headers(filename: str) -> dict[str, str]:
    """Headers marking the response as a download named ``filename``.

    Emits both forms RFC 6266 allows: the quoted ASCII ``filename=`` every client understands, and
    a percent-encoded ``filename*=UTF-8''…`` that preserves the name verbatim (non-ASCII included)
    for clients that support it. Needed because ``filename`` is derived from user-controlled input
    — a lab name, or the basename of an arbitrary ``?path=`` — so it can legitimately contain
    characters the quoted form cannot represent.
    """
    fallback = _ascii_fallback(filename)
    return {
        "Content-Disposition": (
            f'attachment; filename="{fallback}"; '
            f"filename*=UTF-8''{quote(filename or fallback, safe='')}"
        )
    }
