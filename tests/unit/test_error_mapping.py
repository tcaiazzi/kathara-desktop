"""Unit tests for the exception -> HTTP status mapping (no Docker required)."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from Kathara.exceptions import (
    LabNotFoundError,
    MachineAlreadyExistsError,
    MachineOptionError,
    PrivilegeError,
)
from kathara_api.errors import SettingsLockedError, register_exception_handlers


def _client_raising(exc: Exception) -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/boom")
    def boom():
        raise exc

    return TestClient(app, raise_server_exceptions=False)


def test_lab_not_found_maps_to_404():
    client = _client_raising(LabNotFoundError("nope"))
    resp = client.get("/boom")
    assert resp.status_code == 404
    assert resp.json()["error_type"] == "LabNotFoundError"


def test_already_exists_maps_to_409():
    client = _client_raising(MachineAlreadyExistsError("pc1"))
    assert client.get("/boom").status_code == 409


def test_machine_option_maps_to_400():
    client = _client_raising(MachineOptionError("bad option"))
    assert client.get("/boom").status_code == 400


def test_privilege_error_maps_to_403():
    client = _client_raising(PrivilegeError("You must be root in order to start device `pc1`."))
    resp = client.get("/boom")
    assert resp.status_code == 403
    assert resp.json()["error_type"] == "PrivilegeError"


def test_settings_locked_maps_to_409():
    client = _client_raising(SettingsLockedError("locked"))
    assert client.get("/boom").status_code == 409


def test_syntax_error_maps_to_422():
    client = _client_raising(SyntaxError("Invalid device name"))
    assert client.get("/boom").status_code == 422


def test_unknown_error_maps_to_500():
    client = _client_raising(RuntimeError("unexpected"))
    resp = client.get("/boom")
    assert resp.status_code == 500
    assert resp.json()["error_type"] == "RuntimeError"


def test_builtin_connection_error_maps_to_503():
    # Kathara's image check raises the builtin ConnectionError when the registry is unreachable.
    client = _client_raising(ConnectionError("registry unreachable"))
    resp = client.get("/boom")
    assert resp.status_code == 503
    assert resp.json()["error_type"] == "ConnectionError"


class _ValidatedBody(BaseModel):
    name: str = Field(pattern=r"^[a-z0-9_]{1,30}$")


def _client_with_validated_route() -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    @app.post("/validated")
    def validated(payload: _ValidatedBody, count: int = 0):
        return {"ok": True}

    return TestClient(app, raise_server_exceptions=False)


def test_request_body_validation_error_flattens_to_a_plain_string_detail():
    """A Pydantic `Field` validation failure (e.g. a device name failing its name pattern) must
    come back as `ErrorResponse` (`detail: str`), not FastAPI's own default `{"detail": [...]}`
    shape — a client coercing a non-string `detail` to text (as the frontend's `ApiError` does)
    would otherwise render `[object Object]` instead of the real message."""
    client = _client_with_validated_route()

    resp = client.post("/validated", json={"name": "BAD Name!"})

    assert resp.status_code == 422
    body = resp.json()
    assert isinstance(body["detail"], str)
    assert "name" in body["detail"]
    assert "pattern" in body["detail"]
    assert body["error_type"] == "RequestValidationError"


def test_query_param_validation_error_also_flattens():
    client = _client_with_validated_route()

    resp = client.post("/validated?count=notanumber", json={"name": "ok"})

    assert resp.status_code == 422
    body = resp.json()
    assert isinstance(body["detail"], str)
    assert "count" in body["detail"]


def test_multiple_validation_errors_are_joined_into_one_string():
    client = _client_with_validated_route()

    resp = client.post("/validated?count=notanumber", json={"name": "BAD Name!"})

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert isinstance(detail, str)
    assert "name" in detail
    assert "count" in detail
    assert ";" in detail  # more than one message, joined rather than truncated to the first
