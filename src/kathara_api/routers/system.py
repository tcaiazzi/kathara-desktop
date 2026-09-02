"""System, health, and settings endpoints."""

import os
import signal

from fastapi import APIRouter, Depends

from ..dependencies import get_service
from ..schemas.common import Message
from ..schemas.filesystem import FsListResponse
from ..schemas.settings import SettingsUpdate, SettingsView, SystemInfo
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
    """Undeploy every lab kathara-ide has deployed (scenarios started by other tools are left alone)."""
    service.wipe()
    return Message(detail="All network scenarios wiped.")


@router.get("/system/browse", response_model=FsListResponse)
def browse_host(path: str = "/", service: KatharaService = Depends(get_service)) -> FsListResponse:
    """List a directory on the host machine's own filesystem (not a lab's or a device's) — used
    to pick a real host path for a device's volume mount instead of typing one blind."""
    entries = service.browse_host_directory(path)
    return FsListResponse(path=service.normalize_guest_path(path), entries=entries)


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
