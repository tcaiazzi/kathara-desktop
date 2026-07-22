"""System, health, and settings endpoints."""

from fastapi import APIRouter, Depends

from ..dependencies import get_service
from ..schemas.common import Message
from ..schemas.settings import (
    ImageCheckRequest,
    SettingsUpdate,
    SettingsView,
    SystemInfo,
)
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


@router.post("/system/images/check", response_model=Message)
def check_image(
    payload: ImageCheckRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Validate that the specified image is available."""
    service.check_image(payload.image)
    return Message(detail=f"Image `{payload.image}` is available.")


@router.post("/system/wipe", response_model=Message)
def wipe(service: KatharaService = Depends(get_service)) -> Message:
    """Undeploy all of the current user's running network scenarios."""
    service.wipe()
    return Message(detail="All network scenarios wiped.")
