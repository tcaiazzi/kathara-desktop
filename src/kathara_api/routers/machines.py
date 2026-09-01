"""Device (machine) endpoints scoped to a network scenario."""

import posixpath

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile, status
from fastapi.responses import StreamingResponse

from ..dependencies import get_service
from ..downloads import attachment_headers
from ..schemas.common import Message
from ..schemas.exec import CopyFilesRequest
from ..schemas.filesystem import (
    FsDeleteRequest,
    FsListResponse,
    FsMkdirRequest,
    FsMoveRequest,
    FsReadTextResponse,
    FsUploadResponse,
    FsWriteTextRequest,
)
from ..schemas.machine import MachineCreate, MachineDetail, MachineUpdate, StartupStatus
from ..services import serializers
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs/{lab_name}/machines", tags=["machines"])


@router.get("", response_model=list[MachineDetail])
def list_machines(lab_name: str, service: KatharaService = Depends(get_service)) -> list[MachineDetail]:
    """List the devices of a network scenario."""
    lab = service.get_lab_or_reconstruct(lab_name)
    return [serializers.machine_to_detail(m) for m in lab.machines.values()]


@router.get("/{machine_name}", response_model=MachineDetail)
def get_machine(
    lab_name: str, machine_name: str, service: KatharaService = Depends(get_service)
) -> MachineDetail:
    """Return details of a single device."""
    machine = service.get_machine(lab_name, machine_name)
    return serializers.machine_to_detail(machine)


@router.get("/{machine_name}/shells", response_model=list[str])
def list_shells(
    lab_name: str, machine_name: str, service: KatharaService = Depends(get_service)
) -> list[str]:
    """List the shells available in a running device (populates the live-terminal picker)."""
    return service.available_shells(lab_name, machine_name)


@router.post("", response_model=MachineDetail, status_code=status.HTTP_201_CREATED)
def add_machine(
    lab_name: str, payload: MachineCreate, service: KatharaService = Depends(get_service)
) -> MachineDetail:
    """Add a device to a running network scenario and deploy it."""
    machine = service.add_machine(lab_name, payload)
    return serializers.machine_to_detail(machine)


@router.put("/{machine_name}", response_model=MachineDetail)
def update_machine(
    lab_name: str,
    machine_name: str,
    payload: MachineUpdate,
    service: KatharaService = Depends(get_service),
) -> MachineDetail:
    """Replace a stopped device's full option set (lab.conf metadata). Rejected with 409 while
    the lab is deployed — undeploy it first."""
    machine = service.update_machine(lab_name, machine_name, payload)
    return serializers.machine_to_detail(machine)


@router.delete("/{machine_name}", response_model=Message)
def remove_machine(
    lab_name: str,
    machine_name: str,
    keep_links: bool = False,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Undeploy a single device from a network scenario."""
    service.remove_machine(lab_name, machine_name, keep_links=keep_links)
    return Message(detail=f"Device `{machine_name}` removed from lab `{lab_name}`.")


@router.post("/{machine_name}/connect", response_model=MachineDetail)
def connect_machine(
    lab_name: str,
    machine_name: str,
    link: str,
    interface_number: int | None = None,
    mac_address: str | None = None,
    service: KatharaService = Depends(get_service),
) -> MachineDetail:
    """Attach a device to a collision domain on a running network scenario."""
    machine = service.connect_machine(
        lab_name,
        machine_name,
        link,
        interface_number=interface_number,
        mac_address=mac_address,
    )
    return serializers.machine_to_detail(machine)


@router.post("/{machine_name}/disconnect", response_model=Message)
def disconnect_machine(
    lab_name: str,
    machine_name: str,
    link: str,
    keep_link: bool = False,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Detach a device from a collision domain."""
    service.disconnect_machine(lab_name, machine_name, link, keep_link=keep_link)
    return Message(detail=f"Device `{machine_name}` disconnected from `{link}`.")


@router.post("/{machine_name}/files", response_model=Message)
def copy_files(
    lab_name: str,
    machine_name: str,
    payload: CopyFilesRequest,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Copy in-line file contents into a running device."""
    service.copy_files(lab_name, machine_name, payload.files)
    return Message(detail=f"Copied {len(payload.files)} file(s) into `{machine_name}`.")


@router.get("/{machine_name}/fs/list", response_model=FsListResponse)
def list_runtime_directory(
    lab_name: str,
    machine_name: str,
    path: str = "/",
    service: KatharaService = Depends(get_service),
) -> FsListResponse:
    """List the content of a runtime directory on a running device."""
    entries = service.fs_list_directory(lab_name, machine_name, path)
    return FsListResponse(path=service.normalize_guest_path(path), entries=entries)


@router.get("/{machine_name}/fs/text", response_model=FsReadTextResponse)
def read_runtime_text_file(
    lab_name: str,
    machine_name: str,
    path: str,
    service: KatharaService = Depends(get_service),
) -> FsReadTextResponse:
    """Read a UTF-8 text file from a running device."""
    normalized = service.normalize_guest_path(path)
    return FsReadTextResponse(path=normalized, content=service.fs_read_text(lab_name, machine_name, normalized))


@router.get("/{machine_name}/startup-status", response_model=StartupStatus)
def get_startup_status(
    lab_name: str,
    machine_name: str,
    service: KatharaService = Depends(get_service),
) -> StartupStatus:
    """Live startup-log tail and whether startup commands have finished, for a running device."""
    return StartupStatus(
        log=service.get_startup_log(lab_name, machine_name),
        finished=service.is_startup_finished(lab_name, machine_name),
    )


@router.put("/{machine_name}/fs/text", response_model=Message)
def write_runtime_text_file(
    lab_name: str,
    machine_name: str,
    payload: FsWriteTextRequest,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Write or overwrite a UTF-8 text file on a running device."""
    size = service.fs_write_text(lab_name, machine_name, payload.path, payload.content)
    return Message(detail=f"Wrote {size} byte(s) to `{payload.path}` on `{machine_name}`.")


@router.post("/{machine_name}/fs/mkdir", response_model=Message)
def mkdir_runtime_directory(
    lab_name: str,
    machine_name: str,
    payload: FsMkdirRequest,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Create a directory (and any missing parents) on a running device."""
    service.fs_mkdir(lab_name, machine_name, payload.path)
    return Message(detail=f"Directory `{payload.path}` created on `{machine_name}`.")


@router.post("/{machine_name}/fs/move", response_model=Message)
def move_runtime_path(
    lab_name: str,
    machine_name: str,
    payload: FsMoveRequest,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Rename or move a path on a running device."""
    service.fs_move(lab_name, machine_name, payload.source_path, payload.destination_path)
    return Message(
        detail=(
            f"Moved `{payload.source_path}` to `{payload.destination_path}` "
            f"on `{machine_name}`."
        )
    )


@router.delete("/{machine_name}/fs", response_model=Message)
def delete_runtime_path(
    lab_name: str,
    machine_name: str,
    payload: FsDeleteRequest = Body(...),
    service: KatharaService = Depends(get_service),
) -> Message:
    """Delete a path from a running device."""
    service.fs_delete(lab_name, machine_name, payload.path, recursive=payload.recursive)
    return Message(detail=f"Deleted `{payload.path}` on `{machine_name}`.")


@router.post("/{machine_name}/fs/upload", response_model=FsUploadResponse)
async def upload_runtime_file(
    lab_name: str,
    machine_name: str,
    path: str = Form(...),
    file: UploadFile = File(...),
    service: KatharaService = Depends(get_service),
) -> FsUploadResponse:
    """Upload a binary or text file to a path on a running device."""
    data = await file.read()
    size = service.fs_upload_bytes(lab_name, machine_name, path, data)
    return FsUploadResponse(path=service.normalize_guest_path(path), size=size)


@router.get("/{machine_name}/fs/download")
def download_runtime_file(
    lab_name: str,
    machine_name: str,
    path: str,
    service: KatharaService = Depends(get_service),
) -> StreamingResponse:
    """Download a file from a running device as octet-stream."""
    normalized = service.normalize_guest_path(path)
    data = service.fs_read_bytes(lab_name, machine_name, normalized)
    filename = posixpath.basename(normalized) or "download.bin"
    return StreamingResponse(
        iter([data]), media_type="application/octet-stream", headers=attachment_headers(filename)
    )
