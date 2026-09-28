"""Exception handling: map Kathara (and API-local) exceptions to HTTP responses."""

import logging
from collections.abc import Mapping, Sequence
from typing import Any, Optional

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
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .lab_conf_options import COLLISION_DOMAIN_PATTERN, DEVICE_NAME_PATTERN, MAC_ADDRESS_PATTERN, MEM_PATTERN
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


class FileTooLargeError(ApiError):
    """Raised when a file is larger than this API will hold in memory to return it (see
    ``KatharaService.fs_read_bytes``)."""

    status_code = status.HTTP_413_CONTENT_TOO_LARGE


class ForbiddenHostError(ApiError):
    """Raised for a request addressed to a Host this backend doesn't answer to
    (dependencies.is_host_allowed) — the signature of a DNS-rebinding page. A 400 rather than a
    403, as for any request naming a server that isn't this one."""

    status_code = status.HTTP_400_BAD_REQUEST


class SettingsLockedError(ApiError):
    """Raised when settings are updated after the manager has been initialized."""

    status_code = status.HTTP_409_CONFLICT


class InvalidSettingsError(ApiError):
    """Raised by a Settings save carrying a value Kathara would refuse (see
    services/settings_store.invalid_settings). Distinct from Kathara's own SettingsError, whose
    message is about the settings file and tells the user to fix it before launching."""


class SettingsFileInvalidError(ApiError):
    """Raised when kathara.conf exists but is not a JSON object: logged and reported on the
    Settings page at startup, and returned by a Settings save.

    Refused rather than overwritten: the file is the Kathara CLI's too, and whatever the user was
    in the middle of writing there would be lost. Nothing is applied either, so the page never
    shows a value the next start would not have.
    """

    status_code = status.HTTP_409_CONFLICT


class SettingsPersistError(ApiError):
    """Raised by a Settings save when kathara.conf cannot be written (permissions, full disk, ...).
    Nothing is applied, for the same reason as SettingsFileInvalidError."""

    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR


class LabAlreadyRegisteredError(ApiError):
    """Raised when a lab's directory is already taken — by a registered lab, or merely by a folder
    on disk — whether by a create, an install or a rename's target."""

    status_code = status.HTTP_409_CONFLICT


class LabConfLockedError(ApiError):
    """Raised when editing a lab's lab.conf while the lab is deployed."""

    status_code = status.HTTP_409_CONFLICT


class LabRenameLockedError(ApiError):
    """Raised when renaming a lab while it is deployed.

    A rename moves the lab's directory, and the lab's id — the hash Kathara names its containers
    and networks after — is derived from that directory's path, so renaming a running lab would
    orphan everything already deployed under the old id.
    """

    status_code = status.HTTP_409_CONFLICT


class ShellOnlyError(ApiError):
    """Raised by require_shell_token (dependencies.py): the route opens a caller-chosen host
    directory as a lab, and only the desktop shell's main process — which holds the shell token
    and picked the folder in a native dialog — may ask for that."""

    status_code = status.HTTP_403_FORBIDDEN


class LabFilePermissionError(ApiError):
    """Raised when the backend can't change or remove a file in a lab folder because another
    account owns it. In practice that account is root: running devices write into the lab's
    `shared/` folder, which Kathara bind-mounts at `/shared`, as root. A distinct class so the
    frontend can offer to reclaim the files for the user (hooks/useReportError.ts, which opens the
    modal in ReclaimLabsDirContext.tsx)."""

    status_code = status.HTTP_403_FORBIDDEN


class NotALabError(ApiError):
    """Raised when opening a directory that holds neither a ``lab.conf`` nor any device folder.

    Distinct from a plain 400 so the frontend can offer to make it one (``POST /labs/open`` with
    ``init: true``) instead of just reporting a failure.
    """

    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT


class InvalidArchiveError(ApiError):
    """Raised when an uploaded lab archive is not a readable .zip: not a zip at all, or one whose
    members fail their CRC check. Either is the uploader's file, not a server fault."""


class LabCloseRefusedError(ApiError):
    """Raised when closing a lab that lives under the labs root.

    Every directory there is a lab by construction, so closing one could not stick: it would be
    listed again on the next restart. Deleting it is what removes it.
    """

    status_code = status.HTTP_409_CONFLICT


class LabDeleteRefusedError(ApiError):
    """Raised when deleting a lab whose directory is outside the labs root.

    That directory is the user's own folder, opened from wherever it is — this app did not create
    it and must not ``rmtree`` it. Closing the lab forgets it; removing the folder is left to the
    user's own file manager.
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


class ImageNotAvailableError(ApiError):
    """Raised when the registry says an image to download does not exist or cannot be read
    without a login — services/image_pull.registry_says_not_found decides which answers mean that.

    Docker Hub answers a missing tag with a 404 and a missing or private repository with a 403
    (401 on some registries); all three leave the user with the same fix, the image name.
    """

    status_code = status.HTTP_404_NOT_FOUND


class ImagePullError(ApiError):
    """Raised when a Docker pull stream reports a failure mid-download.

    `client.api.pull(stream=True)` doesn't raise for an in-stream error — it yields a line with an
    `error` key and ends — so services/image_pull.pull_images has to detect that itself and turn
    it into something the frontend can show.
    """

    status_code = status.HTTP_502_BAD_GATEWAY


class UnsupportedOperationError(ApiError):
    """Raised when a request is valid but the device's current state or the Kathara manager can't
    carry it out. Kathara's own ``NotSupportedError`` prefixes its message with "Not Supported:",
    which reads twice over a sentence that already says what isn't supported."""


class PathNotFoundError(ApiError):
    """Raised when an offline lab filesystem path doesn't exist, or when the path given to open
    as a lab is not a folder (``KatharaService.open_lab``)."""

    status_code = status.HTTP_404_NOT_FOUND


class BinaryFileError(ApiError):
    """Raised when a file — in a lab's own folder or on a running device — is read as text but
    isn't valid UTF-8.

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
    # error. Being raised at all is the protection against `..`; this mapping only gives the caller
    # a clean 400 instead of a 500 logged as an unhandled server bug (see the catch-all below). A
    # symbolic link out of the lab is a separate way out, which `OSFS` follows —
    # `KatharaService._confine` refuses that one.
    fs.errors.IllegalBackReference: status.HTTP_400_BAD_REQUEST,
    # pyfilesystem2 offline-fs errors reachable from fs_write_text_offline/_write_lab_root_files,
    # fs_mkdir_offline and fs_upload_bytes_offline: a write/mkdir whose target path collides with
    # something already on disk of the wrong kind, or that isn't there when a read expects it —
    # a real but non-malicious input error, not a server bug. PermissionDenied is not listed:
    # the offline fs operations turn it into LabFilePermissionError, which names the file (its
    # own message is only "permission denied"). Other FSError siblings (OperationTimeout,
    # ResourceLocked, ...) are left to the catch-all 500 on purpose: nothing reaches them without
    # a filesystem-level fault outside the caller's control.
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


def known_error_detail(exc: Exception) -> Optional[str]:
    """The ``detail`` a request failing with ``exc`` answers with, for an error this module maps to
    a message written for the user — or None for one that reaches the catch-all, whose text may
    carry host paths or other internals and so only goes to the log. For code that keeps an error
    to show later, outside the request that raised it (``KatharaService.deploy_lab``)."""
    if isinstance(exc, (ApiError, docker.errors.APIError, SyntaxError, *KATHARA_STATUS_MAP)):
        return str(exc) or exc.__class__.__name__
    return None


def error_response(status_code: int, detail: str, error_type: str) -> JSONResponse:
    """A response carrying this API's uniform ``ErrorResponse`` body. Every error answer goes
    through here, including the ones ``main.py``'s middlewares build before any handler runs."""
    return JSONResponse(
        status_code=status_code, content=ErrorResponse(detail=detail, error_type=error_type).model_dump()
    )


def _error_response(exc: Exception, code: int) -> JSONResponse:
    return error_response(code, str(exc) or exc.__class__.__name__, exc.__class__.__name__)


# What a value failing one of the schemas' `pattern=` constraints must look like, keyed by that
# pattern. The pattern itself never reaches the message: a regex answers "what did the parser
# expect", not "what should I type".
PATTERN_MESSAGES: dict[str, str] = {
    DEVICE_NAME_PATTERN: "must use only lowercase letters, digits and underscores (at most 30 characters)",
    COLLISION_DOMAIN_PATTERN: "must use only letters, digits and underscores",
    MEM_PATTERN: "must be a whole number with an optional b, k, m or g unit, like 256m",
    MAC_ADDRESS_PATTERN: "must be six pairs of hex digits separated by colons, like 02:00:00:00:00:01",
}

# Words for the field names a user meets in a form. Any other field is shown as its own name, with
# underscores as spaces.
FIELD_LABELS: dict[str, str] = {
    "link": "collision domain",
    "links": "collision domain",
    "interfaces": "interface",
    "machines": "device",
    "mac_address": "MAC address",
    "cpus": "CPUs",
    "mem": "memory",
}


def _field_label(loc: Sequence[Any]) -> str:
    """``("interfaces", 0, "link")`` -> ``"Interface 1 collision domain"``: list indices count from
    one, the way a user numbers the rows of a form."""
    words = [str(p + 1) if isinstance(p, int) else FIELD_LABELS.get(str(p), str(p).replace("_", " ")) for p in loc]
    label = " ".join(words)
    return label[:1].upper() + label[1:]


def _validation_message(err: Mapping[str, Any], loc: Sequence[Any]) -> str:
    label = _field_label(loc)
    ctx = err.get("ctx") or {}
    if err.get("type") == "string_pattern_mismatch":
        rule = PATTERN_MESSAGES.get(str(ctx.get("pattern")), "has an invalid format")
        return f"{label} {rule}" if label else f"The value {rule}"
    if err.get("type") == "value_error" and ctx.get("error") is not None:
        # A schema's own `field_validator`: pydantic prepends "Value error, " to its message.
        msg = str(ctx["error"])
    else:
        msg = err.get("msg") or "Invalid value"
    return f"{label}: {msg}" if label else msg


def _flatten_validation_detail(errors: Sequence[Mapping[str, Any]], drop_source: bool) -> str:
    """Join a pydantic error list into one user-facing sentence, one clause per error.

    ``drop_source`` skips ``loc``'s first element, which for a request-validation error names where
    the value came from (``"body"``, ``"query"``, ``"path"``, ...) — useful to a debugger, not in a
    user-facing message. A model validated directly has no such prefix, and dropping it there
    would throw away the field name instead.
    """
    messages = []
    for err in errors:
        loc = err.get("loc", ())
        messages.append(_validation_message(err, loc[1:] if drop_source else loc).rstrip("."))
    return f"{'; '.join(messages)}." if messages else "Invalid request."


def _validation_error_response(exc: RequestValidationError) -> JSONResponse:
    """Flatten FastAPI's default validation-error body (``{"detail": [{"loc", "msg", "type", ...},
    ...]}``) into this API's uniform ``ErrorResponse`` — every other handler here returns
    ``detail`` as a plain string, and a client that doesn't special-case this one shape would
    otherwise render the raw list (e.g. JS: ``String(anErrorList)`` -> ``"[object Object]"``).
    """
    return error_response(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        _flatten_validation_detail(exc.errors(), drop_source=True),
        "RequestValidationError",
    )


def _model_validation_error_response(exc: ValidationError) -> JSONResponse:
    """Same uniform body for a model validated inside a service, not by the request layer.

    The schemas are the validation rules for lab content as much as for request bodies, so a
    ``lab.conf`` or a lab directory that violates one is bad input and reads as a 4xx. Letting it
    reach the catch-all instead would report a bug the operator cannot act on, and replace the
    message naming the offending field with a generic one.

    ``str(exc)`` is not used: pydantic renders it over several lines and ends it with a link to its
    own documentation, which is not an answer to "what is wrong with my lab".
    """
    return error_response(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        _flatten_validation_detail(exc.errors(), drop_source=False),
        exc.__class__.__name__,
    )


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

    # A schema validated by service code rather than by the request layer — parsing a lab.conf or
    # deriving devices from a lab directory both build `MachineCreate` from file content. The two
    # classes do not overlap: `RequestValidationError` does not inherit from pydantic's
    # `ValidationError`, so each keeps its own handler. Starlette picks by walking the raised
    # exception's MRO, which puts this ahead of the `Exception` catch-all.
    async def _handle_model_validation_error(_: Request, exc: ValidationError) -> JSONResponse:
        return _model_validation_error_response(exc)

    app.add_exception_handler(ValidationError, _handle_model_validation_error)

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
        return error_response(exc.status_code, detail, "HTTPException")

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
        return error_response(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "Internal server error.", exc.__class__.__name__
        )
