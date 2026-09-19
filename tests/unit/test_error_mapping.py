"""Unit tests for the exception -> HTTP status mapping (no Docker required)."""

import docker.errors
import fs.errors
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from Kathara.exceptions import (
    LabNotFoundError,
    MachineAlreadyExistsError,
    MachineOptionError,
    PrivilegeError,
)
from pydantic import BaseModel, Field

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


def test_unknown_error_body_does_not_leak_the_exception_message():
    # str(exc) can carry absolute host paths or other internals; the full message is logged
    # server-side (see the caplog test below) but must
    # never reach the client body for an unmapped exception.
    client = _client_raising(RuntimeError("/home/someuser/secret-lab-name: no such file"))
    resp = client.get("/boom")
    assert resp.status_code == 500
    assert "secret-lab-name" not in resp.text
    assert resp.json()["detail"] == "Internal server error."


def test_unknown_error_is_still_logged_with_its_original_message(caplog):
    client = _client_raising(RuntimeError("/home/someuser/secret-lab-name: no such file"))
    with caplog.at_level("ERROR"):
        client.get("/boom")
    assert "secret-lab-name" in caplog.text


def test_builtin_connection_error_maps_to_503():
    # Kathara's image check raises the builtin ConnectionError when the registry is unreachable.
    client = _client_raising(ConnectionError("registry unreachable"))
    resp = client.get("/boom")
    assert resp.status_code == 503
    assert resp.json()["error_type"] == "ConnectionError"


def test_illegal_back_reference_maps_to_400_not_500():
    """pyfilesystem2 raises this for an offline-fs path that climbs above its own root (e.g.
    `../../etc`) — OSFS already refuses to touch anything outside its root regardless, so this is
    purely about not logging a legitimate bad-input as an unhandled server error."""
    client = _client_raising(fs.errors.IllegalBackReference("/../../etc"))
    resp = client.get("/boom")
    assert resp.status_code == 400
    assert resp.json()["error_type"] == "IllegalBackReference"


def test_fs_resource_not_found_maps_to_404():
    client = _client_raising(fs.errors.ResourceNotFound("/missing"))
    resp = client.get("/boom")
    assert resp.status_code == 404
    assert resp.json()["error_type"] == "ResourceNotFound"


def test_fs_file_expected_maps_to_400():
    client = _client_raising(fs.errors.FileExpected("/adir"))
    assert client.get("/boom").status_code == 400


def test_fs_directory_expected_maps_to_400():
    client = _client_raising(fs.errors.DirectoryExpected("/afile"))
    assert client.get("/boom").status_code == 400


@pytest.mark.parametrize(
    "exc",
    [
        fs.errors.DirectoryExists("/d"),
        fs.errors.FileExists("/f"),
        fs.errors.DestinationExists("/dst"),
        fs.errors.DirectoryNotEmpty("/d"),
    ],
)
def test_fs_already_there_errors_map_to_409(exc):
    assert _client_raising(exc).get("/boom").status_code == 409


def test_docker_image_not_found_maps_to_404_even_without_a_response():
    """docker.errors.ImageNotFound built by hand (no HTTP `response` attached, as Kathara's own
    DockerImage does) makes `APIError.status_code` — a property reading `exc.response` — return
    None. `make_handler`'s `getattr(exc, "status_code", code)` would find that property instead of
    falling back to `code`, and crash. The dedicated handler must decide by type instead."""
    client = _client_raising(docker.errors.ImageNotFound("no such image: kathara/doesnotexist"))
    resp = client.get("/boom")
    assert resp.status_code == 404
    assert resp.json()["error_type"] == "ImageNotFound"


def test_docker_api_error_generic_maps_to_502():
    client = _client_raising(docker.errors.APIError("500 Server Error"))
    resp = client.get("/boom")
    assert resp.status_code == 502
    assert resp.json()["error_type"] == "APIError"


def test_http_exception_gets_the_uniform_error_body():
    """FastAPI's own default handler for this class already answers with the right status code —
    it just returns `{"detail": ...}` with no `error_type`, unlike every other handler here."""
    client = _client_raising(HTTPException(status_code=404, detail="Not Found"))
    resp = client.get("/boom")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not Found", "error_type": "HTTPException"}


def test_http_exception_is_not_logged_as_an_unexpected_error(caplog):
    client = _client_raising(HTTPException(status_code=404, detail="Not Found"))
    client.get("/boom")
    assert not any(record.levelname == "ERROR" for record in caplog.records)


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
