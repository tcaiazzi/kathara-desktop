"""Origin enforcement for the two paths CORS cannot cover.

A WebSocket handshake never reaches HTTP middleware, and several state-changing endpoints are
CORS "simple requests" that are sent without a preflight — so neither is protected by
CORSMiddleware. See dependencies.is_origin_allowed.
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import kathara_api.config as config
from kathara_api.dependencies import is_origin_allowed
from kathara_api.main import create_app

WS_PATH = "/api/labs/l/machines/pc1/tty/ws"


@pytest.fixture
def no_cached_settings(monkeypatch):
    """create_app() and the helper both read get_settings(), which caches process-wide."""
    monkeypatch.setattr(config, "_settings", None)
    yield
    monkeypatch.setattr(config, "_settings", None)


# -- the helper ------------------------------------------------------------------------------

def test_absent_origin_is_allowed(no_cached_settings):
    """Non-browser callers (the desktop shell's fetch, tests, curl) send none. Not a hole: a
    browser always sends Origin on a WS handshake and on any non-GET/HEAD request."""
    assert is_origin_allowed(None, "127.0.0.1:8000")
    assert is_origin_allowed("", "127.0.0.1:8000")


def test_same_origin_is_allowed(no_cached_settings):
    assert is_origin_allowed("http://127.0.0.1:41234", "127.0.0.1:41234")


def test_foreign_origin_is_refused(no_cached_settings):
    assert not is_origin_allowed("https://evil.example", "127.0.0.1:8000")


def test_same_host_different_port_is_refused(no_cached_settings):
    assert not is_origin_allowed("http://127.0.0.1:9999", "127.0.0.1:8000")


def test_configured_origin_is_allowed(monkeypatch, no_cached_settings):
    """The Vite dev flow: the proxy forwards the browser's Origin verbatim, so it never matches
    Host and has to be allow-listed — the same knob that governs cross-origin HTTP."""
    monkeypatch.setenv("KATHARA_API_CORS_ORIGINS", "http://localhost:5173")
    assert is_origin_allowed("http://localhost:5173", "backend:8000")
    assert not is_origin_allowed("http://localhost:9999", "backend:8000")


# -- websocket handshake ---------------------------------------------------------------------

def test_ws_handshake_refuses_a_foreign_origin(no_cached_settings):
    """The drive-by: any page the user visits could otherwise open this socket and get a shell.

    Asserting the close code, not merely "it raised": the handler closes with 4401 for a bad
    token and 4403 for a bad origin, and a lab that doesn't exist would also disconnect — so a
    bare `raises(Exception)` here would pass for the wrong reason.
    """
    client = TestClient(create_app())
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(WS_PATH, headers={"origin": "https://evil.example"}):
            pass
    assert excinfo.value.code == 4403


@pytest.mark.parametrize(
    ("origin", "cors"),
    [
        ("http://localhost:5173", "http://localhost:5173"),  # the Vite dev flow
        ("http://testserver", ""),  # same origin as the request's Host
        (None, ""),  # non-browser client
    ],
)
def test_ws_handshake_passes_the_origin_gate(monkeypatch, no_cached_settings, origin, cors):
    """Getting as far as the handler is the assertion: the lab doesn't exist, so a connection
    that reaches an `error` frame is one the origin check let through."""
    monkeypatch.setenv("KATHARA_API_CORS_ORIGINS", cors)
    client = TestClient(create_app())
    headers = {"origin": origin} if origin else {}
    with client.websocket_connect(WS_PATH, headers=headers) as ws:
        assert ws.receive_json() == {"event": "error", "detail": "Lab `l` not found."}


# -- state-changing HTTP ---------------------------------------------------------------------

def test_wipe_refuses_a_foreign_origin(no_cached_settings):
    """`POST /system/wipe` has no body, so it is a CORS simple request: no preflight, and the
    side effect lands even though the attacker can't read the response."""
    client = TestClient(create_app())
    res = client.post("/api/system/wipe", headers={"Origin": "https://evil.example"})
    assert res.status_code == 403
    assert res.json()["error_type"] == "ForbiddenOriginError"


def test_same_origin_post_is_allowed(no_cached_settings):
    client = TestClient(create_app())
    res = client.post(
        "/api/system/wipe", headers={"Origin": "http://testserver", "Host": "testserver"}
    )
    assert res.status_code != 403


def test_get_is_not_gated(no_cached_settings):
    """Reads are left to CORS: the browser blocks the response, and there is no side effect."""
    client = TestClient(create_app())
    res = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert res.status_code == 200
