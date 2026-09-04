"""Unit tests for the upload/import size and count caps (E9).

Before this, neither `import_lab` (JSON) nor `upload_lab`/`extract_zip` (.zip) had any limit at
all — unlike `lab_gallery.py`, which has always capped a *remote* lab at 200 files / 5 MB per
file / 20 MB total. The caps now live on `ApiSettings` (config.py), shared by all three paths, and
are exercised here at three levels: the low-level `LabStore` helpers directly, `LabStore.
extract_zip`/`KatharaService.import_lab` against realistic (honestly-sized) inputs, and the
request-level body-size middleware in main.py.
"""

import io
import socket
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient

from kathara_api.config import ApiSettings, get_settings
from kathara_api.dependencies import get_service
from kathara_api.errors import ApiError
from kathara_api.main import create_app
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, zip_bytes


def test_import_limits_are_configurable():
    # Same defaults the gallery import has always enforced (see lab_gallery.py), now promoted to
    # ApiSettings and overridable the same way as e.g. cors_origins.
    settings = ApiSettings()
    assert settings.max_files_per_lab == 200
    assert settings.max_bytes_per_file == 5 * 1024 * 1024
    assert settings.max_bytes_per_lab == 20 * 1024 * 1024
    overridden = ApiSettings(max_files_per_lab=1, max_bytes_per_file=2, max_bytes_per_lab=3)
    assert (overridden.max_files_per_lab, overridden.max_bytes_per_file, overridden.max_bytes_per_lab) == (1, 2, 3)


# -- LabStore._read_bounded / _copy_with_cap, directly -----------------------------------------


def test_read_bounded_accepts_data_within_the_cap():
    assert LabStore._read_bounded(io.BytesIO(b"hello"), cap=10) == b"hello"


def test_read_bounded_rejects_data_over_the_cap():
    with pytest.raises(ApiError):
        LabStore._read_bounded(io.BytesIO(b"hello world"), cap=5)


def test_copy_with_cap_accepts_within_both_caps():
    dst = io.BytesIO()
    written = LabStore._copy_with_cap(io.BytesIO(b"hello"), dst, "f.txt", per_file_cap=10, written_so_far=0, total_cap=100)
    assert written == 5
    assert dst.getvalue() == b"hello"


def test_copy_with_cap_rejects_over_the_per_file_cap():
    with pytest.raises(ApiError):
        LabStore._copy_with_cap(
            io.BytesIO(b"hello world"), io.BytesIO(), "f.txt", per_file_cap=5, written_so_far=0, total_cap=100
        )


def test_copy_with_cap_rejects_over_the_cumulative_cap_even_when_under_the_per_file_cap():
    # This is what stops a zip bomb built as many small-but-not-tiny files, each individually
    # under `per_file_cap`, from still exhausting the cumulative per-lab budget.
    with pytest.raises(ApiError):
        LabStore._copy_with_cap(
            io.BytesIO(b"hello"), io.BytesIO(), "f.txt", per_file_cap=100, written_so_far=98, total_cap=100
        )


# -- LabStore.extract_zip, against realistic (honestly-sized) archives -------------------------


def test_extract_zip_enforces_the_file_count_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_files_per_lab", 2)
    store = LabStore(tmp_path / "labs")
    with pytest.raises(ApiError):
        store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "a": b"1", "b": b"2"}))
    assert not (tmp_path / "labs" / "demo").exists()


def test_extract_zip_enforces_the_per_file_size_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 10)
    store = LabStore(tmp_path / "labs")
    with pytest.raises(ApiError):
        store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "big": b"X" * 1000}))
    assert not (tmp_path / "labs" / "demo").exists()


def test_extract_zip_enforces_the_cumulative_size_cap_across_many_small_files(tmp_path, monkeypatch):
    # Every single member is honestly small and individually under the per-file cap; only the sum
    # exceeds the per-lab budget — the scenario _copy_with_cap's running total exists for.
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 1000)
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 100)
    store = LabStore(tmp_path / "labs")
    entries = {"lab.conf": b'pc1[0]="A"\n'}
    entries.update({f"f{i}": b"x" * 50 for i in range(5)})  # 250 bytes of payload, 100-byte budget
    with pytest.raises(ApiError):
        store.extract_zip("demo", zip_bytes(entries))
    assert not (tmp_path / "labs" / "demo").exists()


def test_extract_zip_enforces_the_raw_upload_size_cap(tmp_path, monkeypatch):
    # A cap small enough that even the zip's own container overhead trips it, with every member's
    # real content just one byte — proves this is _read_bounded (the raw compressed upload)
    # rejecting it, not any of the per-member/cumulative decompressed-size checks.
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 5)
    store = LabStore(tmp_path / "labs")
    with pytest.raises(ApiError):
        store.extract_zip("demo", zip_bytes({"lab.conf": b"x"}))
    assert not (tmp_path / "labs" / "demo").exists()


def test_extract_zip_still_works_within_every_cap(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[image]="kathara/base"\n'}))
    assert (tmp_path / "labs" / "demo" / "lab.conf").exists()


# -- KatharaService.import_lab (JSON), same caps ------------------------------------------------


def _service(tmp_path) -> KatharaService:
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    return service


def test_import_lab_enforces_the_file_count_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_files_per_lab", 1)
    service = _service(tmp_path)
    with pytest.raises(ApiError):
        service.import_lab("toobig", {"lab.conf": "pc1[image]=kathara/base\n", "extra.txt": "x"}, [])
    assert not service.store.lab_dir("toobig").exists()


def test_import_lab_enforces_the_per_file_size_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 10)
    service = _service(tmp_path)
    with pytest.raises(ApiError):
        service.import_lab("toobig", {"lab.conf": "x" * 100}, [])


def test_import_lab_enforces_the_total_size_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 1000)
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 50)
    service = _service(tmp_path)
    files = {"lab.conf": "pc1[image]=kathara/base\n"}
    files.update({f"f{i}.txt": "x" * 20 for i in range(5)})  # 100 bytes, each well under per-file cap
    with pytest.raises(ApiError):
        service.import_lab("toobig", files, [])


def test_import_lab_still_works_within_every_cap(tmp_path):
    service = _service(tmp_path)
    lab, _warnings = service.import_lab("fine", {"lab.conf": "pc1[image]=kathara/base\n"}, [])
    assert lab.name == "fine"


# -- Request body-size middleware (main.py) ------------------------------------------------------


@pytest.fixture
def client_and_service(tmp_path):
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def test_body_size_middleware_rejects_a_declared_content_length_over_the_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 10)
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        # The middleware decides from the header alone, before the body is ever read — a small
        # real body with an inflated declared Content-Length is enough to prove that, and is also
        # exactly what a client lying about its own upload size would look like on the wire.
        resp = client.post(
            "/api/labs/import",
            content=b'{"name": "x"}',
            headers={"content-length": str(10_000_000)},
        )
    assert resp.status_code == 413


def test_body_size_middleware_allows_a_normal_request(client_and_service):
    client, _service = client_and_service
    resp = client.get("/api/labs")
    assert resp.status_code == 200


def test_body_size_middleware_drains_the_body_before_responding_so_a_browser_isnt_reset(tmp_path, monkeypatch):
    """Regression test for a real bug found via manual testing in a browser: a client that doesn't
    send `Expect: 100-continue` (every browser fetch()/XHR upload, unlike curl's default for
    multipart) is still writing its request body when the 413 above is sent. Closing the
    connection with that body still in flight resets it out from under the client, surfacing as a
    generic "NetworkError"/"Failed to fetch" instead of ever showing this JSON response — see
    `_enforce_body_size`, which now drains `request.stream()` before responding.

    `TestClient`'s in-process ASGI transport can't reproduce the reset (there's no real socket to
    reset), so this drives a real uvicorn server over a loopback socket by hand.
    """
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 100)
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="critical"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 5
        while not server.started:
            if time.monotonic() > deadline:
                raise TimeoutError("uvicorn didn't start in time")
            time.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]

        payload = b"x" * (2 * 1024 * 1024)  # well over the 100-byte + 1MiB cap
        request_head = (
            b"POST /api/labs/import HTTP/1.1\r\n"
            b"Host: 127.0.0.1\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: " + str(len(payload)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n"
        )
        with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
            sock.sendall(request_head)
            # Mimic a browser: write the whole body without waiting for a response first. This
            # must not raise BrokenPipeError/ConnectionResetError.
            sock.sendall(payload)
            sock.settimeout(5)
            response = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
    finally:
        server.should_exit = True
        thread.join(timeout=5)

    assert response.startswith(b"HTTP/1.1 413")


def test_body_size_middleware_picks_up_a_cap_change_without_rebuilding_the_app(client_and_service, monkeypatch):
    # max_bytes_per_lab is now editable at runtime from the Settings page
    # (KatharaService.update_settings) — the middleware must read it fresh on every request rather
    # than the value ApiSettings had when create_app() ran, or a Settings save would silently stop
    # taking effect for the rest of the process's life.
    client, _service = client_and_service
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 10)
    resp = client.post(
        "/api/labs/import",
        content=b'{"name": "x"}',
        headers={"content-length": str(10_000_000)},
    )
    assert resp.status_code == 413
