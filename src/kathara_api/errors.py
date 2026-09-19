"""Exception handling: map Kathara (and API-local) exceptions to HTTP responses."""

import logging

import docker.errors
import fs.errors
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from Kathara.exceptions import (
    DockerDaemonConnectionError,
    DockerImageNotFoundError,
    DockerPluginError,
    EmptyLabError,
    HTTPConnectionError,
    InterfaceMacAddressError,
    InterfaceNotFoundError,
    InvalidImageArchitectureError,
    InvocationError,
    LabAlreadyExistsError,
    LabNotFoundError,
    LinkAlreadyExistsError,
    LinkNotFoundError,
    MachineAlreadyExistsError,
    MachineBinaryError,
    MachineCollisionDomainError,
    MachineDependencyError,
    MachineNotFoundError,
    MachineNotReadyError,
    MachineNotRunningError,
    MachineOptionError,
    NonSequentialMachineInterfaceError,
    NotSupportedError,
    PrivilegeError,
    SettingsError,
)
from starlette.exceptions import HTTPException as StarletteHTTPException

from .schemas.common import ErrorResponse

logger = logging.getLogger("kathara_api")


class ApiError(Exception):
    """Base class for API-local errors carrying an HTTP status code."""

    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class UnauthorizedError(ApiError):
    """Raised by require_auth_token (dependencies.py) when a pairing token is configured and the
    request's own token (Authorization header or query param) is missing or doesn't match."""

    status_code = status.HTTP_401_UNAUTHORIZED


class ForbiddenOriginError(ApiError):
    """Raised for a state-changing request whose ``Origin`` this backend doesn't serve or allow
    (dependencies.is_origin_allowed). Distinct from UnauthorizedError: the caller may well hold a
    valid token — the problem is that the request was initiated by a page on another origin."""

    status_code = status.HTTP_403_FORBIDDEN


class SettingsLockedError(ApiError):
    """Raised when settings are updated after the manager has been initialized."""

    status_code = status.HTTP_409_CONFLICT


class LabAlreadyRegisteredError(ApiError):
    """Raised when creating a lab whose name already exists in the registry."""

    status_code = status.HTTP_409_CONFLICT


class LabConfLockedError(ApiError):
    """Raised when editing a lab's lab.conf while the lab is deployed."""

    status_code = status.HTTP_409_CONFLICT


class LabRenameLockedError(ApiError):
    """Raised when renaming a lab while it is deployed.

    A lab's name is its directory name *and* the identity Kathara derives container/network names
    from, so renaming a running lab would orphan everything already deployed under the old name.
    """

    status_code = status.HTTP_409_CONFLICT


class LinkInUseError(ApiError):
    """Raised when removing a collision domain that still has a running machine attached.

    remove_link's own self._facade().undeploy_link(link) call would otherwise be a silent no-op
    for that domain (DockerLink.undeploy filters out any network that still has containers
    attached) — the Docker network and the container's live interface would survive even though
    the API answers 200 and the in-memory model says the link is gone. Fail fast instead of
    leaving that split-brain state; the caller must stop the machine (or the whole lab) first.
    """

    status_code = status.HTTP_409_CONFLICT


class LabTransitioningError(ApiError):
    """Raised when a lab.conf/offline-fs edit or a lab/device/link structural change is attempted
    while `deploy_lab`/`undeploy_lab` is actively running for that same lab.

    Distinct from `LabConfLockedError`/`LabRenameLockedError` (the *steady-state* "this lab is
    already deployed" checks): those already correctly serialize against a concurrent deploy via
    `_mutate_lock`, but with no fast-fail guard a request lands on that lock and just blocks —
    silently, for however long the deploy/undeploy takes — before finally succeeding or failing on
    whatever state exists by the time it wakes up. This is checked *before* touching the lock at
    all, so the caller gets an immediate, explicit "try again shortly" instead of an unexplained
    multi-second hang.
    """

    status_code = status.HTTP_409_CONFLICT


class ImagePullBusyError(ApiError):
    """Raised when an image download is requested while another one is already running.

    Only one download runs at a time — not because concurrent pulls would corrupt anything (the
    Docker daemon coalesces pulls of the same reference, and layer writes are content-addressed),
    but because a second one would compete for bandwidth while a synchronous handler already holds
    an anyio threadpool worker for the duration. Unlike LabTransitioningError's guard, this one
    has no race window: services/image_pull.track() checks and claims the slot inside the same
    critical section.
    """

    status_code = status.HTTP_409_CONFLICT


class ImagePullError(ApiError):
    """Raised when a Docker pull stream reports a failure mid-download.

    `client.api.pull(stream=True)` doesn't raise for an in-stream error — it yields a line with an
    `error` key and ends — so services/image_pull.pull_images has to detect that itself and turn
    it into something the frontend can show.
    """

    status_code = status.HTTP_502_BAD_GATEWAY


class PathNotFoundError(ApiError):
    """Raised when an offline lab filesystem path doesn't exist."""

    status_code = status.HTTP_404_NOT_FOUND


class BinaryFileError(ApiError):
    """Raised when a runtime filesystem path is read as text but isn't valid UTF-8.

    A distinct class (rather than a generic ApiError) so the frontend can detect this specific
    case by `error_type` and offer a binary-aware fallback (download/delete, no text preview)
    instead of just showing the error as a toast.
    """


class ExampleNotFoundError(ApiError):
    """Raised when a requested bundled example id doesn't exist in the examples catalog
    (services/examples.py) — a different thing from a *lab* not being found."""

    status_code = status.HTTP_404_NOT_FOUND


class GalleryLabNotFoundError(ApiError):
    """Raised when a requested gallery lab id isn't in the upstream catalog
    (services/lab_gallery.py) — the remote twin of ExampleNotFoundError.

    Distinct from GalleryUnavailableError: the catalog was fetched fine, the id just isn't in it
    (a stale frontend list, or a hand-written id).
    """

    status_code = status.HTTP_404_NOT_FOUND


class GalleryUnavailableError(ApiError):
    """Raised when the upstream lab gallery can't be reached or answered unusably.

    502 rather than the ApiError default of 400: nothing is wrong with the client's request — the
    failure is upstream (no network, GitHub down, a rate limit, a truncated tree), so the frontend
    shows it as a retryable "gallery unavailable" state instead of a validation error.
    """

    status_code = status.HTTP_502_BAD_GATEWAY


# Kathara exception -> HTTP status code.
KATHARA_STATUS_MAP: dict[type[Exception], int] = {
    # 404 Not Found
    LabNotFoundError: status.HTTP_404_NOT_FOUND,
    MachineNotFoundError: status.HTTP_404_NOT_FOUND,
    LinkNotFoundError: status.HTTP_404_NOT_FOUND,
    DockerImageNotFoundError: status.HTTP_404_NOT_FOUND,
    InterfaceNotFoundError: status.HTTP_404_NOT_FOUND,
    # 409 Conflict
    LabAlreadyExistsError: status.HTTP_409_CONFLICT,
    MachineAlreadyExistsError: status.HTTP_409_CONFLICT,
    LinkAlreadyExistsError: status.HTTP_409_CONFLICT,
    MachineNotRunningError: status.HTTP_409_CONFLICT,
    MachineNotReadyError: status.HTTP_409_CONFLICT,
    EmptyLabError: status.HTTP_409_CONFLICT,
    # 400 Bad Request
    InvocationError: status.HTTP_400_BAD_REQUEST,
    MachineOptionError: status.HTTP_400_BAD_REQUEST,
    MachineCollisionDomainError: status.HTTP_400_BAD_REQUEST,
    MachineDependencyError: status.HTTP_400_BAD_REQUEST,
    NonSequentialMachineInterfaceError: status.HTTP_400_BAD_REQUEST,
    InterfaceMacAddressError: status.HTTP_400_BAD_REQUEST,
    MachineBinaryError: status.HTTP_400_BAD_REQUEST,
    InvalidImageArchitectureError: status.HTTP_400_BAD_REQUEST,
    NotSupportedError: status.HTTP_400_BAD_REQUEST,
    SettingsError: status.HTTP_400_BAD_REQUEST,
    # Raised by pyfilesystem2 for an offline-lab-filesystem path that tries to climb above its own
    # root (e.g. `path=../../etc`, or one that normalizes to that) — a real but non-malicious input
    # error (see `errors.py`'s own catch-all below for why this needs a mapping at all: `OSFS`
    # already refuses to read/write outside its root regardless, so this is purely about giving the
    # caller a clean 400 instead of a 500 logged as an unhandled server bug).
    fs.errors.IllegalBackReference: status.HTTP_400_BAD_REQUEST,
    # pyfilesystem2 offline-fs errors reachable from fs_write_text_offline/_write_lab_root_files,
    # fs_mkdir_offline and fs_upload_bytes_offline: a write/mkdir whose target path collides with
    # something already on disk of the wrong kind, or that isn't there when a read expects it —
    # a real but non-malicious input error, not a server bug. Other FSError siblings not listed
    # here (PermissionDenied, OperationTimeout, ResourceLocked, ...) are left to the catch-all 500
    # on purpose: nothing today reaches them without a filesystem-level fault outside the caller's
    # control.
    fs.errors.ResourceNotFound: status.HTTP_404_NOT_FOUND,
    fs.errors.FileExpected: status.HTTP_400_BAD_REQUEST,
    fs.errors.DirectoryExpected: status.HTTP_400_BAD_REQUEST,
    fs.errors.DirectoryExists: status.HTTP_409_CONFLICT,
    fs.errors.FileExists: status.HTTP_409_CONFLICT,
    fs.errors.DestinationExists: status.HTTP_409_CONFLICT,
    fs.errors.DirectoryNotEmpty: status.HTTP_409_CONFLICT,
    # 403 Forbidden
    # Raised by Kathara itself (e.g. DockerMachine.create) when a privileged device is started
    # without the whole process's real UID being 0 — distinct error_type so the frontend can
    # offer to relaunch the backend elevated instead of just showing a generic error.
    PrivilegeError: status.HTTP_403_FORBIDDEN,
    # 502 / 503 infrastructure
    DockerDaemonConnectionError: status.HTTP_503_SERVICE_UNAVAILABLE,
    HTTPConnectionError: status.HTTP_502_BAD_GATEWAY,
    DockerPluginError: status.HTTP_502_BAD_GATEWAY,
    # Kathara's image check raises the builtin ConnectionError when a missing image can't be pulled
    # because the registry is unreachable (DockerImage.check_local_image) — treat it as infrastructure
    # unavailability, not a generic 500.
    ConnectionError: status.HTTP_503_SERVICE_UNAVAILABLE,
}


def _error_response(exc: Exception, code: int) -> JSONResponse:
    body = ErrorResponse(detail=str(exc) or exc.__class__.__name__, error_type=exc.__class__.__name__)
    return JSONResponse(status_code=code, content=body.model_dump())


def _validation_error_response(exc: RequestValidationError) -> JSONResponse:
    """Flatten FastAPI's default validation-error body (``{"detail": [{"loc", "msg", "type", ...},
    ...]}``) into this API's uniform ``ErrorResponse`` — every other handler here returns
    ``detail`` as a plain string, and a client that doesn't special-case this one shape would
    otherwise render the raw list (e.g. JS: ``String(anErrorList)`` -> ``"[object Object]"``).
    """
    messages = []
    for err in exc.errors():
        # `loc`'s first element is always where the value came from (``"body"``, ``"query"``,
        # ``"path"``, ...) - useful for a debugger, not for a user-facing message.
        field = ".".join(str(p) for p in err.get("loc", ())[1:])
        msg = err.get("msg") or "Invalid value."
        messages.append(f"{field}: {msg}" if field else msg)
    detail = "; ".join(messages) or "Invalid request."
    body = ErrorResponse(detail=detail, error_type="RequestValidationError")
    return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content=body.model_dump())


def register_exception_handlers(app: FastAPI) -> None:
    """Attach exception handlers mapping Kathara/API errors to HTTP responses.

    Handlers are registered per exception class so they are served by Starlette's
    ExceptionMiddleware (which returns the response) rather than the catch-all
    ServerErrorMiddleware (which re-raises after handling). Starlette resolves the
    handler by walking each exception's MRO, so subclasses are covered too.
    """

    def make_handler(code: int):
        async def handler(_: Request, exc: Exception) -> JSONResponse:
            return _error_response(exc, getattr(exc, "status_code", code))

        return handler

    # API-local errors carry their own status code (read off the instance above), so
    # subclasses of ApiError need no separate registration - the MRO walk covers them.
    app.add_exception_handler(ApiError, make_handler(status.HTTP_400_BAD_REQUEST))

    # Kathara raises SyntaxError for invalid device names / lab.conf values.
    app.add_exception_handler(SyntaxError, make_handler(status.HTTP_422_UNPROCESSABLE_CONTENT))

    # Pydantic request-body/query-param validation (e.g. a device name failing its `Field`
    # pattern) raises this before a route body ever runs. Without this handler it falls through
    # to FastAPI's own default, whose body shape (`detail` as a list of {loc, msg, type}) doesn't
    # match `ErrorResponse` — see `_validation_error_response`.
    async def _handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return _validation_error_response(exc)

    app.add_exception_handler(RequestValidationError, _handle_validation_error)

    async def _handle_docker_api_error(_: Request, exc: Exception) -> JSONResponse:
        # docker.errors.APIError.status_code is a *property* reading exc.response, returning None
        # when the exception was built by hand with no HTTP response attached (as Kathara's own
        # ImageNotFound(f"no such image: {name}") is). Reusing make_handler's
        # getattr(exc, "status_code", code) would find that property instead of falling back, get
        # None, and crash building JSONResponse(status_code=None, ...). Decide by type instead.
        code = (
            status.HTTP_404_NOT_FOUND
            if isinstance(exc, docker.errors.NotFound)
            else status.HTTP_502_BAD_GATEWAY
        )
        return _error_response(exc, code)

    app.add_exception_handler(docker.errors.APIError, _handle_docker_api_error)

    async def _handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # FastAPI's own default handler for this class returns {"detail": exc.detail} with no
        # error_type — inconsistent with every other handler here. The status code is already
        # correct via FastAPI's pre-registered default handler; this exists only to give the body
        # the same ErrorResponse shape, and to avoid logging an intentional 4xx (e.g. spa.py's 404
        # for an unmatched /api/... path) as an unexpected server error.
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        if exc.status_code >= 500:
            logger.error("HTTPException raised with a server-error status: %s", detail)
        body = ErrorResponse(detail=detail, error_type="HTTPException")
        return JSONResponse(status_code=exc.status_code, content=body.model_dump())

    app.add_exception_handler(StarletteHTTPException, _handle_http_exception)

    for exc_class, code in KATHARA_STATUS_MAP.items():
        app.add_exception_handler(exc_class, make_handler(code))

    @app.exception_handler(Exception)
    async def _handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        # The full exception (str(exc), potentially carrying absolute host paths or other
        # internals) goes to the log only. The client gets a generic message — every other
        # handler in this file returns a user-facing detail on purpose, this one is the
        # catch-all for bugs, not expected input errors.
        logger.exception("Unhandled error while processing request")
        body = ErrorResponse(detail="Internal server error.", error_type=exc.__class__.__name__)
        return JSONResponse(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, content=body.model_dump())
