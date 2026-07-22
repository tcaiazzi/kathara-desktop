"""Unit tests for the exception -> HTTP status mapping (no Docker required)."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from Kathara.exceptions import (
    LabNotFoundError,
    MachineAlreadyExistsError,
    MachineOptionError,
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
