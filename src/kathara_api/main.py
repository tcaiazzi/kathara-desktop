"""FastAPI application factory and entry point."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .dependencies import get_service
from .errors import register_exception_handlers
from .routers import exec as exec_router
from .routers import labs, links, machines, stats, system
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
    # Docker Compose reverse-proxy, need none).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)

    app.include_router(system.router, prefix=API_PREFIX)
    app.include_router(labs.router, prefix=API_PREFIX)
    app.include_router(machines.router, prefix=API_PREFIX)
    app.include_router(links.router, prefix=API_PREFIX)
    app.include_router(exec_router.router, prefix=API_PREFIX)
    app.include_router(stats.router, prefix=API_PREFIX)

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


app = create_app()
