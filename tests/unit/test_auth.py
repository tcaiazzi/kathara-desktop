"""Unit tests for require_auth_token (no Docker required)."""

from types import SimpleNamespace

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from kathara_api.dependencies import require_auth_token
from kathara_api.errors import register_exception_handlers


def _client(monkeypatch, auth_token: str | None) -> TestClient:
    monkeypatch.setattr(
        "kathara_api.dependencies.get_settings",
        lambda: SimpleNamespace(auth_token=auth_token),
    )
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/protected", dependencies=[Depends(require_auth_token)])
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


def test_correct_query_param_token_is_accepted(monkeypatch):
    """Needed for EventSource/WebSocket callers, which can't set a custom header — see
    statsStreamUrl/ttyWsUrl in services/frontend/src/services/api.ts."""
    client = _client(monkeypatch, auth_token="secret")
    resp = client.get("/protected?token=secret")
    assert resp.status_code == 200


def test_wrong_query_param_token_is_rejected(monkeypatch):
    client = _client(monkeypatch, auth_token="secret")
    resp = client.get("/protected?token=wrong")
    assert resp.status_code == 401
