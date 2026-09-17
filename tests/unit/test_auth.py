"""Unit tests for require_auth_token (no Docker required)."""

from types import SimpleNamespace

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from kathara_api.dependencies import require_auth_token, require_auth_token_or_query
from kathara_api.errors import register_exception_handlers


def _client(monkeypatch, auth_token: str | None, *, allow_query: bool = False) -> TestClient:
    monkeypatch.setattr(
        "kathara_api.dependencies.get_settings",
        lambda: SimpleNamespace(auth_token=auth_token),
    )
    app = FastAPI()
    register_exception_handlers(app)
    dependency = require_auth_token_or_query if allow_query else require_auth_token

    @app.get("/protected", dependencies=[Depends(dependency)])
    def protected():
        return {"ok": True}

    return TestClient(app, raise_server_exceptions=False)


def test_no_token_configured_allows_every_request(monkeypatch):
    client = _client(monkeypatch, auth_token=None)
    assert client.get("/protected").status_code == 200


def test_missing_token_is_rejected_when_configured(monkeypatch):
    client = _client(monkeypatch, auth_token="secret")
    resp = client.get("/protected")
    assert resp.status_code == 401
    assert resp.json()["error_type"] == "UnauthorizedError"


def test_wrong_bearer_token_is_rejected(monkeypatch):
    client = _client(monkeypatch, auth_token="secret")
    resp = client.get("/protected", headers={"Authorization": "Bearer wrong"})
    assert resp.status_code == 401


def test_correct_bearer_token_is_accepted(monkeypatch):
    client = _client(monkeypatch, auth_token="secret")
    resp = client.get("/protected", headers={"Authorization": "Bearer secret"})
    assert resp.status_code == 200


def test_query_param_token_is_rejected_by_plain_require_auth_token(monkeypatch):
    """`require_auth_token` (used by every route except /stats/stream) only ever accepts the
    header — accepting `?token=` there too would just widen the token's exposure (proxy/access
    logs, browser history, Referer) for no route that actually needs it."""
    client = _client(monkeypatch, auth_token="secret")
    resp = client.get("/protected?token=secret")
    assert resp.status_code == 401


def test_correct_query_param_token_is_accepted_by_require_auth_token_or_query(monkeypatch):
    """Needed for EventSource callers, which can't set a custom header — see statsStreamUrl in
    services/frontend/src/services/api.ts. (`/tty/ws` has the same constraint but checks its
    token by hand rather than through this dependency — see routers/exec.py.)"""
    client = _client(monkeypatch, auth_token="secret", allow_query=True)
    resp = client.get("/protected?token=secret")
    assert resp.status_code == 200


def test_wrong_query_param_token_is_rejected_by_require_auth_token_or_query(monkeypatch):
    client = _client(monkeypatch, auth_token="secret", allow_query=True)
    resp = client.get("/protected?token=wrong")
    assert resp.status_code == 401
