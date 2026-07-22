"""Exception handling: map Kathara (and API-local) exceptions to HTTP responses."""

import logging

from fastapi import FastAPI, Request, status
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
    SettingsError,
)

from .schemas.common import ErrorResponse

logger = logging.getLogger("kathara_api")


class ApiError(Exception):
    """Base class for API-local errors carrying an HTTP status code."""

    status_code = status.HTTP_400_BAD_REQUEST

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class SettingsLockedError(ApiError):
    """Raised when settings are updated after the manager has been initialized."""

    status_code = status.HTTP_409_CONFLICT


class LabAlreadyRegisteredError(ApiError):
    """Raised when creating a lab whose name already exists in the registry."""

    status_code = status.HTTP_409_CONFLICT


class LabConfLockedError(ApiError):
    """Raised when editing a lab's lab.conf while the lab is deployed."""

    status_code = status.HTTP_409_CONFLICT


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

    for exc_class, code in KATHARA_STATUS_MAP.items():
        app.add_exception_handler(exc_class, make_handler(code))

    @app.exception_handler(Exception)
    async def _handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error while processing request")
        return _error_response(exc, status.HTTP_500_INTERNAL_SERVER_ERROR)
