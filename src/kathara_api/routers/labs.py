"""Network scenario (lab) lifecycle endpoints."""

import posixpath
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, UploadFile, status
from fastapi.responses import StreamingResponse

from ..dependencies import get_service
from ..downloads import attachment_headers
from ..schemas.common import Message
from ..schemas.filesystem import (
    FsDeleteRequest,
    FsListResponse,
    FsMkdirRequest,
    FsMoveRequest,
    FsReadTextResponse,
    FsUploadResponse,
    FsWriteTextRequest,
)
from ..schemas.lab import (
    DeployOptions,
    LabConfUpdate,
    LabConfView,
    LabCreate,
    LabDetail,
    LabLayout,
    LabLocation,
    LabRename,
    LabSummary,
    UndeployOptions,
)
from ..schemas.lab_import import LabImportPreview, LabImportRequest, LabImportResult
from ..services import serializers
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs", tags=["labs"])


def _to_set(values):
    return set(values) if values else None


def _import_result(lab, warnings: list[str]) -> LabImportResult:
    """Build a LabImportResult (lab detail + non-fatal parse warnings) — shared by import + upload."""
    return LabImportResult(**serializers.lab_to_detail(lab).model_dump(), warnings=warnings)


@router.post("", response_model=LabDetail, status_code=status.HTTP_201_CREATED)
def create_lab(payload: LabCreate, service: KatharaService = Depends(get_service)) -> LabDetail:
    """Create a network scenario from a JSON description (not yet deployed)."""
    lab = service.create_lab(payload)
    return serializers.lab_to_detail(lab)


@router.post("/import/preview", response_model=LabImportPreview)
def preview_import(
    payload: LabImportRequest, service: KatharaService = Depends(get_service)
) -> LabImportPreview:
    """Dry-run parse of a standard Kathara lab directory, without creating anything."""
    return service.preview_import(payload.name, payload.files, payload.skipped_files)


@router.post("/import", response_model=LabImportResult, status_code=status.HTTP_201_CREATED)
def import_lab(payload: LabImportRequest, service: KatharaService = Depends(get_service)) -> LabImportResult:
    """Create (and optionally deploy) a lab from a lab.conf/.startup/folder directory.

    Every file/dir is written to disk verbatim server-side, so file/startup application on
    deploy is atomic regardless of client state.
    """
    lab, warnings = service.import_lab(payload.name, payload.files, payload.dirs, payload.skipped_files)
    if payload.deploy:
        # `lab.name`, not `payload.name`: import_lab stores/registers the lab under
        # `sanitize_lab_name(payload.name)`, which strips surrounding whitespace — deploying by the
        # raw submitted name would 404 on a lab that was just created successfully.
        lab = service.deploy_lab(lab.name)
    return _import_result(lab, warnings)


@router.post("/upload", response_model=LabImportResult, status_code=status.HTTP_201_CREATED)
def upload_lab(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    deploy: bool = Form(False),
    service: KatharaService = Depends(get_service),
) -> LabImportResult:
    """Create (and optionally deploy) a lab from an uploaded .zip archive of a lab directory.

    Binary-safe, unlike ``POST /import`` (JSON/text-only): the archive is extracted verbatim to
    disk, then parsed the same way as a JSON-described lab.conf/folder import.
    """
    lab_name = (name or "").strip() or Path(file.filename or "lab").stem
    lab, warnings = service.upload_lab(lab_name, file.file, deploy=deploy)
    return _import_result(lab, warnings)


@router.get("", response_model=list[LabSummary])
def list_labs(service: KatharaService = Depends(get_service)) -> list[LabSummary]:
    """List the network scenarios known to the API."""
    return [serializers.lab_to_summary(lab) for lab in service.list_labs()]


@router.get("/{lab_name}", response_model=LabDetail)
def get_lab(lab_name: str, service: KatharaService = Depends(get_service)) -> LabDetail:
    """Return details of a network scenario, merged with its running state."""
    lab = service.get_lab_or_reconstruct(lab_name)
    return serializers.lab_to_detail(lab)


@router.get("/{lab_name}/download")
def download_lab(lab_name: str, service: KatharaService = Depends(get_service)) -> StreamingResponse:
    """Download a lab as a .zip archive of its on-disk directory."""
    buf = service.export_lab_zip(lab_name)
    return StreamingResponse(
        buf, media_type="application/zip", headers=attachment_headers(f"{lab_name}.zip")
    )


@router.get("/{lab_name}/lab-conf", response_model=LabConfView)
def get_lab_conf(lab_name: str, service: KatharaService = Depends(get_service)) -> LabConfView:
    """Return the lab's on-disk ``lab.conf`` verbatim — comments, quoting and options this API
    doesn't interpret all intact.

    ``exists: false`` with empty ``content`` means the lab has no ``lab.conf`` on disk yet; ``PUT``
    on this path creates one.
    """
    return service.read_lab_conf(lab_name)


@router.put("/{lab_name}/lab-conf", response_model=LabDetail)
def update_lab_conf(
    lab_name: str, payload: LabConfUpdate, service: KatharaService = Depends(get_service)
) -> LabDetail:
    """Apply an edited ``lab.conf`` to a non-deployed lab (rebuilds its topology), storing the
    submitted text verbatim. 409 if deployed."""
    lab = service.update_lab_conf(lab_name, payload.content)
    return serializers.lab_to_detail(lab)


@router.get("/{lab_name}/location", response_model=LabLocation)
def get_lab_location(lab_name: str, service: KatharaService = Depends(get_service)) -> LabLocation:
    """Return the lab's directory on the host filesystem.

    For desktop integrations (services/desktop): revealing a lab in the OS file manager and
    launching a system terminal in it both need a real host path.
    """
    return LabLocation(path=str(service.lab_location(lab_name)))


@router.get("/{lab_name}/layout", response_model=LabLayout)
def get_lab_layout(lab_name: str, service: KatharaService = Depends(get_service)) -> LabLayout:
    """Return the lab's fixed topology layout (``lab.layout``).

    An empty ``nodes`` map means the lab has no fixed layout — the graph then falls back to its
    force-directed layout.
    """
    return service.get_lab_layout(lab_name)


@router.put("/{lab_name}/layout", response_model=LabLayout)
def save_lab_layout(
    lab_name: str, payload: LabLayout, service: KatharaService = Depends(get_service)
) -> LabLayout:
    """Fix the lab's topology layout by storing it as ``lab.layout`` in the lab directory.

    Presentation metadata only, so — unlike ``lab.conf`` — it stays editable while the lab is deployed.
    """
    return service.save_lab_layout(lab_name, payload)


@router.delete("/{lab_name}/layout", response_model=Message)
def clear_lab_layout(lab_name: str, service: KatharaService = Depends(get_service)) -> Message:
    """Remove the lab's fixed layout, restoring the automatic force-directed one."""
    existed = service.clear_lab_layout(lab_name)
    detail = "Fixed layout removed." if existed else f"Lab `{lab_name}` has no fixed layout."
    return Message(detail=detail)


@router.get("/{lab_name}/fs/list", response_model=FsListResponse)
def list_lab_directory(
    lab_name: str, path: str = "/", service: KatharaService = Depends(get_service)
) -> FsListResponse:
    """List a directory in the lab's own on-disk tree — ``lab.conf``, every device's folder (even
    one with nothing in it yet), and anything queued at the lab root."""
    entries = service.fs_list_offline(lab_name, path)
    return FsListResponse(path=service.normalize_guest_path(path), entries=entries)


@router.get("/{lab_name}/fs/text", response_model=FsReadTextResponse)
def read_lab_text_file(
    lab_name: str, path: str, service: KatharaService = Depends(get_service)
) -> FsReadTextResponse:
    """Read a UTF-8 text file from the lab's own on-disk tree."""
    normalized = service.normalize_guest_path(path)
    return FsReadTextResponse(path=normalized, content=service.fs_read_text_offline(lab_name, normalized))


@router.put("/{lab_name}/fs/text", response_model=Message)
def write_lab_text_file(
    lab_name: str, payload: FsWriteTextRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Write or overwrite a UTF-8 text file in the lab's own on-disk tree."""
    size = service.fs_write_text_offline(lab_name, payload.path, payload.content)
    return Message(detail=f"Wrote {size} byte(s) to `{payload.path}`.")


@router.post("/{lab_name}/fs/mkdir", response_model=Message)
def mkdir_lab_directory(
    lab_name: str, payload: FsMkdirRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Create a directory (and any missing parents) in the lab's own on-disk tree."""
    service.fs_mkdir_offline(lab_name, payload.path)
    return Message(detail=f"Directory `{payload.path}` created.")


@router.post("/{lab_name}/fs/move", response_model=Message)
def move_lab_path(
    lab_name: str, payload: FsMoveRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Rename or move a path in the lab's own on-disk tree — across devices too."""
    service.fs_move_offline(lab_name, payload.source_path, payload.destination_path)
    return Message(detail=f"Moved `{payload.source_path}` to `{payload.destination_path}`.")


@router.delete("/{lab_name}/fs", response_model=Message)
def delete_lab_path(
    lab_name: str,
    payload: FsDeleteRequest = Body(...),
    service: KatharaService = Depends(get_service),
) -> Message:
    """Delete a path from the lab's own on-disk tree."""
    service.fs_delete_offline(lab_name, payload.path, recursive=payload.recursive)
    return Message(detail=f"Deleted `{payload.path}`.")


@router.post("/{lab_name}/fs/upload", response_model=FsUploadResponse)
async def upload_lab_file(
    lab_name: str,
    path: str = Form(...),
    file: UploadFile = File(...),
    service: KatharaService = Depends(get_service),
) -> FsUploadResponse:
    """Upload a binary or text file to a path in the lab's own on-disk tree."""
    data = await file.read()
    size = service.fs_upload_bytes_offline(lab_name, path, data)
    return FsUploadResponse(path=service.normalize_guest_path(path), size=size)


@router.get("/{lab_name}/fs/download")
def download_lab_file(
    lab_name: str, path: str, service: KatharaService = Depends(get_service)
) -> StreamingResponse:
    """Download a file from the lab's own on-disk tree as octet-stream."""
    normalized = service.normalize_guest_path(path)
    data = service.fs_read_bytes_offline(lab_name, normalized)
    filename = posixpath.basename(normalized) or "download.bin"
    return StreamingResponse(
        iter([data]), media_type="application/octet-stream", headers=attachment_headers(filename)
    )


@router.get("/{lab_name}/fs/startups", response_model=dict[str, str])
def get_startup_scripts(lab_name: str, service: KatharaService = Depends(get_service)) -> dict[str, str]:
    """Each device's real ``<machine>.startup`` content (``""`` if it doesn't exist) — backs the
    topology node-info panel's boot-time IP preview."""
    return service.get_startup_scripts(lab_name)


@router.post("/{lab_name}/deploy", response_model=LabDetail)
def deploy_lab(
    lab_name: str,
    options: DeployOptions | None = None,
    service: KatharaService = Depends(get_service),
) -> LabDetail:
    """Deploy a network scenario (synchronous)."""
    resolved = options or DeployOptions()
    lab = service.deploy_lab(
        lab_name,
        selected_machines=_to_set(resolved.selected_machines),
        excluded_machines=_to_set(resolved.excluded_machines),
    )
    return serializers.lab_to_detail(lab)


@router.post("/{lab_name}/undeploy", response_model=Message)
def undeploy_lab(
    lab_name: str,
    options: UndeployOptions | None = None,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Undeploy a network scenario (or a subset of its devices/links)."""
    resolved = options or UndeployOptions()
    service.undeploy_lab(
        lab_name,
        selected_machines=_to_set(resolved.selected_machines),
        excluded_machines=_to_set(resolved.excluded_machines),
        selected_links=_to_set(resolved.selected_links),
    )
    return Message(detail=f"Lab `{lab_name}` undeployed.")


@router.post("/{lab_name}/rename", response_model=LabDetail)
def rename_lab(lab_name: str, payload: LabRename, service: KatharaService = Depends(get_service)) -> LabDetail:
    """Rename a non-deployed network scenario (409 while deployed, or if the name is taken)."""
    lab = service.rename_lab(lab_name, payload.name)
    return serializers.lab_to_detail(lab)


@router.delete("/{lab_name}", response_model=Message)
def delete_lab(lab_name: str, service: KatharaService = Depends(get_service)) -> Message:
    """Undeploy a network scenario and drop it from the registry."""
    service.delete_lab(lab_name)
    return Message(detail=f"Lab `{lab_name}` deleted.")
