"""FastAPI dependency providers."""

import hmac
from urllib.parse import urlsplit

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


def is_origin_allowed(origin: str | None, host_header: str | None) -> bool:
    """Whether a request carrying ``origin`` may act on this backend.

    This exists because CORS cannot cover everything this API exposes:

    * A WebSocket handshake never goes through HTTP middleware at all — Starlette's
      ``CORSMiddleware`` returns immediately for a non-HTTP scope — so ``/tty/ws`` is reachable
      cross-origin from any web page the user happens to visit.
    * Several state-changing HTTP endpoints qualify as CORS *simple requests* and so are sent
      without a preflight for the browser to block: ``POST /system/wipe`` and
      ``/system/shutdown`` (no body), ``POST /labs/{n}/deploy``/``undeploy`` (optional body) and
      ``POST /labs/upload`` (``multipart/form-data``). The response stays unreadable to the
      attacker, but the side effect has already happened.

    Allowed:

    * **No Origin at all.** Non-browser callers (the desktop shell's own ``fetch`` calls, tests,
      curl) send none. This is not a hole a web page can slip through: browsers send ``Origin``
      on *every* WebSocket handshake, same-origin included, and on every request whose method
      isn't GET/HEAD.
    * **An origin listed in KATHARA_API_CORS_ORIGINS.** Same knob that already governs
      cross-origin HTTP, so a separately-served frontend is configured in exactly one place.
    * **Same origin as this request's Host** — the page was served by this very backend, which is
      the desktop app (and any standalone run serving the built SPA via spa.py).

    The last check compares ``netloc`` only, so it ignores the scheme: behind a TLS terminator an
    ``https://`` origin with the same host:port would pass. That is acceptable while every
    supported deployment is loopback HTTP, but it is a real limitation rather than an oversight.
    """
    if not origin:
        return True
    if origin in get_settings().cors_origins_list():
        return True
    return bool(host_header) and urlsplit(origin).netloc == host_header

