"""The live-terminal websocket protocol of routers/exec.py:tty_live_ws, driven through the real
route with a scripted session in place of Docker.

What the session cap, the origin gate and a malformed resize do is covered elsewhere
(test_docker_tty_executor.py, test_origin_policy.py). This file covers the rest of the
conversation: the pairing-token check on the handshake, output forwarded as base64, input and
resize reaching the session, every message the route refuses without closing the session, and
the cleanup that runs however the session ends.
"""

import base64
import queue

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.routers import exec as exec_router
from kathara_api.services.docker_tty import DockerTtySession

WS_PATH = "/api/labs/l/machines/m/tty/ws"


class _ScriptedSession(DockerTtySession):
    """Records what the route sends to the terminal and plays back whatever the test queues as
    its output. `read()` blocks on that queue, the way a real exec socket blocks until the shell
    prints something, so a test decides exactly when output appears."""

    instances: list["_ScriptedSession"] = []

    def __init__(self, client, container_id, shell):
        self.client = client
        self.container_id = container_id
        self.shell = shell
        self.written: list[bytes] = []
        self.resized: list[tuple[int, int]] = []
        self.closed = False
        self._output: queue.Queue = queue.Queue()
        _ScriptedSession.instances.append(self)

    def emit(self, item) -> None:
        """Queue one `read()` result: bytes to return, or an exception to raise."""
        self._output.put(item)

    def start(self) -> None:
        pass

    def read(self, size: int = 4096) -> bytes:
        item = self._output.get(timeout=5)
        if isinstance(item, Exception):
            raise item
        return item

    def write(self, data: bytes) -> None:
        self.written.append(data)

    def resize(self, cols: int, rows: int) -> None:
        self.resized.append((cols, rows))

    def close(self) -> None:
        self.closed = True
        self._output.put(b"")  # unblock a read still waiting in the TTY pool


class _DockerApi:
    pass


class _Machine:
    def __init__(self, api=None, container_id="container123"):
        self.client = type("DockerClient", (), {"api": api})()
        self.id = container_id


class _FakeService:
    def __init__(self, machine):
        self.machine = machine
        self.lookups: list[tuple[str, str]] = []

    def get_machine_api_object(self, lab_name, machine_name):
        self.lookups.append((lab_name, machine_name))
        return self.machine


class _FakeSettings:
    def __init__(self, auth_token=None):
        self.auth_token = auth_token
        self.tty_max_sessions = 32


API = _DockerApi()


@pytest.fixture
def tty(monkeypatch):
    """A TestClient on a fresh app whose tty route uses `_ScriptedSession` and a fake service.

    Yields `(client, service)`. Checks on teardown that the route's session counter is back
    to zero, i.e. that however a test ended its session, the slot was released.
    """
    _ScriptedSession.instances = []
    monkeypatch.setattr(exec_router, "DockerTtySession", _ScriptedSession)
    monkeypatch.setattr(exec_router, "_tty_active_sessions", 0)
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings())
    service = _FakeService(_Machine(api=API))
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()
    assert exec_router._tty_active_sessions == 0


def _close(ws) -> None:
    ws.send_json({"type": "close"})
    assert ws.receive_json() == {"event": "closed"}


# ---------------------------------------------------------------------------
# Handshake
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("query", ["", "?token=wrong"])
def test_handshake_without_the_right_token_is_refused_with_4401(tty, monkeypatch, query):
    client, service = tty
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings(auth_token="s3cret"))

    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(WS_PATH + query):
            pass

    assert exc_info.value.code == 4401
    assert service.lookups == []  # refused before the machine is ever looked up


def test_handshake_with_the_right_token_opens_the_session(tty, monkeypatch):
    client, _ = tty
    monkeypatch.setattr(exec_router, "get_settings", lambda: _FakeSettings(auth_token="s3cret"))

    with client.websocket_connect(WS_PATH + "?token=s3cret") as ws:
        assert ws.receive_json() == {"event": "ready"}
        _close(ws)


def test_session_is_opened_on_the_machine_container_with_the_requested_shell(tty):
    client, service = tty

    with client.websocket_connect(WS_PATH + "?shell=ash") as ws:
        assert ws.receive_json() == {"event": "ready"}
        _close(ws)

    assert service.lookups == [("l", "m")]
    [session] = _ScriptedSession.instances
    assert (session.client, session.container_id, session.shell) == (API, "container123", "ash")


@pytest.mark.parametrize("machine", [_Machine(api=None), _Machine(api=API, container_id=None)])
def test_a_machine_without_a_docker_container_reports_an_error_and_closes(tty, machine):
    client, service = tty
    service.machine = machine

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {
            "event": "error",
            "detail": "Live TTY requires a Docker-backed running machine.",
        }
        assert ws.receive_json() == {"event": "closed"}

    assert _ScriptedSession.instances == []


# ---------------------------------------------------------------------------
# Terminal traffic
# ---------------------------------------------------------------------------


def test_terminal_output_is_forwarded_as_base64(tty):
    client, _ = tty
    raw = b"\x1b[1mroot@m:~#\x1b[0m \xff"

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        _ScriptedSession.instances[0].emit(raw)

        assert ws.receive_json() == {"event": "output", "data": base64.b64encode(raw).decode("ascii")}
        _close(ws)


def test_input_is_written_to_the_terminal_as_utf8(tty):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_json({"type": "input", "data": "echo è\n"})
        ws.send_json({"type": "input"})
        _close(ws)

    assert _ScriptedSession.instances[0].written == ["echo è\n".encode(), b""]


def test_resize_reaches_the_terminal_with_defaults_for_missing_fields(tty):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_json({"type": "resize", "cols": 200, "rows": "50"})
        ws.send_json({"type": "resize"})
        _close(ws)

    assert _ScriptedSession.instances[0].resized == [(200, 50), (120, 35)]


def test_end_of_output_stops_forwarding_but_keeps_the_session_open(tty):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        _ScriptedSession.instances[0].emit(b"")

        ws.send_json({"type": "input", "data": "still here\n"})
        _close(ws)

    assert _ScriptedSession.instances[0].written == [b"still here\n"]


def test_a_failing_read_is_reported_without_closing_the_session(tty):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        _ScriptedSession.instances[0].emit(RuntimeError("exec socket gone"))

        assert ws.receive_json() == {"event": "error", "detail": "exec socket gone"}
        _close(ws)


# ---------------------------------------------------------------------------
# Refused messages: an error frame, and the session stays usable
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "frame, detail",
    [
        ("not json", "Invalid JSON message."),
        ('{"type": "input", "data": 42}', "`data` must be a string."),
        ('{"type": "exec", "cmd": "reboot"}', "Unsupported message type."),
        ("{}", "Unsupported message type."),
    ],
)
def test_a_refused_message_reports_an_error_and_keeps_the_session(tty, frame, detail):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_text(frame)
        assert ws.receive_json() == {"event": "error", "detail": detail}
        _close(ws)

    assert _ScriptedSession.instances[0].written == []


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


def test_close_message_closes_the_terminal(tty):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}
        _close(ws)

    assert _ScriptedSession.instances[0].closed


def test_client_disconnect_without_close_message_still_closes_the_terminal(tty):
    client, _ = tty

    with client.websocket_connect(WS_PATH) as ws:
        assert ws.receive_json() == {"event": "ready"}

    assert _ScriptedSession.instances[0].closed
