"""Network scenario (lab) lifecycle endpoints."""

import posixpath
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from ..dependencies import get_service, require_shell_token
from ..downloads import attachment_headers
from ..schemas.common import Message
from ..schemas.examples import ExampleCreate, ExampleSummary
from ..schemas.filesystem import (
    FsCopyRequest,
    FsDeleteRequest,
    FsListResponse,
    FsMkdirRequest,
    FsMoveRequest,
    FsReadTextResponse,
    FsSearchResponse,
    FsUploadResponse,
    FsWriteTextRequest,
)
from ..schemas.gallery import GalleryCatalog, GalleryInstall
from ..schemas.images import LabImagesStatus
from ..schemas.lab import (
    DeployOptions,
    LabConfUpdate,
    LabConfView,
    LabCreate,
    LabDetail,
    LabLayout,
    LabLocation,
    LabOpen,
    LabRename,
    LabSummary,
    UndeployOptions,
)
from ..schemas.lab_import import LabImportResult
from ..services import serializers
from ..services.kathara_service import KatharaService

router = APIRouter(prefix="/labs", tags=["labs"])


def _to_set(values):
    return set(values) if values else None


def _detail(lab, service: KatharaService) -> LabDetail:
    """The lab's detail, including where it lives — every route answering with a lab goes through here."""
    return serializers.lab_to_detail(lab, service.lab_place(lab))


def _import_result(lab, warnings: list[str], service: KatharaService) -> LabImportResult:
    """Build a LabImportResult (lab detail + non-fatal parse warnings) — shared by import + upload."""
    return LabImportResult(**_detail(lab, service).model_dump(), warnings=warnings)


@router.post("", response_model=LabDetail, status_code=status.HTTP_201_CREATED)
def create_lab(payload: LabCreate, service: KatharaService = Depends(get_service)) -> LabDetail:
    """Create a network scenario from a JSON description (not yet deployed)."""
    lab = service.create_lab(payload)
    return _detail(lab, service)


@router.post("/upload", response_model=LabImportResult, status_code=status.HTTP_201_CREATED)
def upload_lab(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    deploy: bool = Form(False),
    service: KatharaService = Depends(get_service),
) -> LabImportResult:
    """Create (and optionally deploy) a lab from an uploaded .zip archive of a lab directory.

    The archive is extracted verbatim to disk, then parsed into a registered lab.
    """
    lab_name = (name or "").strip() or Path(file.filename or "lab").stem
    lab, warnings = service.upload_lab(lab_name, file.file, deploy=deploy)
    return _import_result(lab, warnings, service)


@router.post(
    "/open",
    response_model=LabImportResult,
    dependencies=[Depends(require_shell_token)],
)
def open_lab(payload: LabOpen, service: KatharaService = Depends(get_service)) -> LabImportResult:
    """Open a host folder, wherever it is, as a lab — used in place, and remembered across restarts.

    Desktop shell only (the `X-Kathara-Shell-Token` header): the shell picks the folder in a native
    dialog, and nothing the renderer sends may choose a directory this API then reads and writes.
    Opening an already-open folder returns it. 422 `NotALabError` for a folder with no `lab.conf`
    and no device folders, unless `init` is set.
    """
    lab, warnings = service.open_lab(payload.path, init=payload.init)
    return _import_result(lab, warnings, service)


# Declared above the /{lab_id} routes below: FastAPI/Starlette resolves in registration
# order, so a route added after GET /{lab_id} would be swallowed as get_lab("examples").
@router.get("/examples", response_model=list[ExampleSummary])
def list_example_labs(service: KatharaService = Depends(get_service)) -> list[ExampleSummary]:
    """Bundled example network scenarios (see src/kathara_api/examples/)."""
    return service.list_example_labs()


@router.post("/examples", response_model=LabImportResult, status_code=status.HTTP_201_CREATED)
def create_example_lab(payload: ExampleCreate, service: KatharaService = Depends(get_service)) -> LabImportResult:
    """Create a lab from one of the bundled example network scenarios.

    A body rather than POST /examples/{id}: a path form would need care to not be shadowed by
    POST /{lab_id}/deploy for an id of "deploy", and the body gives a free slot for the
    optional target `name`.
    """
    lab, warnings = service.install_example(payload.id, payload.name)
    return _import_result(lab, warnings, service)


# Also declared above GET /{lab_id} for the same registration-order reason as /examples above.
# async for a reason upload_lab_file below does not share (that one awaits UploadFile.read()): a
# burst of concurrent requests must coordinate on the event loop (KatharaService.list_gallery_labs /
# lab_gallery.fetch_catalog_async), not by each parking a worker thread from the shared
# threadpool behind a lock held across a ~20s upstream fetch — see docs/DESIGN-NOTES.md.
@router.get("/gallery", response_model=GalleryCatalog)
async def list_gallery_labs(
    refresh: bool = False, service: KatharaService = Depends(get_service)
) -> GalleryCatalog:
    """The upstream Kathara-Labs catalog browsed by the frontend's "Browse Kathara Labs" modal.

    Cached server-side (see services/lab_gallery.py); ``refresh=true`` bypasses that cache, which
    is what the modal's Refresh button sends.
    """
    return await service.list_gallery_labs(refresh=refresh)


@router.post("/gallery", response_model=LabImportResult, status_code=status.HTTP_201_CREATED)
def create_gallery_lab(payload: GalleryInstall, service: KatharaService = Depends(get_service)) -> LabImportResult:
    """Create a lab from an entry in the upstream Kathara-Labs gallery.

    A body rather than POST /gallery/{id}: the id is a repo-relative path and contains slashes, so
    a path form isn't possible — same reasoning as POST /examples above.
    """
    lab, warnings = service.install_gallery_lab(payload.id, payload.name)
    return _import_result(lab, warnings, service)


@router.get("", response_model=list[LabSummary])
def list_labs(service: KatharaService = Depends(get_service)) -> list[LabSummary]:
    """List the network scenarios known to the API."""
    return [serializers.lab_to_summary(lab, service.lab_place(lab)) for lab in service.list_labs()]


@router.get("/{lab_id}", response_model=LabDetail)
def get_lab(lab_id: str, service: KatharaService = Depends(get_service)) -> LabDetail:
    """Return details of a network scenario, merged with its running state."""
    lab = service.get_lab_or_reconstruct(lab_id)
    return _detail(lab, service)


@router.get("/{lab_id}/download")
def download_lab(lab_id: str, service: KatharaService = Depends(get_service)) -> StreamingResponse:
    """Download a lab as a .zip archive of its on-disk directory."""
    name, buf = service.export_lab_zip(lab_id)
    return StreamingResponse(
        buf, media_type="application/zip", headers=attachment_headers(f"{name}.zip")
    )


@router.get("/{lab_id}/lab-conf", response_model=LabConfView)
def get_lab_conf(lab_id: str, service: KatharaService = Depends(get_service)) -> LabConfView:
    """Return the lab's on-disk ``lab.conf`` verbatim — comments, quoting and options this API
    doesn't interpret all intact.

    ``exists: false`` with empty ``content`` means the lab has no ``lab.conf`` on disk yet; ``PUT``
    on this path creates one.
    """
    return service.read_lab_conf(lab_id)


@router.put("/{lab_id}/lab-conf", response_model=LabDetail)
def update_lab_conf(
    lab_id: str, payload: LabConfUpdate, service: KatharaService = Depends(get_service)
) -> LabDetail:
    """Apply an edited ``lab.conf`` to a non-deployed lab (rebuilds its topology), storing the
    submitted text verbatim. 409 if deployed."""
    lab = service.update_lab_conf(lab_id, payload.content)
    return _detail(lab, service)


@router.get("/{lab_id}/location", response_model=LabLocation)
def get_lab_location(lab_id: str, service: KatharaService = Depends(get_service)) -> LabLocation:
    """Return the lab's directory on the host filesystem.

    For desktop integrations (services/desktop): revealing a lab in the OS file manager and
    launching a system terminal in it both need a real host path.
    """
    return LabLocation(path=str(service.lab_location(lab_id)))


@router.get("/{lab_id}/layout", response_model=LabLayout)
def get_lab_layout(lab_id: str, service: KatharaService = Depends(get_service)) -> LabLayout:
    """Return the lab's fixed topology layout (``lab.layout``).

    An empty ``nodes`` map means the lab has no fixed layout — the graph then falls back to its
    force-directed layout.
    """
    return service.get_lab_layout(lab_id)


@router.put("/{lab_id}/layout", response_model=LabLayout)
def save_lab_layout(
    lab_id: str, payload: LabLayout, service: KatharaService = Depends(get_service)
) -> LabLayout:
    """Fix the lab's topology layout by storing it as ``lab.layout`` in the lab directory.

    Presentation metadata only, so — unlike ``lab.conf`` — it stays editable while the lab is deployed.
    """
    return service.save_lab_layout(lab_id, payload)


@router.delete("/{lab_id}/layout", response_model=Message)
def clear_lab_layout(lab_id: str, service: KatharaService = Depends(get_service)) -> Message:
    """Remove the lab's fixed layout, restoring the automatic force-directed one."""
    existed = service.clear_lab_layout(lab_id)
    detail = "Fixed layout removed." if existed else "This lab has no fixed layout."
    return Message(detail=detail)


@router.get("/{lab_id}/fs/list", response_model=FsListResponse)
def list_lab_directory(
    lab_id: str, path: str = "/", service: KatharaService = Depends(get_service)
) -> FsListResponse:
    """List a directory in the lab's own on-disk tree — ``lab.conf``, every device's folder (even
    one with nothing in it yet), and anything queued at the lab root."""
    entries = service.fs_list_offline(lab_id, path)
    return FsListResponse(path=service.normalize_guest_path(path), entries=entries)


@router.get("/{lab_id}/fs/search", response_model=FsSearchResponse)
def search_lab_files(
    lab_id: str,
    path: str = "/",
    query: str = Query(..., min_length=2),
    case_sensitive: bool = False,
    service: KatharaService = Depends(get_service),
) -> FsSearchResponse:
    """Search file contents under a directory in the lab's own on-disk tree."""
    matches, truncated = service.fs_search_offline(lab_id, path, query, case_sensitive)
    return FsSearchResponse(query=query, matches=matches, truncated=truncated)


@router.get("/{lab_id}/fs/text", response_model=FsReadTextResponse)
def read_lab_text_file(
    lab_id: str, path: str, service: KatharaService = Depends(get_service)
) -> FsReadTextResponse:
    """Read a UTF-8 text file from the lab's own on-disk tree."""
    normalized = service.normalize_guest_path(path)
    return FsReadTextResponse(path=normalized, content=service.fs_read_text_offline(lab_id, normalized))


@router.put("/{lab_id}/fs/text", response_model=Message)
def write_lab_text_file(
    lab_id: str, payload: FsWriteTextRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Write or overwrite a UTF-8 text file in the lab's own on-disk tree."""
    size = service.fs_write_text_offline(lab_id, payload.path, payload.content)
    return Message(detail=f"Wrote {size} byte(s) to `{payload.path}`.")


@router.post("/{lab_id}/fs/mkdir", response_model=Message)
def mkdir_lab_directory(
    lab_id: str, payload: FsMkdirRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Create a directory (and any missing parents) in the lab's own on-disk tree."""
    service.fs_mkdir_offline(lab_id, payload.path)
    return Message(detail=f"Directory `{payload.path}` created.")


@router.post("/{lab_id}/fs/move", response_model=Message)
def move_lab_path(
    lab_id: str, payload: FsMoveRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Rename or move a path in the lab's own on-disk tree — across devices too."""
    service.fs_move_offline(lab_id, payload.source_path, payload.destination_path)
    return Message(detail=f"Moved `{payload.source_path}` to `{payload.destination_path}`.")


@router.post("/{lab_id}/fs/copy", response_model=Message)
def copy_lab_path(
    lab_id: str, payload: FsCopyRequest, service: KatharaService = Depends(get_service)
) -> Message:
    """Copy a path in the lab's own on-disk tree — across devices too."""
    service.fs_copy_offline(lab_id, payload.source_path, payload.destination_path)
    return Message(detail=f"Copied `{payload.source_path}` to `{payload.destination_path}`.")


@router.delete("/{lab_id}/fs", response_model=Message)
def delete_lab_path(
    lab_id: str,
    payload: FsDeleteRequest = Body(...),
    service: KatharaService = Depends(get_service),
) -> Message:
    """Delete a path from the lab's own on-disk tree."""
    service.fs_delete_offline(lab_id, payload.path, recursive=payload.recursive)
    return Message(detail=f"Deleted `{payload.path}`.")


@router.post("/{lab_id}/fs/upload", response_model=FsUploadResponse)
async def upload_lab_file(
    lab_id: str,
    path: str = Form(...),
    file: UploadFile = File(...),
    service: KatharaService = Depends(get_service),
) -> FsUploadResponse:
    """Upload a binary or text file to a path in the lab's own on-disk tree."""
    data = await file.read()
    # A blocking pyfilesystem write under `_mutate_lock`, off the event loop like every other
    # backend call in an `async def` handler (see exec.py's own use of this) — otherwise it stalls
    # every other request this single-worker server is handling for its duration.
    size = await run_in_threadpool(service.fs_upload_bytes_offline, lab_id, path, data)
    return FsUploadResponse(path=service.normalize_guest_path(path), size=size)


@router.get("/{lab_id}/fs/download")
def download_lab_file(
    lab_id: str, path: str, service: KatharaService = Depends(get_service)
) -> StreamingResponse:
    """Download a file from the lab's own on-disk tree as octet-stream."""
    normalized = service.normalize_guest_path(path)
    data = service.fs_read_bytes_offline(lab_id, normalized)
    filename = posixpath.basename(normalized) or "download.bin"
    return StreamingResponse(
        iter([data]), media_type="application/octet-stream", headers=attachment_headers(filename)
    )


@router.get("/{lab_id}/fs/startups", response_model=dict[str, str])
def get_startup_scripts(lab_id: str, service: KatharaService = Depends(get_service)) -> dict[str, str]:
    """Each device's real ``<machine>.startup`` content (``""`` if it doesn't exist) — backs the
    topology node-info panel's boot-time IP preview."""
    return service.get_startup_scripts(lab_id)


@router.get("/{lab_id}/images", response_model=LabImagesStatus)
def check_lab_images(lab_id: str, service: KatharaService = Depends(get_service)) -> LabImagesStatus:
    """Which of this lab's device images are missing locally, and which have a newer version.

    Meant to be called immediately before a deploy, so the app can offer the download as its own
    visible step instead of letting Kathara pull silently inside `POST .../deploy`. Callers must
    treat *any* failure here as "carry on and deploy anyway": this check exists to inform, and
    must never be able to block a deploy that would otherwise work.

    Costs one registry round-trip per locally-present image (bounded, in parallel) unless Kathara's
    `image_update_policy` is `Never`, in which case only the local presence check runs.
    """
    return service.check_lab_images(lab_id)


@router.post("/{lab_id}/deploy", response_model=LabDetail)
def deploy_lab(
    lab_id: str,
    options: DeployOptions | None = None,
    service: KatharaService = Depends(get_service),
) -> LabDetail:
    """Deploy a network scenario (synchronous)."""
    resolved = options or DeployOptions()
    lab = service.deploy_lab(
        lab_id,
        selected_machines=_to_set(resolved.selected_machines),
        excluded_machines=_to_set(resolved.excluded_machines),
    )
    return _detail(lab, service)


@router.post("/{lab_id}/undeploy", response_model=Message)
def undeploy_lab(
    lab_id: str,
    options: UndeployOptions | None = None,
    service: KatharaService = Depends(get_service),
) -> Message:
    """Undeploy a network scenario (or a subset of its devices/links)."""
    resolved = options or UndeployOptions()
    service.undeploy_lab(
        lab_id,
        selected_machines=_to_set(resolved.selected_machines),
        excluded_machines=_to_set(resolved.excluded_machines),
        selected_links=_to_set(resolved.selected_links),
    )
    return Message(detail="Lab undeployed.")


@router.post("/{lab_id}/rename", response_model=LabDetail)
def rename_lab(lab_id: str, payload: LabRename, service: KatharaService = Depends(get_service)) -> LabDetail:
    """Rename a non-deployed network scenario (409 while deployed, or if the name is taken)."""
    lab = service.rename_lab(lab_id, payload.name)
    return _detail(lab, service)


@router.post("/{lab_id}/close", response_model=Message)
def close_lab(lab_id: str, service: KatharaService = Depends(get_service)) -> Message:
    """Forget a lab opened from outside the labs folder (undeploying it first); its folder stays.
    409 for a lab in the labs folder, which is deleted instead."""
    service.close_lab(lab_id)
    return Message(detail="Lab closed.")


@router.delete("/{lab_id}", response_model=Message)
def delete_lab(lab_id: str, service: KatharaService = Depends(get_service)) -> Message:
    """Undeploy a network scenario and remove its directory. 409 for a folder opened from outside
    the labs folder, which is closed instead."""
    service.delete_lab(lab_id)
    return Message(detail="Lab deleted.")
