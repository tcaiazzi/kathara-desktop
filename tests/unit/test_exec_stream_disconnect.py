"""Unit tests for the /exec/stream SSE generator (routers/exec.py) — see I4 in docs/audit_2.md.

Driven by calling ``exec_command_stream`` directly and pulling from the ``EventSourceResponse`` it
returns (``sse_starlette`` stores the generator verbatim as ``response.body_iterator``), rather
than through a TestClient/ASGI transport: both httpx's sync ``TestClient`` and its async
``ASGITransport`` fully drain a streaming ASGI response before handing anything back to the
caller, which makes them unusable for a generator that (by design, in the disconnect test) never
finishes on its own.
"""

import asyncio
import base64
import json

import pytest

from kathara_api.routers import exec as exec_router
from kathara_api.schemas.exec import ExecRequest
from tests.helpers import NeverEndingExecStream


class _FakeRequest:
    """Stand-in for fastapi.Request, controllable from the test instead of a real ASGI receive
    channel."""

    def __init__(self):
        self.disconnected = False
        self.poll_count = 0

    async def is_disconnected(self) -> bool:
        self.poll_count += 1
        return self.disconnected


class _SimpleExecStream:
    """Fake IExecStream for the happy path: a fixed list of (stdout, stderr) chunks, then done."""

    def __init__(self, chunks, exit_code=0):
        self._chunks = iter(chunks)
        self._exit_code = exit_code
        self._stream = self
        self.closed = False
        self.exit_code_calls = 0

    def __next__(self):
        return next(self._chunks)

    def exit_code(self):
        self.exit_code_calls += 1
        return self._exit_code

    def close(self):
        self.closed = True


class _FakeExecService:
    def __init__(self, stream):
        self._stream = stream

    def exec_stream(self, lab_name, machine_name, command, wait=False):
        return self._stream


async def _drain(aiter):
    events = []
    try:
        while True:
            events.append(await aiter.__anext__())
    except StopAsyncIteration:
        pass
    return events


def _parse(event):
    return event["event"], json.loads(event["data"])


def test_happy_path_emits_output_then_exit(monkeypatch):
    """Baseline: the rewritten generator must keep behaving exactly like before for a stream that
    finishes on its own with the client still connected."""
    stream = _SimpleExecStream([(b"hello", b""), (b"", b"world")], exit_code=3)
    request = _FakeRequest()
    service = _FakeExecService(stream)

    async def scenario():
        resp = await exec_router.exec_command_stream(
            "lab", "pc1", ExecRequest(command=["echo", "hi"]), request, service
        )
        return await asyncio.wait_for(_drain(resp.body_iterator), timeout=5)

    events = asyncio.run(scenario())

    kinds = [_parse(e) for e in events]
    assert kinds[0] == ("output", {"stream": "stdout", "data": base64.b64encode(b"hello").decode()})
    assert kinds[1] == ("output", {"stream": "stderr", "data": base64.b64encode(b"world").decode()})
    assert kinds[2] == ("exit", {"exit_code": 3})
    assert stream.closed  # force-close still runs on the normal exit path (idempotent cleanup)


def test_client_disconnect_unblocks_a_never_ending_stream(monkeypatch):
    """The actual regression: a command that never produces output must not pin a threadpool
    worker forever once the client is gone. `next(stream)` blocks in a real thread here — cancelling
    the async task consuming it does nothing (anyio's default abandon_on_cancel=False), so the only
    way out is the disconnect watcher force-closing the underlying stream from a second task."""
    monkeypatch.setattr(exec_router, "_DISCONNECT_POLL_INTERVAL_SECONDS", 0.05)
    stream = NeverEndingExecStream()
    request = _FakeRequest()
    service = _FakeExecService(stream)

    async def scenario():
        resp = await exec_router.exec_command_stream(
            "lab", "pc1", ExecRequest(command=["sleep", "10000"]), request, service
        )
        consume = asyncio.create_task(_drain(resp.body_iterator))
        await asyncio.sleep(0.2)
        assert not consume.done()  # still genuinely blocked on next(stream), not finished already
        request.disconnected = True
        return await asyncio.wait_for(consume, timeout=5)

    events = asyncio.run(scenario())

    assert events == []  # no client left to read a final "exit" event, so none is sent
    assert stream.closed  # the force-close is what unblocked the background thread


@pytest.mark.parametrize("chunks", [[], [(b"a", b"")]])
def test_force_close_exec_stream_reaches_the_inner_stream(chunks):
    """`_force_close_exec_stream` must reach ``stream._stream.close()`` — the shape of a real
    Kathara `DockerExecStream` wrapping a docker-py `CancellableStream` — not a nonexistent
    top-level `close()` (see the function's docstring for why the old `getattr(stream, "close",
    None)` was always None)."""
    stream = _SimpleExecStream(chunks)
    exec_router._force_close_exec_stream(stream)
    assert stream.closed


def test_force_close_exec_stream_is_a_silent_noop_without_an_inner_stream():
    class NoInnerStream:
        pass

    exec_router._force_close_exec_stream(NoInnerStream())  # must not raise
