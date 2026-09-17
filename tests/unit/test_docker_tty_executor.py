"""Unit tests for the dedicated TTY thread pool (services/docker_tty.py) and the session cap
enforced by routers/exec.py:tty_live_ws — see I4 in docs/audit_2.md.

Each open live terminal holds one thread for as long as it's connected (a blocking socket read in
a loop). Before this fix that thread came from asyncio's default executor, shared with every other
`asyncio.to_thread` call in the app; these tests check both halves of the fix: the async wrapper
methods actually run off the caller's thread, and a session beyond the configured cap is rejected
outright instead of queueing silently.
"""

import asyncio
import threading

import pytest
from fastapi.testclient import TestClient

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.routers import exec as exec_router
from kathara_api.services.docker_tty import DockerTtySession


class _RecordingSession(DockerTtySession):
    """Records which thread each sync method actually ran on, without touching Docker."""

    def __init__(self):
        self.thread_ids: list[int] = []

    def start(self):
        self.thread_ids.append(threading.get_ident())

    def read(self, size: int = 4096) -> bytes:
        self.thread_ids.append(threading.get_ident())
        return b"x"

    def write(self, data: bytes) -> None:
        self.thread_ids.append(threading.get_ident())

    def resize(self, cols: int, rows: int) -> None:
        self.thread_ids.append(threading.get_ident())

    def close(self) -> None:
        self.thread_ids.append(threading.get_ident())


def test_async_methods_run_off_the_caller_thread():
    async def scenario():
        session = _RecordingSession()
        await session.astart()
        await session.aread(4096)
        await session.awrite(b"hi")
        await session.aresize(80, 24)
        await session.aclose()
        return session.thread_ids

    caller_thread = threading.get_ident()
    thread_ids = asyncio.run(scenario())

    assert len(thread_ids) == 5
    assert all(tid != caller_thread for tid in thread_ids)


def test_async_methods_return_the_same_values_as_their_sync_counterparts():
    class _Echo(DockerTtySession):
        def __init__(self):
            pass

        def start(self):
            return "started"

        def read(self, size: int = 4096) -> bytes:
            return b"payload"

        def resize(self, cols: int, rows: int) -> None:
            self.last_resize = (cols, rows)

    async def scenario():
        session = _Echo()
        chunk = await session.aread(4096)
        await session.aresize(100, 40)
        return chunk, session.last_resize

    chunk, resize = asyncio.run(scenario())
    assert chunk == b"payload"
    assert resize == (100, 40)


# ---------------------------------------------------------------------------
# Session cap, driven through the real /tty/ws route
# ---------------------------------------------------------------------------


class _GatedSession(DockerTtySession):
    """A session whose `read()` blocks (simulating an open interactive terminal) until the test
    releases a shared gate, or the route calls `close()`."""

    def __init__(self, *_args, **_kwargs):
        self.gate = threading.Event()

    def start(self):
        pass

    def read(self, size: int = 4096) -> bytes:
        self.gate.wait(timeout=5)
        return b""  # ends pump_output once released

    def write(self, data: bytes) -> None:
        pass

    def resize(self, cols: int, rows: int) -> None:
        pass

    def close(self) -> None:
        self.gate.set()


class _DummyMachine:
    class client:
        api = object()

    id = "container123"


class _FakeService:
    def get_machine_api_object(self, lab_name, machine_name):
        return _DummyMachine()


class _FakeSettings:
    def __init__(self, tty_max_sessions):
        self.auth_token = None
        self.tty_max_sessions = tty_max_sessions


@pytest.fixture
def _tty_app(monkeypatch):
    monkeypatch.setattr(exec_router, "DockerTtySession", _GatedSession)
    monkeypatch.setattr(exec_router, "_tty_active_sessions", 0)
    app = create_app()
    app.dependency_overrides[get_service] = lambda: _FakeService()
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_single_session_connects_and_closes_cleanly(_tty_app, monkeypatch):
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings(tty_max_sessions=32))

    with _tty_app.websocket_connect("/api/labs/l/machines/m/tty/ws") as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_json({"type": "close"})
        assert ws.receive_json() == {"event": "closed"}


def test_session_beyond_the_cap_is_rejected_with_1013(_tty_app, monkeypatch):
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings(tty_max_sessions=1))

    with _tty_app.websocket_connect("/api/labs/l/machines/m/tty/ws") as first:
        assert first.receive_json() == {"event": "ready"}

        with _tty_app.websocket_connect("/api/labs/l/machines/m/tty/ws") as second:
            msg = second.receive_json()
            assert msg["event"] == "error"
            assert "Too many concurrent" in msg["detail"]
            from starlette.websockets import WebSocketDisconnect

            with pytest.raises(WebSocketDisconnect) as exc_info:
                second.receive_json()
            assert exc_info.value.code == 1013

        # The first session is unaffected by the second one being turned away.
        first.send_json({"type": "close"})
        assert first.receive_json() == {"event": "closed"}


def test_a_freed_slot_can_be_reused(_tty_app, monkeypatch):
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings(tty_max_sessions=1))

    with _tty_app.websocket_connect("/api/labs/l/machines/m/tty/ws") as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_json({"type": "close"})
        assert ws.receive_json() == {"event": "closed"}

    # The slot from the closed session above must be free now, not leaked.
    with _tty_app.websocket_connect("/api/labs/l/machines/m/tty/ws") as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_json({"type": "close"})
        assert ws.receive_json() == {"event": "closed"}


def test_malformed_resize_reports_an_error_without_closing_the_session(_tty_app, monkeypatch):
    """See docs/audit_2.md minor reperti: a non-numeric cols/rows used to bubble a ValueError
    out to the route's outer `except Exception`, which tears down the whole session."""
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings(tty_max_sessions=32))

    with _tty_app.websocket_connect("/api/labs/l/machines/m/tty/ws") as ws:
        assert ws.receive_json() == {"event": "ready"}

        ws.send_json({"type": "resize", "cols": "not-a-number", "rows": 24})
        assert ws.receive_json() == {
            "event": "error",
            "detail": "`cols`/`rows` must be numeric.",
        }

        # The session is still alive: a normal close still works afterwards.
        ws.send_json({"type": "close"})
        assert ws.receive_json() == {"event": "closed"}
