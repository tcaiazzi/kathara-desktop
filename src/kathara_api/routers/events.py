"""Lab events: changes to labs made outside this app, as Server-Sent Events."""

import asyncio
import json

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from ..dependencies import get_service, require_auth_token_or_query
from ..services.kathara_service import KatharaService

router = APIRouter(tags=["events"])

# How often a quiet stream checks whether its client is still there.
_DISCONNECT_POLL_S = 1.0


# `async def`, and not in the labs router: the stream lives on the event loop (see
# services/lab_events.py), and `/labs/events` would be taken for `GET /labs/{lab_id}`.
#
# Reached via a browser's native EventSource (see labEventsUrl in services/frontend/src/services/
# api.ts), which cannot set an Authorization header — hence `?token=` accepted alongside it, as
# for the stats stream; see require_auth_token_or_query.
@router.get("/events", dependencies=[Depends(require_auth_token_or_query)])
async def lab_events(request: Request, service: KatharaService = Depends(get_service)):
    """Stream lab events as `lab` Server-Sent Events, each a JSON object
    `{lab_id, kind, files, detail}` — see KatharaService.handle_disk_change for the kinds."""
    queue = service.events.subscribe(asyncio.get_running_loop())

    async def stream():
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=_DISCONNECT_POLL_S)
                except asyncio.TimeoutError:
                    if await request.is_disconnected():
                        break
                    continue
                yield {"event": "lab", "data": json.dumps(event)}
        finally:
            service.events.unsubscribe(queue)

    return EventSourceResponse(stream())
