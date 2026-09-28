"""Live device statistics endpoint (SSE stream)."""

import json
from typing import Callable, TypeVar

import anyio
from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from ..dependencies import get_service, require_auth_token_or_query
from ..services import serializers
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs/{lab_id}", tags=["stats"])

T = TypeVar("T")


async def _sse_stats_stream(request: Request, generator, serialize: Callable[[T], object]):
    """SSE loop: iterate `generator` off-thread, stop on client disconnect, serialize each
    snapshot, and always close the generator."""
    try:
        async for stats in iterate_in_threadpool(generator):
            if await request.is_disconnected():
                break
            payload = [serialize(s).model_dump() for s in stats if s is not None]
            yield {"event": "stats", "data": json.dumps(payload)}
    finally:
        # Shielded: on a client disconnect sse-starlette cancels the task this runs in, and an
        # unshielded await here would be cancelled before the close ever ran, leaving the Docker
        # stats streams the generator holds open (see KatharaService.machines_stats_stream).
        with anyio.CancelScope(shield=True):
            await run_in_threadpool(generator.close)


# `async def` because the response body *is* an async generator: `_sse_stats_stream` above has
# to stay on the event loop to poll `request.is_disconnected()` between snapshots, and it keeps
# the blocking Kathara generator off it with `iterate_in_threadpool`. Building the generator
# blocks too — it resolves the lab, which can mean asking Docker — so that runs off the loop as
# well; an unknown lab still raises here, before the 200 goes out.
#
# Reached via a browser's native EventSource (see statsStreamUrl in
# services/frontend/src/services/api.ts), which cannot set an Authorization header — hence
# `?token=` accepted alongside it; see require_auth_token_or_query.
@router.get("/stats/stream", dependencies=[Depends(require_auth_token_or_query)])
async def machines_stats_stream(
    lab_id: str, request: Request, service: KatharaService = Depends(get_service)
):
    """Stream live device statistics as Server-Sent Events."""
    generator = await run_in_threadpool(service.machines_stats_stream, lab_id)
    return EventSourceResponse(
        _sse_stats_stream(request, generator, serializers.machine_stats_to_schema)
    )
