"""Unit tests for the Docker exec-socket mechanics in services/docker_tty.py.

The Docker SDK hands back a different wrapper for the exec socket depending on its version and
transport (a raw socket, a urllib3 response, a `SocketIO`), with the usable reader/writer buried
under `_sock`/`socket`/`raw`. These tests build small fake wrapper chains to check how the code
finds that transport, which method it prefers, how it falls back when one fails, and what error
it raises when none works. No Docker involved; the thread-pool routing of the async wrappers is
covered separately in test_docker_tty_executor.py.
"""

import pytest

from kathara_api.services import docker_tty
from kathara_api.services.docker_tty import (
    DockerTtySession,
    _iter_socket_transports,
    _read_exec_socket,
    _write_exec_socket,
    resolve_shell_path,
)


class _Node:
    """A bare wrapper object: only the attributes a test gives it."""

    def __init__(self, **attrs):
        self.__dict__.update(attrs)


def _raising(exc: Exception):
    def fn(*_args):
        raise exc

    return fn


# ---------------------------------------------------------------------------
# resolve_shell_path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "shell, expected",
    [("bash", "/bin/bash"), ("sh", "/bin/sh"), ("ash", "/bin/ash"), ("zsh", "/bin/zsh"),
     ("  ZSH ", "/bin/zsh"), ("", "/bin/bash"), (None, "/bin/bash")],
)
def test_resolve_shell_path_maps_known_shells(shell, expected):
    assert resolve_shell_path(shell) == expected


def test_resolve_shell_path_rejects_an_unknown_shell():
    with pytest.raises(RuntimeError, match="Unsupported shell"):
        resolve_shell_path("fish")


# ---------------------------------------------------------------------------
# _iter_socket_transports
# ---------------------------------------------------------------------------


def test_transports_are_walked_breadth_first_in_attribute_order():
    deep = _Node()
    via_sock = _Node(raw=deep)
    via_socket = _Node()
    root = _Node(_sock=via_sock, socket=via_socket)

    assert list(_iter_socket_transports(root)) == [root, via_sock, via_socket, deep]


def test_transport_walk_visits_each_object_once_even_with_a_cycle():
    root = _Node()
    inner = _Node(_sock=root)
    root._sock = inner

    assert list(_iter_socket_transports(root)) == [root, inner]


def test_transport_walk_of_none_yields_nothing():
    assert list(_iter_socket_transports(None)) == []


# ---------------------------------------------------------------------------
# _write_exec_socket
# ---------------------------------------------------------------------------


def test_write_prefers_sendall_over_send_and_write():
    calls = []
    target = _Node(
        sendall=lambda d: calls.append(("sendall", d)),
        send=lambda d: calls.append(("send", d)),
        write=lambda d: calls.append(("write", d)),
    )

    _write_exec_socket(target, b"ls\n")

    assert calls == [("sendall", b"ls\n")]


def test_write_falls_back_to_the_next_method_when_one_fails():
    calls = []
    target = _Node(sendall=_raising(OSError("broken pipe")), send=lambda d: calls.append(d))

    _write_exec_socket(target, b"x")

    assert calls == [b"x"]


def test_write_skips_a_non_callable_attribute():
    calls = []
    target = _Node(sendall="not callable", write=lambda d: calls.append(d))

    _write_exec_socket(target, b"x")

    assert calls == [b"x"]


def test_write_reaches_a_nested_transport_when_the_outer_one_has_no_usable_writer():
    calls = []
    inner = _Node(sendall=lambda d: calls.append(d))
    outer = _Node(write=_raising(ValueError("closed file")), _sock=inner)

    _write_exec_socket(outer, b"x")

    assert calls == [b"x"]


def test_write_reports_every_failed_attempt_when_nothing_works():
    target = _Node(sendall=_raising(OSError("boom")), write=_raising(TypeError("bad type")))

    with pytest.raises(RuntimeError) as exc_info:
        _write_exec_socket(target, b"x")

    message = str(exc_info.value)
    assert "cannot write input" in message
    assert "_Node.sendall: boom" in message
    assert "_Node.write: bad type" in message


def test_write_without_any_writer_method_says_so():
    with pytest.raises(RuntimeError, match="no candidate writer methods found"):
        _write_exec_socket(_Node(), b"x")


# ---------------------------------------------------------------------------
# _read_exec_socket
# ---------------------------------------------------------------------------


def test_read_returns_bytes_unchanged_and_passes_the_size_through():
    sizes = []

    def recv(size):
        sizes.append(size)
        return b"output"

    assert _read_exec_socket(_Node(recv=recv), 1024) == b"output"
    assert sizes == [1024]


def test_read_encodes_a_str_chunk_as_utf8():
    assert _read_exec_socket(_Node(read=lambda _size: "caffè"), 16) == "caffè".encode()


def test_read_treats_none_as_end_of_stream():
    assert _read_exec_socket(_Node(recv=lambda _size: None), 16) == b""


def test_read_falls_back_to_read_when_recv_fails():
    target = _Node(recv=_raising(OSError("not a socket")), read=lambda _size: b"ok")

    assert _read_exec_socket(target, 16) == b"ok"


def test_read_skips_a_method_with_an_unexpected_return_type():
    inner = _Node(recv=lambda _size: b"ok")
    outer = _Node(read=lambda _size: 42, raw=inner)

    assert _read_exec_socket(outer, 16) == b"ok"


def test_read_reports_every_failed_attempt_when_nothing_works():
    target = _Node(recv=_raising(OSError("reset")), read=lambda _size: 42)

    with pytest.raises(RuntimeError) as exc_info:
        _read_exec_socket(target, 16)

    message = str(exc_info.value)
    assert "cannot read output" in message
    assert "_Node.recv: reset" in message
    assert "_Node.read: unexpected return type int" in message


def test_read_without_any_reader_method_says_so():
    with pytest.raises(RuntimeError, match="no candidate reader methods found"):
        _read_exec_socket(_Node(), 16)


# ---------------------------------------------------------------------------
# DockerTtySession (sync half)
# ---------------------------------------------------------------------------


class _FakeApiClient:
    """Records the low-level exec calls a session makes on `docker.APIClient`."""

    def __init__(self, exec_id="exec-1", sock=None):
        self.exec_id = exec_id
        self.sock = sock if sock is not None else _Node()
        self.calls = []

    def exec_create(self, container, **kwargs):
        self.calls.append(("exec_create", container, kwargs))
        return {"Id": self.exec_id} if self.exec_id else {}

    def exec_start(self, exec_id, **kwargs):
        self.calls.append(("exec_start", exec_id, kwargs))
        return self.sock

    def exec_resize(self, exec_id, **kwargs):
        self.calls.append(("exec_resize", exec_id, kwargs))


def test_session_rejects_an_unknown_shell_before_touching_docker():
    client = _FakeApiClient()

    with pytest.raises(RuntimeError, match="Unsupported shell"):
        DockerTtySession(client, "c1", "fish")
    assert client.calls == []


def test_session_start_opens_an_interactive_tty_exec_with_the_resolved_shell():
    client = _FakeApiClient()
    session = DockerTtySession(client, "c1", "sh")

    session.start()

    assert client.calls == [
        ("exec_create", "c1", {"cmd": ["/bin/sh"], "stdin": True, "stdout": True, "stderr": True, "tty": True}),
        ("exec_start", "exec-1", {"tty": True, "stream": False, "socket": True}),
    ]


def test_session_start_fails_when_docker_returns_no_exec_id():
    client = _FakeApiClient(exec_id=None)
    session = DockerTtySession(client, "c1", "bash")

    with pytest.raises(RuntimeError, match="Failed to create Docker exec session"):
        session.start()
    assert [c[0] for c in client.calls] == ["exec_create"]


def test_session_reads_and_writes_through_the_started_socket():
    written = []
    sock = _Node(recv=lambda _size: b"prompt$ ", sendall=lambda d: written.append(d))
    session = DockerTtySession(_FakeApiClient(sock=sock), "c1", "bash")
    session.start()

    assert session.read(64) == b"prompt$ "
    session.write(b"exit\n")
    assert written == [b"exit\n"]


def test_session_resize_maps_cols_and_rows_to_width_and_height():
    client = _FakeApiClient()
    session = DockerTtySession(client, "c1", "bash")
    session.start()

    session.resize(120, 35)

    assert client.calls[-1] == ("exec_resize", "exec-1", {"height": 35, "width": 120})


def test_session_close_closes_the_socket():
    closed = []
    session = DockerTtySession(_FakeApiClient(sock=_Node(close=lambda: closed.append(True))), "c1", "bash")
    session.start()

    session.close()

    assert closed == [True]


def test_session_close_is_safe_before_start_and_on_a_socket_without_close():
    DockerTtySession(_FakeApiClient(), "c1", "bash").close()

    session = DockerTtySession(_FakeApiClient(sock=_Node()), "c1", "bash")
    session.start()
    session.close()


# ---------------------------------------------------------------------------
# The dedicated TTY executor's lifecycle
# ---------------------------------------------------------------------------


def test_tty_executor_is_reused_until_shutdown_then_rebuilt():
    first = docker_tty._get_tty_executor()
    assert docker_tty._get_tty_executor() is first

    docker_tty.shutdown_tty_executor()
    with pytest.raises(RuntimeError):
        first.submit(lambda: None)

    rebuilt = docker_tty._get_tty_executor()
    assert rebuilt is not first
    assert rebuilt.submit(lambda: "ran").result(timeout=5) == "ran"


def test_shutdown_without_an_executor_is_a_no_op():
    docker_tty.shutdown_tty_executor()
    docker_tty.shutdown_tty_executor()
    assert docker_tty._TTY_EXECUTOR is None
