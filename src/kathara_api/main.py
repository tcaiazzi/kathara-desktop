"""FastAPI application factory and entry point."""

import logging

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import get_settings
from .dependencies import get_service, is_origin_allowed, require_auth_token
from .errors import ForbiddenOriginError, register_exception_handlers
from .routers import exec as exec_router
from .routers import labs, links, machines, stats, system
from .schemas.common import ErrorResponse
from .spa import mount_spa

logging.basicConfig(level=logging.INFO)

# All API routes live under this prefix so the separately-deployed React frontend
# (services/frontend) has a stable, unambiguous contract to call.
API_PREFIX = "/api"


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    app = FastAPI(
        title="Kathara REST API",
        version=__version__,
        description="REST API for the Kathara network emulation framework.",
    )

    # Apply Kathara setting overrides before the backend is first used.
    settings = get_settings()
    overrides = settings.kathara_overrides()
    if overrides:
        get_service().apply_startup_settings(overrides)

    # Empty allow_origins by default: no cross-origin access until a separately deployed
    # frontend origin is configured via KATHARA_API_CORS_ORIGINS (same-origin setups, e.g. the
    # desktop app, or Vite's own /api proxy in dev, need none).
    origins = settings.cors_origins_list()
    # A wildcard and credentials can't be combined: the CORS spec forbids returning
    # `Access-Control-Allow-Origin: *` alongside `Access-Control-Allow-Credentials: true`, so
    # Starlette silently falls back to echoing *the caller's own* Origin — turning "*" into
    # "every website on the internet may make credentialed calls to this API", against a backend
    # that holds the Docker socket. Callers here authenticate with an `Authorization: Bearer`
    # header, not cookies, and a header is unaffected by credentials mode, so the wildcard keeps
    # working with credentials off.
    allow_credentials = "*" not in origins
    if not allow_credentials:
        logging.warning(
            "KATHARA_API_CORS_ORIGINS is '*': allowing any origin, with credentials disabled. "
            "List the frontend's exact origin instead if you need credentialed requests."
        )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # CORS can't cover the state-changing endpoints that qualify as "simple requests" and so are
    # sent with no preflight for the browser to block: POST /system/wipe and /system/shutdown (no
    # body), POST /labs/{n}/deploy and /undeploy (optional body), POST /labs/upload (multipart).
    # A page on another origin can't read the response, but the wipe/shutdown/deploy has already
    # happened by then. Same helper the websocket handshake uses (routers/exec.py), so there is
    # one definition of "who may drive this backend".
    @app.middleware("http")
    async def _enforce_origin(request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and not is_origin_allowed(
            request.headers.get("origin"), request.headers.get("host")
        ):
            # Built by hand rather than raised: an exception from inside a middleware never
            # reaches the handlers register_exception_handlers installed, so raising here would
            # produce a bare 500 instead of the API's {detail, error_type} envelope.
            exc = ForbiddenOriginError(
                f"Origin {request.headers.get('origin')!r} is not allowed to make state-changing "
                "requests to this backend."
            )
            return JSONResponse(
                status_code=exc.status_code,
                content=ErrorResponse(detail=str(exc), error_type=type(exc).__name__).model_dump(),
            )
        return await call_next(request)

    register_exception_handlers(app)

    # Applied per-router, not as global middleware: a WebSocket handshake never goes through HTTP
    # middleware, so it can't be gated this way. A no-op everywhere auth_token is unset (see
    # require_auth_token).
    auth = [Depends(require_auth_token)]
    app.include_router(system.router, prefix=API_PREFIX, dependencies=auth)
    app.include_router(labs.router, prefix=API_PREFIX, dependencies=auth)
    app.include_router(machines.router, prefix=API_PREFIX, dependencies=auth)
    app.include_router(links.router, prefix=API_PREFIX, dependencies=auth)
    # Not `dependencies=auth` here: this router also carries /tty/ws, and FastAPI's dependency
    # solver can't supply a `Request`-typed dependency in a websocket scope (there's no Request
    # there, only WebSocket) — attaching one at the router level 500s every websocket connection,
    # token or not. exec_command/exec_command_stream instead carry the dependency individually
    # (see routers/exec.py), and /tty/ws checks the same token by hand.
    app.include_router(exec_router.router, prefix=API_PREFIX)
    app.include_router(stats.router, prefix=API_PREFIX, dependencies=auth)

    # Strictly last: mount_spa adds a catch-all route, and Starlette matches routes in
    # registration order, so anything registered after it would be unreachable.
    static_dir = settings.static_dir_path()
    if static_dir:
        logging.info("Serving frontend from %s", static_dir)
        mount_spa(app, static_dir, API_PREFIX)

    return app


def run() -> None:
    """Console-script entry point: start uvicorn with a single worker."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "kathara_api.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=1,
    )


# Deliberately no module-level `app = create_app()`. Every entry point uses the factory instead
# (`run()` above, Dockerfile.dev's CMD, services/desktop/src/backend.ts — all pass
# `kathara_api.main:create_app --factory`). With one here, importing this module built an app as
# a side effect and uvicorn then built a second one from the factory, so `apply_startup_settings`
# ran twice against the process-wide KatharaService singleton (dependencies.py) — and any startup
# error, e.g. mount_spa's RuntimeError, surfaced at import time rather than from uvicorn.
