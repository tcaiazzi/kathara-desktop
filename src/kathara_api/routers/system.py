"""System, health, and settings endpoints."""

import os
import signal

from fastapi import APIRouter, Depends

from ..dependencies import get_service
from ..schemas.common import Message
from ..schemas.images import ImagePullProgress, ImagePullRequest, ImagePullResult
from ..schemas.settings import SettingsUpdate, SettingsView, SystemInfo
from ..services import image_pull
from ..services.kathara_service import KatharaService

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict:
    """Liveness check. Does not touch the Kathara backend."""
    return {"status": "ok"}


@router.get("/system", response_model=SystemInfo)
def system_info(service: KatharaService = Depends(get_service)) -> SystemInfo:
    """Return the active manager, release version, and available managers."""
    return SystemInfo.model_validate(service.system_info())


@router.post("/system/shutdown", response_model=Message)
def shutdown() -> Message:
    """Gracefully stop this process (SIGTERM, same as an interactive Ctrl-C).

    The desktop shell's only way to stop a `sudo`-elevated backend: once this process is running
    as root, the shell (running unprivileged) can no longer deliver it a process signal directly
    (`kill()` across that privilege boundary fails with EPERM) — but it can still reach this
    still-listening localhost port over plain HTTP regardless of this process's UID.
    """
    os.kill(os.getpid(), signal.SIGTERM)
    return Message(detail="Shutting down.")


@router.get("/settings", response_model=SettingsView)
def get_settings(service: KatharaService = Depends(get_service)) -> SettingsView:
    """Return the current Kathara settings."""
    return SettingsView.model_validate(service.get_settings_view())


@router.put("/settings", response_model=SettingsView)
def update_settings(
    payload: SettingsUpdate, service: KatharaService = Depends(get_service)
) -> SettingsView:
    """Override Kathara settings. ``manager_type`` can only be changed before the backend is first
    used (else 409); every other setting is updatable at runtime."""
    service.update_settings(payload.model_dump(exclude_none=True))
    return SettingsView.model_validate(service.get_settings_view())


@router.post("/system/wipe", response_model=Message)
def wipe(service: KatharaService = Depends(get_service)) -> Message:
    """Undeploy every lab kathara-desktop has deployed (scenarios started by other tools are left alone)."""
    service.wipe()
    return Message(detail="All network scenarios wiped.")


@router.get("/system/sysctls", response_model=list[str])
def list_net_sysctls(service: KatharaService = Depends(get_service)) -> list[str]:
    """Every `net.*` sysctl key available on this host's kernel — the only namespace Kathara's
    own sysctl validation accepts."""
    return service.list_net_sysctls()


@router.get("/system/images", response_model=list[str])
def list_available_images(service: KatharaService = Depends(get_service)) -> list[str]:
    """Official Kathara device images published on Docker Hub — suggestions for an "image" field,
    not a restriction (any valid Docker image is still accepted). 502s if Docker Hub is
    unreachable; callers should treat that as non-fatal and fall back to plain manual entry."""
    return service.list_available_images()


# Images are a host-wide resource, not a lab's, so these two are global rather than nested under
# /labs/{name} — the caller already knows which images it asked about (GET /labs/{name}/images).


@router.post("/images/pull", response_model=ImagePullResult)
def pull_images(
    payload: ImagePullRequest, service: KatharaService = Depends(get_service)
) -> ImagePullResult:
    """Download the given Docker images, then return. 409 if a download is already running.

    Synchronous on purpose: the frontend fires this *without awaiting it* and polls
    `/images/pull/progress` for the bar (the same fire-and-poll shape the desktop shell's setup
    page uses), then uses this request's own completion as the authoritative "done". A background
    thread would buy nothing here — a sync handler occupies one anyio threadpool worker for the
    duration, exactly as a deploy already does — and this module would be the only place in the
    backend spawning threads.
    """
    return ImagePullResult(pulled=service.pull_images(payload.images))


@router.get("/images/pull/progress", response_model=ImagePullProgress)
def image_pull_progress() -> ImagePullProgress:
    """Snapshot of the in-flight image download, or an idle one (`active` false).

    Takes no `KatharaService` dependency at all, so this handler is *incapable* of touching
    `_mutate_lock` and can always answer while a download (or a deploy) is running. Never 404s:
    with nothing in flight it returns an idle snapshot, so the poller needs no error branch and
    can't turn a transient miss into a toast.
    """
    return ImagePullProgress.model_validate(image_pull.snapshot())
