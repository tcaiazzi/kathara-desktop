"""Interactive TTY endpoint for a running device (websocket)."""

import asyncio
import base64
import hmac
import json

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from ..config import get_settings
from ..dependencies import get_service, is_origin_allowed
from ..services.docker_tty import DockerTtySession
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs/{lab_name}/machines/{machine_name}", tags=["exec"])

# How many tty_live_ws sessions are open right now. Mutated only from coroutines on this single
# event loop (never from a thread), same as the `stop` flag inside tty_live_ws itself, so no lock
# is needed. Checked against settings.tty_max_sessions, which also sizes the dedicated TTY
# executor in services/docker_tty.py — a ThreadPoolExecutor queues work past max_workers instead
# of rejecting it, which would otherwise make session N+1 look like a hung terminal instead of a
# clean, immediate refusal.
_tty_active_sessions = 0


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


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
    # token (see dependencies.require_auth_token) travels as a query param instead — checked by
    # hand rather than via the same Depends(): FastAPI's dependency solver can't supply a
    # `Request`-typed dependency in a
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
        # since it is a one-shot lookup, not a persistent per-session thread — see
        # services/docker_tty.py for why the two must not share an executor).
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
