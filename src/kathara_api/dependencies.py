"""FastAPI dependency providers."""

import hmac
from urllib.parse import urlsplit

from fastapi import Request

from .config import get_settings
from .errors import ShellOnlyError, UnauthorizedError
from .services.kathara_service import KatharaService

# A single process-wide service instance (the underlying Kathara facade is a singleton).
_service = KatharaService()


def get_service() -> KatharaService:
    """Provide the shared KatharaService instance."""
    return _service


def _request_token(request: Request, *, allow_query: bool) -> str | None:
    """Pull a caller-supplied token from wherever this request could have put one.

    The `Authorization` header covers every plain fetch, whatever its method (see
    services/frontend/src/services/api.ts). ``allow_query=True`` additionally accepts ``?token=``,
    needed only where a browser's native ``EventSource`` can't set custom headers on its handshake —
    ``statsStreamUrl`` and ``labEventsUrl`` are the callers of that shape (``/tty/ws`` is a native
    ``WebSocket`` with the same constraint, but it checks its token by hand rather than through this
    dependency — see routers/exec.py). Every other route only ever needs the header, so accepting ``?token=``
    there too would just widen the token's exposure (query strings end up in proxy/access logs,
    browser history, `Referer` headers) for no functional reason.
    """
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[len("bearer ") :]
    if allow_query:
        return request.query_params.get("token")
    return None


def tokens_match(supplied: str | None, expected: str) -> bool:
    """Constant-time comparison of a caller's token with the configured one. On bytes, because
    ``hmac.compare_digest`` raises for a ``str`` with a non-ASCII character — a 500 instead of the
    401 any other wrong token gets."""
    return bool(supplied) and hmac.compare_digest(supplied.encode(), expected.encode())


def _check_token(request: Request, *, allow_query: bool) -> None:
    expected = get_settings().auth_token
    if not expected:
        return
    if not tokens_match(_request_token(request, allow_query=allow_query), expected):
        raise UnauthorizedError("Invalid or missing auth token.")


def require_auth_token(request: Request) -> None:
    """Reject the request unless it carries the pairing token configured via
    ``KATHARA_API_AUTH_TOKEN`` (see config.ApiSettings.auth_token), via the ``Authorization``
    header only.

    A no-op when no token is configured, which is the default for every deployment except the
    desktop app (services/desktop/src/backend.ts generates one per launch) — Docker Compose and
    plain dev runs keep the no-auth default untouched.
    """
    _check_token(request, allow_query=False)


def require_auth_token_or_query(request: Request) -> None:
    """Same as :func:`require_auth_token`, but also accepts ``?token=``.

    Reserved for the plain HTTP routes a browser's native ``EventSource`` can't attach an
    ``Authorization`` header to (``/stats/stream``, ``/events``) — every other route should keep using
    :func:`require_auth_token` instead, so the token isn't accepted from a URL (and therefore
    from proxy logs, browser history, `Referer`) where a header would do.
    """
    _check_token(request, allow_query=True)


# Header, not `Authorization`: the request also carries the ordinary pairing token there, and the
# route that needs this one must pass both checks.
SHELL_TOKEN_HEADER = "x-kathara-shell-token"


def require_shell_token(request: Request) -> None:
    """Reject the request unless it carries ``KATHARA_API_SHELL_TOKEN`` (see
    config.ApiSettings.shell_token) in the ``X-Kathara-Shell-Token`` header.

    Unlike :func:`require_auth_token` this is *not* a no-op when unset: with no shell token
    configured there is no desktop shell to trust — nothing to pick a host folder in a native
    dialog, nothing to check the user's password — so the route is closed to everyone.
    """
    expected = get_settings().shell_token
    if not expected or not tokens_match(request.headers.get(SHELL_TOKEN_HEADER), expected):
        raise ShellOnlyError("Only the desktop app itself can make this request.")


# Names that can only ever mean this machine. `urlsplit(...).hostname` drops IPv6 brackets, hence
# the bare "::1".
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# Wildcard binds: they say which interfaces listen, not which name a client uses to get here.
_WILDCARD_BINDS = frozenset({"", "0.0.0.0", "::"})


def is_host_allowed(host_header: str | None) -> bool:
    """Whether this backend should answer a request addressed to ``host_header``.

    The only defense against DNS rebinding, which :func:`is_origin_allowed` cannot stop on its
    own: a page on ``http://evil.example:8000`` that re-points its name at 127.0.0.1 sends
    ``Origin: http://evil.example:8000`` *and* ``Host: evil.example:8000``, so it passes the
    same-origin comparison, and every GET response becomes readable to it. The Host header is the
    one thing that still names the attacker's domain.

    Allowed: loopback names, the address this process was told to bind when it is a concrete one,
    and whatever ``KATHARA_API_ALLOWED_HOSTS`` lists (``*`` disables the check). A request with no
    Host at all is allowed: a browser always sends one, so its absence can't be a rebinding page.
    """
    if not host_header:
        return True
    settings = get_settings()
    extra = settings.allowed_hosts_list()
    if "*" in extra:
        return True
    hostname = urlsplit(f"//{host_header}").hostname
    if hostname is None:
        return False
    if hostname in _LOOPBACK_HOSTS or hostname in extra:
        return True
    bind = settings.host.strip().strip("[]").lower()
    return bind not in _WILDCARD_BINDS and hostname == bind


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
      the desktop app (and any standalone run serving the built SPA via spa.py). Sound only
      because :func:`is_host_allowed` has already vetted that Host: both headers come from the
      browser, and a rebinding page controls them together.

    The last check compares ``netloc`` only, so it ignores the scheme: behind a TLS terminator an
    ``https://`` origin with the same host:port would pass. That is acceptable while every
    supported deployment is loopback HTTP, but it is a real limitation rather than an oversight.
    """
    if not origin:
        return True
    if origin in get_settings().cors_origins_list():
        return True
    return bool(host_header) and urlsplit(origin).netloc == host_header

