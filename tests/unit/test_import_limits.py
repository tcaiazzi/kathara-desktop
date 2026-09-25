"""Unit tests for the upload size and count caps.

`upload_lab`/`extract_zip` and `lab_gallery.py` cap a lab the same way — 200 files, 5 MB per file,
20 MB in total by default — because an uploaded archive is no more trusted than a remote one. The
caps live on `ApiSettings` (config.py), shared by both paths, and are exercised here at three
levels: the
low-level `LabStore` helpers directly, `LabStore.extract_zip` against realistic (honestly-sized)
inputs, and the request-level body-size middleware in main.py.
"""

import io
import socket
import threading
import time
import zipfile

import pytest
import uvicorn
from fastapi.testclient import TestClient

from kathara_api.config import ApiSettings, get_settings
from kathara_api.dependencies import get_service
from kathara_api.errors import ApiError
from kathara_api.main import create_app
from kathara_api.services.lab_store import LabStore
from tests.helpers import make_service, zip_bytes


def test_import_limits_are_configurable():
    # Same defaults the gallery import enforces (see lab_gallery.py), carried on ApiSettings and
    # overridable the same way as e.g. cors_origins.
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


_MB = 1 << 20


def test_read_bounded_accepts_exactly_the_cap_and_names_it_when_refusing():
    assert LabStore._read_bounded(io.BytesIO(b"hello"), cap=5) == b"hello"
    with pytest.raises(ApiError, match=r"^Upload is larger than the .* this import allows\.$"):
        LabStore._read_bounded(io.BytesIO(b"hello!"), cap=5)


def test_read_bounded_counts_every_chunk_not_just_the_last():
    # Reads go 1 MiB at a time: 2 MiB against a 1.5 MiB cap is only over when the chunks are summed.
    with pytest.raises(ApiError):
        LabStore._read_bounded(io.BytesIO(b"x" * (2 * _MB)), cap=int(1.5 * _MB))


def test_read_bounded_returns_a_multi_chunk_upload_byte_for_byte():
    data = bytes(range(256)) * (10 * 1024)  # 2.5 MiB, three reads
    assert LabStore._read_bounded(io.BytesIO(data), cap=3 * _MB) == data


def test_copy_with_cap_accepts_exactly_both_caps():
    dst = io.BytesIO()
    assert LabStore._copy_with_cap(io.BytesIO(b"hello"), dst, "f", per_file_cap=5, written_so_far=95, total_cap=100) == 5


def test_copy_with_cap_counts_every_chunk_of_one_file():
    with pytest.raises(ApiError, match=r"^`big\.bin` is larger than the .* this import allows\.$"):
        LabStore._copy_with_cap(
            io.BytesIO(b"x" * (2 * _MB)), io.BytesIO(), "big.bin",
            per_file_cap=int(1.5 * _MB), written_so_far=0, total_cap=10 * _MB,
        )


def test_copy_with_cap_names_the_total_cap_when_refusing():
    with pytest.raises(ApiError, match=r"^This archive is larger than the .* this import allows\.$"):
        LabStore._copy_with_cap(io.BytesIO(b"hello"), io.BytesIO(), "f", per_file_cap=100, written_so_far=98, total_cap=100)


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
    """Every member is under the per-file cap and the compressed upload is under the per-lab cap;
    only the decompressed sum exceeds it — the case `_copy_with_cap`'s running total exists for.

    The archive is deflated on purpose: stored, it would be larger than its content, and the cap
    on the raw upload (the same `max_bytes_per_lab`) would reject it before any member is counted.
    The total is only crossed by the third payload file, so a running total that forgets earlier
    files cannot pass.
    """
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 1000)
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 800)
    store = LabStore(tmp_path / "labs")
    entries = {"lab.conf": b'pc1[0]="A"\n'}
    entries.update({f"f{i}": b"x" * 300 for i in range(3)})  # 911 bytes decompressed
    archive = zip_bytes(entries, compression=zipfile.ZIP_DEFLATED)
    assert len(archive.getvalue()) < 800  # so the raw-upload cap is not what fires

    with pytest.raises(ApiError, match="This archive is larger than"):
        store.extract_zip("demo", archive)
    assert not (tmp_path / "labs" / "demo").exists()


def test_extract_zip_accepts_a_decompressed_total_of_exactly_the_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 1000)
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 911)
    store = LabStore(tmp_path / "labs")
    entries = {"lab.conf": b'pc1[0]="A"\n'}
    entries.update({f"f{i}": b"x" * 300 for i in range(3)})  # exactly 911 bytes decompressed

    store.extract_zip("demo", zip_bytes(entries, compression=zipfile.ZIP_DEFLATED))

    assert (tmp_path / "labs" / "demo" / "f2").read_bytes() == b"x" * 300


def test_extract_zip_enforces_the_raw_upload_size_cap(tmp_path, monkeypatch):
    # A cap small enough that even the zip's own container overhead trips it, with every member's
    # real content just one byte — proves this is _read_bounded (the raw compressed upload)
    # rejecting it, not any of the per-member/cumulative decompressed-size checks.
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 5)
    store = LabStore(tmp_path / "labs")
    with pytest.raises(ApiError):
        store.extract_zip("demo", zip_bytes({"lab.conf": b"x"}))
    assert not (tmp_path / "labs" / "demo").exists()


def test_extract_zip_accepts_exactly_the_file_count_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_files_per_lab", 3)
    store = LabStore(tmp_path / "labs")

    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "a": b"1", "b": b"2"}))

    assert sorted(p.name for p in (tmp_path / "labs" / "demo").iterdir()) == ["a", "b", "lab.conf"]


def test_extract_zip_names_the_count_when_refusing(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_files_per_lab", 2)
    store = LabStore(tmp_path / "labs")

    with pytest.raises(ApiError, match=r"^This archive has 3 entries, more than the 2 this import allows\.$"):
        store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "a": b"1", "b": b"2"}))


def test_extract_zip_accepts_a_member_of_exactly_the_per_file_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 11)
    store = LabStore(tmp_path / "labs")

    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n'}))  # exactly 11 bytes

    assert (tmp_path / "labs" / "demo" / "lab.conf").read_bytes() == b'pc1[0]="A"\n'


def test_extract_zip_names_an_oversized_member_by_its_declared_size(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_file", 10)
    store = LabStore(tmp_path / "labs")

    with pytest.raises(ApiError, match=r"^`big` is .* more than the .* this import allows\.$"):
        store.extract_zip("demo", zip_bytes({"lab.conf": b"x", "big": b"X" * 1000}))


def test_extract_zip_still_works_within_every_cap(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[image]="kathara/base"\n'}))
    assert (tmp_path / "labs" / "demo" / "lab.conf").exists()


# -- the request-level body-size middleware (main.py) ------------------------------------------


@pytest.fixture
def client_and_service(tmp_path):
    service = make_service(store=LabStore(tmp_path / "labs"))
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def test_body_size_middleware_rejects_a_declared_content_length_over_the_cap(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 10)
    service = make_service(store=LabStore(tmp_path / "labs"))
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        # The middleware decides from the header alone, before the body is ever read — a small
        # real body with an inflated declared Content-Length is enough to prove that, and is also
        # exactly what a client lying about its own upload size would look like on the wire.
        resp = client.post(
            "/api/labs",
            content=b'{"name": "x"}',
            headers={"content-length": str(10_000_000)},
        )
    assert resp.status_code == 413


def test_body_size_middleware_allows_a_normal_request(client_and_service):
    client, _service = client_and_service
    resp = client.get("/api/labs")
    assert resp.status_code == 200


def test_body_size_middleware_drains_the_body_before_responding_so_a_browser_isnt_reset(tmp_path, monkeypatch):
    """A client that doesn't send `Expect: 100-continue` (every browser fetch()/XHR upload, unlike
    curl's default for multipart) is still writing its request body when the 413 above is sent.
    Closing the connection with that body still in flight resets it out from under the client,
    surfacing as a generic "NetworkError"/"Failed to fetch" instead of ever showing this JSON
    response — so `_enforce_body_size` must drain `request.stream()` before responding.

    `TestClient`'s in-process ASGI transport can't reproduce the reset (there's no real socket to
    reset), so this drives a real uvicorn server over a loopback socket by hand.
    """
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 100)
    service = make_service(store=LabStore(tmp_path / "labs"))
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
            b"POST /api/labs HTTP/1.1\r\n"
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
    # max_bytes_per_lab is editable at runtime from the Settings page
    # (KatharaService.update_settings) — the middleware must read it fresh on every request rather
    # than the value ApiSettings had when create_app() ran, or a Settings save would silently stop
    # taking effect for the rest of the process's life.
    client, _service = client_and_service
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 10)
    resp = client.post(
        "/api/labs",
        content=b'{"name": "x"}',
        headers={"content-length": str(10_000_000)},
    )
    assert resp.status_code == 413
