"""FastAPI dependency providers."""

import hmac

from fastapi import Request

from .config import get_settings
from .errors import UnauthorizedError
from .services.kathara_service import KatharaService

# A single process-wide service instance (the underlying Kathara facade is a singleton).
_service = KatharaService()


def get_service() -> KatharaService:
    """Provide the shared KatharaService instance."""
    return _service


def _request_token(request: Request) -> str | None:
    """Pull a caller-supplied token from wherever this request could have put one.

    The `Authorization` header covers every plain fetch (see services/frontend/src/services/
    api.ts), but a browser's native `WebSocket`/`EventSource` can't set custom headers on their
    handshake — those instead pass ``?token=`` (ttyWsUrl/statsStreamUrl), so both are accepted
    here rather than forcing every caller through one shape.
    """
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[len("bearer ") :]
    return request.query_params.get("token")


def require_auth_token(request: Request) -> None:
    """Reject the request unless it carries the pairing token configured via
    ``KATHARA_API_AUTH_TOKEN`` (see config.ApiSettings.auth_token).

    A no-op when no token is configured, which is the default for every deployment except the
    desktop app (services/desktop/src/backend.ts generates one per launch) — Docker Compose and
    plain dev runs keep today's no-auth behavior untouched.
    """
    expected = get_settings().auth_token
    if not expected:
        return
    supplied = _request_token(request)
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise UnauthorizedError("Invalid or missing auth token.")
