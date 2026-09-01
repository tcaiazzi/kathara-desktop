"""Optional static hosting of the built React SPA from the API process itself.

Normally the SPA is served by something else: Vite's dev server proxies ``/api`` to this
backend in development (services/frontend/vite.config.ts), and an nginx reverse proxy does
the same in Docker Compose (services/reverse-proxy/nginx.conf). Either way the browser sees
a single origin, which is what the frontend's transport layer assumes throughout: relative
``/api`` fetches, a WebSocket URL built from ``window.location.host``, a relative
``EventSource`` URL, and ``BrowserRouter`` deep links.

The desktop app (services/desktop) has no reverse proxy to put in front, so it points
``KATHARA_API_STATIC_DIR`` at the bundled build and lets this process serve it. That keeps
the renderer a same-origin web app, so none of the above has to change.

Nothing here is active unless that setting is set: the default deployments are untouched.
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

# index.html is the one file whose name never changes, so it's the one file a browser must
# never keep: every asset it references is content-hashed, but a stale index.html would go on
# pointing at the previous build's chunks after the app updates.
_INDEX_HEADERS = {"Cache-Control": "no-store"}


def mount_spa(app: FastAPI, static_dir: Path, api_prefix: str) -> None:
    """Serve the built SPA in ``static_dir`` at the application root.

    Must be called *after* every API router is registered: the catch-all route added here
    matches any path, and Starlette resolves routes in registration order, so registering it
    first would shadow the entire API (and /docs, /redoc, /openapi.json, which FastAPI
    registers when the app is constructed).
    """
    root = static_dir.resolve()
    index_file = root / "index.html"
    if not index_file.is_file():
        raise RuntimeError(f"static_dir has no index.html: {static_dir}")

    # Hashed build output — safe and worth caching hard. Mounted explicitly (rather than left
    # to the catch-all) so a missing asset 404s as a missing asset instead of silently
    # returning index.html, which would surface as a confusing JS syntax error in the console.
    assets_dir = root / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="spa-assets")

    api_root = api_prefix.strip("/")

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def serve_spa(full_path: str) -> Response:
        """Serve a real file when one exists, else index.html (client-side routing).

        Equivalent to nginx's ``try_files $uri $uri/ /index.html``
        (services/frontend/nginx.conf).
        """
        # An unmatched API path must stay an API 404 with the usual JSON error body. Without
        # this it would fall through to the SPA fallback below and answer HTML with 200,
        # which turns a typo in a route into a baffling client-side parse error.
        if full_path == api_root or full_path.startswith(f"{api_root}/"):
            raise HTTPException(status_code=404, detail="Not Found")

        if full_path:
            # `full_path` is client-controlled: resolve it and confirm it stayed inside the
            # build directory before touching it, so `../../etc/passwd` can't escape.
            candidate = (static_dir / full_path).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return FileResponse(candidate)

        return FileResponse(index_file, headers=_INDEX_HEADERS)
