"""Command execution endpoints (synchronous and streaming)."""

import asyncio
import base64
import hmac
import json

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


def _iter_exec_stream(stream):
    """Adapt an IExecStream (implements `__next__` but not `__iter__`) into a real iterator."""
    while True:
        try:
            yield next(stream)
        except StopIteration:
            return


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
        try:
            async for chunk in iterate_in_threadpool(_iter_exec_stream(stream)):
                if await request.is_disconnected():
                    break
                for stream_name, data in _output_parts(chunk):
                    yield {"event": "output", "data": _sse_json(stream_name, data)}
            yield {"event": "exit", "data": f'{{"exit_code": {stream.exit_code()}}}'}
        finally:
            close = getattr(stream, "close", None)
            if callable(close):
                close()

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

    session: DockerTtySession | None = None
    output_task: asyncio.Task | None = None
    stop = False

    try:
        # Docker API call (update_lab_from_api + a container lookup) — off the event loop like
        # every other backend call in this function (session.start/read/write/resize below all
        # already go through asyncio.to_thread; this was the one unwrapped exception).
        machine_obj = await asyncio.to_thread(service.get_machine_api_object, lab_name, machine_name)
        client = getattr(getattr(machine_obj, "client", None), "api", None)
        container_id = getattr(machine_obj, "id", None)
        if client is None or not container_id:
            raise RuntimeError("Live TTY requires a Docker-backed running machine.")

        session = DockerTtySession(client, container_id, shell)
        await asyncio.to_thread(session.start)

        async def pump_output():
            try:
                while not stop:
                    chunk = await asyncio.to_thread(session.read, 4096)
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
                cols = int(msg.get("cols", 120))
                rows = int(msg.get("rows", 35))
                await asyncio.to_thread(session.resize, cols, rows)
                continue

            if msg_type == "input":
                data = msg.get("data", "")
                if not isinstance(data, str):
                    await _ws_send_error(websocket, "`data` must be a string.")
                    continue
                await asyncio.to_thread(session.write, data.encode("utf-8", errors="ignore"))
                continue

            await _ws_send_error(websocket, "Unsupported message type.")
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        await _ws_send_error(websocket, str(exc))
    finally:
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
            session.close()
        try:
            await websocket.send_text(json.dumps({"event": "closed"}))
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
