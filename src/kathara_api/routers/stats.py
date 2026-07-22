"""Statistics endpoints (snapshot and live SSE streams)."""

import json
from typing import Callable, TypeVar

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from ..dependencies import get_service
from ..schemas.stats import LinkStats, MachineStats
from ..services import serializers
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs/{lab_name}", tags=["stats"])

T = TypeVar("T")


async def _sse_stats_stream(request: Request, generator, serialize: Callable[[T], object]):
    """Shared SSE loop: iterate `generator` off-thread, stop on client disconnect, serialize
    each snapshot, and always close the generator."""
    try:
        async for stats in iterate_in_threadpool(generator):
            if await request.is_disconnected():
                break
            payload = [serialize(s).model_dump() for s in stats if s is not None]
            yield {"event": "stats", "data": json.dumps(payload)}
    finally:
        await run_in_threadpool(generator.close)


@router.get("/stats", response_model=list[MachineStats])
def machines_stats(lab_name: str, service: KatharaService = Depends(get_service)) -> list[MachineStats]:
    """Return a one-shot snapshot of all device statistics."""
    stats = service.machines_stats_snapshot(lab_name)
    return [serializers.machine_stats_to_schema(s) for s in stats if s is not None]


@router.get("/machines/{machine_name}/stats", response_model=MachineStats)
def machine_stats(
    lab_name: str, machine_name: str, service: KatharaService = Depends(get_service)
) -> MachineStats:
    """Return a one-shot snapshot of a single device's statistics."""
    stats = service.machine_stats_snapshot(lab_name, machine_name)
    return serializers.machine_stats_to_schema(stats)


@router.get("/links/stats", response_model=list[LinkStats])
def links_stats(lab_name: str, service: KatharaService = Depends(get_service)) -> list[LinkStats]:
    """Return a one-shot snapshot of all collision-domain statistics."""
    stats = service.links_stats_snapshot(lab_name)
    return [serializers.link_stats_to_schema(s) for s in stats if s is not None]


@router.get("/stats/stream")
async def machines_stats_stream(
    lab_name: str, request: Request, service: KatharaService = Depends(get_service)
):
    """Stream live device statistics as Server-Sent Events."""
    generator = service.machines_stats_stream(lab_name)
    return EventSourceResponse(
        _sse_stats_stream(request, generator, serializers.machine_stats_to_schema)
    )


@router.get("/links/stats/stream")
async def links_stats_stream(
    lab_name: str, request: Request, service: KatharaService = Depends(get_service)
):
    """Stream live collision-domain statistics as Server-Sent Events."""
    generator = service.links_stats_stream(lab_name)
    return EventSourceResponse(
        _sse_stats_stream(request, generator, serializers.link_stats_to_schema)
    )
