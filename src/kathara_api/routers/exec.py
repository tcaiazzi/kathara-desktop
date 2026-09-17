"""Command execution endpoints (synchronous and streaming)."""

import asyncio
import base64
import contextlib
import hmac
import json
import logging

import chardet
from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from ..config import get_settings
from ..dependencies import get_service, is_origin_allowed, require_auth_token
from ..schemas.exec import ExecRequest, ExecResult
from ..services.docker_tty import DockerTtySession
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs/{lab_name}/machines/{machine_name}", tags=["exec"])
logger = logging.getLogger(__name__)

# How often the SSE stream below polls for a client disconnect while a chunk read is in flight
# (see _force_close_exec_stream and event_generator).
_DISCONNECT_POLL_INTERVAL_SECONDS = 0.5

# How many tty_live_ws sessions are open right now. Mutated only from coroutines on this single
# event loop (never from a thread), same as the `stop` flag inside tty_live_ws itself, so no lock
# is needed. Checked against settings.tty_max_sessions, which also sizes the dedicated TTY
# executor in services/docker_tty.py — a ThreadPoolExecutor queues work past max_workers instead
# of rejecting it, which would otherwise make session N+1 look like a hung terminal instead of a
# clean, immediate refusal.
_tty_active_sessions = 0


def _iter_exec_stream(stream):
    """Adapt an IExecStream (implements `__next__` but not `__iter__`) into a real iterator."""
    while True:
        try:
            yield next(stream)
        except StopIteration:
            return


def _force_close_exec_stream(stream) -> None:
    """Best-effort: unblock a `next(stream)` sitting in a threadpool worker by closing the
    underlying Docker socket from here.

    `IExecStream` (Kathara upstream) exposes no public close()/cancel() — a prior
    `getattr(stream, "close", None)` in this module was always None and did nothing. On the only
    manager reachable here (Docker, via KatharaService.exec_stream), the private `_stream`
    attribute of `DockerExecStream` (Kathara.manager.docker.exec_stream) is actually a
    `docker.types.daemon.CancellableStream`, whose own docstring documents exactly this use
    ("cancel from another thread"): its close() shuts the exec's HTTP socket down, and its
    `__next__` already turns the resulting `urllib3.exceptions.ProtocolError`/`OSError` into a
    clean `StopIteration` — already handled by `_iter_exec_stream` above, so no new except clause
    is needed anywhere in the read path for this.

    No contract is being relied on beyond that: if this shape changes (a different manager, a
    future docker-py/Kathara version, a test double), we simply do nothing — this is a
    best-effort cleanup in a background path with no client left to report a failure to, which is
    why a broad `except` here is scoped to this cleanup only and does not fall under I5 (mapping
    exceptions into HTTP responses) — there is no response being built at this point.
    """
    inner = getattr(stream, "_stream", None)
    close = getattr(inner, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception:
        logger.debug("exec stream force-close failed", exc_info=True)


def _decode(data: bytes) -> str:
    if not data:
        return ""
    encoding = chardet.detect(data).get("encoding") or "utf-8"
    try:
        return data.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        return data.decode("utf-8", errors="replace")


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _output_parts(chunk):
    """Yield ``(stream_name, bytes)`` for the non-empty halves of an exec ``(stdout, stderr)`` chunk."""
    stdout, stderr = chunk
    if stdout:
        yield "stdout", stdout
    if stderr:
        yield "stderr", stderr


def _sse_json(stream_name: str, data: bytes) -> str:
    return json.dumps({"stream": stream_name, "data": _b64(data)})


async def _ws_send_error(websocket: WebSocket, detail: str) -> None:
    await websocket.send_text(json.dumps({"event": "error", "detail": detail}))


async def _recv_json(websocket: WebSocket):
    """Receive one text frame and parse it as JSON; on invalid JSON send an error event and return
    None (so the caller can ``continue``)."""
    raw = await websocket.receive_text()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        await _ws_send_error(websocket, "Invalid JSON message.")
        return None


@router.post("/exec", response_model=ExecResult, dependencies=[Depends(require_auth_token)])
def exec_command(
    lab_name: str,
    machine_name: str,
    payload: ExecRequest,
    service: KatharaService = Depends(get_service),
) -> ExecResult:
    """Execute a command, wait for completion, and return its combined output."""
    stdout, stderr, exit_code = service.exec_command(
        lab_name, machine_name, payload.command, wait=payload.wait
    )
    return ExecResult(
        machine=machine_name,
        stdout=_decode(stdout),
        stderr=_decode(stderr),
        exit_code=exit_code,
    )


@router.post("/exec/stream", dependencies=[Depends(require_auth_token)])
async def exec_command_stream(
    lab_name: str,
    machine_name: str,
    payload: ExecRequest,
    request: Request,
    service: KatharaService = Depends(get_service),
):
    """Stream a command's stdout/stderr as Server-Sent Events, then a final exit event.

    Event data payloads:
      - ``{"stream": "stdout"|"stderr", "data": "<base64>"}`` for output chunks
      - ``{"exit_code": <int>}`` as the terminal ``exit`` event
    """
    stream = await run_in_threadpool(
        service.exec_stream, lab_name, machine_name, payload.command, payload.wait
    )

    async def event_generator():
        disconnected = False

        async def watch_disconnect() -> None:
            nonlocal disconnected
            while True:
                if await request.is_disconnected():
                    disconnected = True
                    # This is the only thing that can free a `next(stream)` stuck in the
                    # threadpool: run_in_threadpool/iterate_in_threadpool run on
                    # anyio.to_thread.run_sync with the default abandon_on_cancel=False, so
                    # cancelling the task consuming the stream does NOT interrupt an in-flight
                    # blocking read — anyio waits for the worker thread to return on its own.
                    # Closing the socket from this independent task is what makes it return.
                    await run_in_threadpool(_force_close_exec_stream, stream)
                    return
                await asyncio.sleep(_DISCONNECT_POLL_INTERVAL_SECONDS)

        watcher = asyncio.create_task(watch_disconnect())
        try:
            async for chunk in iterate_in_threadpool(_iter_exec_stream(stream)):
                if disconnected:
                    break
                for stream_name, data in _output_parts(chunk):
                    yield {"event": "output", "data": _sse_json(stream_name, data)}
            if not disconnected:
                # No client left to read this for a disconnected stream — skip it, and the
                # exec_inspect() call behind it.
                exit_code = await run_in_threadpool(stream.exit_code)
                yield {"event": "exit", "data": f'{{"exit_code": {exit_code}}}'}
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
            # Idempotent (CancellableStream.close() checks response.raw.closed) — covers the
            # normal/error exit paths too, not just the disconnect one above.
            await run_in_threadpool(_force_close_exec_stream, stream)

    return EventSourceResponse(event_generator())


@router.websocket("/tty/ws")
async def tty_live_ws(
    websocket: WebSocket,
    lab_name: str,
    machine_name: str,
    shell: str = Query(default="bash"),
    service: KatharaService = Depends(get_service),
):
    """Interactive websocket TTY bridge for a running machine.

    This endpoint currently targets Docker-backed machines through the backend
    container API object and a low-level exec socket.

    Client messages:
      - {"type": "input", "data": "..."}
      - {"type": "resize", "cols": 120, "rows": 35}
      - {"type": "close"}

    Server messages:
      - {"event": "ready"}
      - {"event": "output", "data": "<base64>"}
      - {"event": "error", "detail": "..."}
      - {"event": "closed"}

    Query params:
      - shell: one of bash|sh|ash|zsh (default: bash)
    """
    # A WebSocket handshake carries no Authorization header a browser can set, so the pairing
    # token (see dependencies.require_auth_token, applied to exec_command/exec_command_stream
    # above) travels as a query param instead — checked by hand rather than via the same
    # Depends(): FastAPI's dependency solver can't supply a `Request`-typed dependency in a
    # websocket scope (there is no Request there, only WebSocket), and errors on every connection
    # if one is attached router- or route-wide, e.g. through the router-level `dependencies=`
    # main.py otherwise uses for every other router. Closing before ever calling accept() makes
    # uvicorn reject the handshake itself (an HTTP 403, verified manually), rather than opening a
    # live socket only to immediately close it — an unpaired caller gets no socket at all. A
    # no-op when auth_token is unset, same as require_auth_token.
    expected_token = get_settings().auth_token
    if expected_token:
        supplied_token = websocket.query_params.get("token")
        if not supplied_token or not hmac.compare_digest(supplied_token, expected_token):
            await websocket.close(code=4401)
            return

    # Unlike every HTTP route, this one gets no help from CORSMiddleware: Starlette's
    # CORSMiddleware returns immediately for a non-HTTP scope, so a page on any origin can open
    # this socket. A browser always sends Origin on a WebSocket handshake — same-origin included
    # — so checking it here is what closes that. Same close-before-accept() shape as the token
    # check above, with a distinct code so the two failures are told apart client-side.
    if not is_origin_allowed(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=4403)
        return

    await websocket.accept()

    global _tty_active_sessions
    if _tty_active_sessions >= get_settings().tty_max_sessions:
        # Beyond this cap, a session would just queue on the dedicated TTY executor (see
        # services/docker_tty.py) behind whichever session frees up first — indistinguishable
        # from a hung terminal. Reject it outright instead. 1013 is the standard WS "Try Again
        # Later" close code.
        await _ws_send_error(websocket, "Too many concurrent live terminals; close one and retry.")
        await websocket.close(code=1013)
        return
    _tty_active_sessions += 1

    session: DockerTtySession | None = None
    output_task: asyncio.Task | None = None
    stop = False

    try:
        # Docker API call (update_lab_from_api + a container lookup) — off the event loop like
        # every other backend call in this function (session.astart/aread/awrite/aresize below all
        # already run on a dedicated executor; this one deliberately stays on asyncio's default,
        # since it is a one-shot lookup, not a persistent per-session thread — see I4 in
        # docs/audit_2.md for why the two must not share an executor).
        machine_obj = await asyncio.to_thread(service.get_machine_api_object, lab_name, machine_name)
        client = getattr(getattr(machine_obj, "client", None), "api", None)
        container_id = getattr(machine_obj, "id", None)
        if client is None or not container_id:
            raise RuntimeError("Live TTY requires a Docker-backed running machine.")

        session = DockerTtySession(client, container_id, shell)
        await session.astart()

        async def pump_output():
            try:
                while not stop:
                    chunk = await session.aread(4096)
                    if not chunk:
                        break
                    await websocket.send_text(json.dumps({"event": "output", "data": _b64(chunk)}))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                try:
                    await _ws_send_error(websocket, str(exc))
                except Exception:
                    pass
                return

        output_task = asyncio.create_task(pump_output())
        await websocket.send_text(json.dumps({"event": "ready"}))

        while True:
            msg = await _recv_json(websocket)
            if msg is None:
                continue

            msg_type = msg.get("type")
            if msg_type == "close":
                break

            if msg_type == "resize":
                try:
                    cols = int(msg.get("cols", 120))
                    rows = int(msg.get("rows", 35))
                except (TypeError, ValueError):
                    await _ws_send_error(websocket, "`cols`/`rows` must be numeric.")
                    continue
                await session.aresize(cols, rows)
                continue

            if msg_type == "input":
                data = msg.get("data", "")
                if not isinstance(data, str):
                    await _ws_send_error(websocket, "`data` must be a string.")
                    continue
                await session.awrite(data.encode("utf-8", errors="ignore"))
                continue

            await _ws_send_error(websocket, "Unsupported message type.")
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        await _ws_send_error(websocket, str(exc))
    finally:
        _tty_active_sessions -= 1
        stop = True
        if output_task is not None:
            output_task.cancel()
            try:
                await output_task
            # We just cancelled it ourselves; anything else is a genuine failure pump_output
            # already reported via an "error" event before returning normally.
            except asyncio.CancelledError:
                pass
        if session is not None:
            await session.aclose()
        try:
            await websocket.send_text(json.dumps({"event": "closed"}))
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
