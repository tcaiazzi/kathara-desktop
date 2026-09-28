"""Host enforcement against DNS rebinding.

A page that re-points its own domain at 127.0.0.1 controls Origin and Host together, so the
same-origin comparison in dependencies.is_origin_allowed passes for it; only the Host header still
names the attacker's domain. See dependencies.is_host_allowed.
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import kathara_api.config as config
from kathara_api.dependencies import is_host_allowed
from kathara_api.main import create_app

WS_PATH = "/api/labs/l/machines/pc1/tty/ws"


@pytest.fixture
def loopback_only(monkeypatch):
    """The production default: no extra hosts (conftest.py allows `testserver` for the suite)."""
    monkeypatch.setenv("KATHARA_API_ALLOWED_HOSTS", "")
    monkeypatch.setattr(config, "_settings", None)
    yield
    monkeypatch.setattr(config, "_settings", None)


# -- the helper ------------------------------------------------------------------------------

@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:5173", "LOCALHOST", "[::1]:8000", "127.0.0.1"])
def test_loopback_hosts_are_allowed(loopback_only, host):
    assert is_host_allowed(host)


@pytest.mark.parametrize("host", ["evil.example:8000", "evil.example", "127.0.0.1.evil.example", "localhost.evil", "[::2]:8000"])
def test_any_other_host_is_refused(loopback_only, host):
    assert not is_host_allowed(host)


def test_absent_host_is_allowed(loopback_only):
    """A browser always sends Host, so a request without one can't come from a rebinding page."""
    assert is_host_allowed(None)
    assert is_host_allowed("")


def test_listed_hosts_are_allowed(monkeypatch, loopback_only):
    """The Compose flow: Vite's proxy rewrites Host to the backend's service name."""
    monkeypatch.setenv("KATHARA_API_ALLOWED_HOSTS", "backend, Other.Example")
    monkeypatch.setattr(config, "_settings", None)
    assert is_host_allowed("backend:8000")
    assert is_host_allowed("other.example")
    assert not is_host_allowed("evil.example")


def test_wildcard_disables_the_check(monkeypatch, loopback_only):
    monkeypatch.setenv("KATHARA_API_ALLOWED_HOSTS", "*")
    monkeypatch.setattr(config, "_settings", None)
    assert is_host_allowed("evil.example:8000")


def test_a_concrete_bind_address_is_allowed(monkeypatch, loopback_only):
    """Whoever binds the backend to a LAN address means clients to reach it by that address."""
    monkeypatch.setenv("KATHARA_API_HOST", "192.168.1.5")
    monkeypatch.setattr(config, "_settings", None)
    assert is_host_allowed("192.168.1.5:8000")
    assert not is_host_allowed("192.168.1.6:8000")


def test_a_wildcard_bind_allows_no_extra_host(monkeypatch, loopback_only):
    monkeypatch.setenv("KATHARA_API_HOST", "0.0.0.0")
    monkeypatch.setattr(config, "_settings", None)
    assert not is_host_allowed("0.0.0.0:8000")
    assert not is_host_allowed("evil.example:8000")


# -- HTTP ------------------------------------------------------------------------------------

def test_a_read_addressed_to_a_foreign_host_is_refused(loopback_only):
    """GETs included: after rebinding the page is same-origin, so reading is the whole attack."""
    client = TestClient(create_app())
    res = client.get("/api/health", headers={"Host": "evil.example:8000"})
    assert res.status_code == 400
    assert res.json()["error_type"] == "ForbiddenHostError"


def test_a_rebinding_write_is_refused_even_with_a_matching_origin(loopback_only):
    client = TestClient(create_app())
    res = client.post(
        "/api/system/wipe",
        headers={"Host": "evil.example:8000", "Origin": "http://evil.example:8000"},
    )
    assert res.status_code == 400
    assert res.json()["error_type"] == "ForbiddenHostError"


def test_a_loopback_host_reaches_the_api(loopback_only):
    client = TestClient(create_app())
    assert client.get("/api/health", headers={"Host": "127.0.0.1:41234"}).status_code == 200


# -- websocket handshake ---------------------------------------------------------------------

def test_ws_handshake_refuses_a_rebinding_page(loopback_only):
    """Origin and Host agree, as they do after rebinding; the handshake must still be refused
    before the handler runs (a missing lab would otherwise disconnect too)."""
    client = TestClient(create_app())
    headers = {"Host": "evil.example:8000", "Origin": "http://evil.example:8000"}
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect(WS_PATH, headers=headers):
            pass
    assert excinfo.value.code == 4403


def test_ws_handshake_from_loopback_reaches_the_handler(loopback_only):
    client = TestClient(create_app())
    headers = {"Host": "127.0.0.1:41234", "Origin": "http://127.0.0.1:41234"}
    with client.websocket_connect(WS_PATH, headers=headers) as ws:
        assert ws.receive_json() == {"event": "error", "detail": "Lab `l` not found."}
