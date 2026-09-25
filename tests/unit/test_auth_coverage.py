"""Every route under /api must require auth.

test_auth.py only unit-tests require_auth_token in isolation against a throwaway one-route app;
nothing exercises the real create_app() to confirm the dependency is actually wired onto every
route. The one known, deliberate exception is routers/exec.py's websocket route (`/tty/ws`),
which can't take a Request-typed dependency at all — see main.py's own comment on why it's
registered without `dependencies=auth` and instead checks the token by hand. A new endpoint added
anywhere else without the dependency would otherwise ship silently unauthenticated.
"""

from types import SimpleNamespace

import pytest
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient

from kathara_api.main import API_PREFIX, create_app

TOKEN = "secret"

# The one deliberate exception (see module docstring and main.py's own comment on the exec_router
# include). test_every_websocket_route_is_deliberately_excluded keeps this set honest.
EXCLUDED_PATHS = {f"{API_PREFIX}/labs/{{lab_id}}/machines/{{machine_name}}/tty/ws"}


def _flatten_routes(routes):
    """FastAPI (>=0.141) wraps `include_router`'d routes in a lazy `_IncludedRouter` rather than
    copying them onto `app.routes` with the prefix baked in — `app.routes` itself only shows the
    auto-generated docs/openapi routes plus one `_IncludedRouter` per `include_router` call.
    Recurse into `.original_router.routes` to reach the real `APIRoute`/`APIWebSocketRoute`
    objects (this app never nests `include_router` more than one level, but recursing handles it
    either way). Websocket routes are yielded too, so a new one can't slip past EXCLUDED_PATHS
    unnoticed — only `_cases` narrows back to what a TestClient request can actually drive."""
    for route in routes:
        if isinstance(route, (APIRoute, APIWebSocketRoute)):
            yield route
        elif hasattr(route, "original_router"):
            yield from _flatten_routes(route.original_router.routes)


def _full_path(route: APIRoute | APIWebSocketRoute) -> str:
    """The route's path as this app actually serves it. `route.path` on a flattened route is
    relative to whatever router it was declared on (its own internal prefix, e.g.
    `/labs/{lab_name}/machines/{machine_name}/shells`, is already included) — but the outer
    `API_PREFIX` passed to `include_router` in main.py is applied at inclusion time and is not
    reflected on the route object itself in this FastAPI version, so it has to be prepended by
    hand."""
    return API_PREFIX + route.path


@pytest.fixture
def auth_client(monkeypatch):
    monkeypatch.setattr(
        "kathara_api.dependencies.get_settings",
        lambda: SimpleNamespace(auth_token=TOKEN),
    )
    return TestClient(create_app(), raise_server_exceptions=False)


def _api_routes(app):
    for route in _flatten_routes(app.routes):
        if _full_path(route) not in EXCLUDED_PATHS:
            yield route


def _dummy_path(route: APIRoute) -> str:
    placeholders = {name: "placeholder" for name in route.param_convertors}
    return _full_path(route).format(**placeholders)


def _cases():
    # A throwaway app just to enumerate routes; the routes themselves don't depend on settings.
    app = create_app()
    for route in _api_routes(app):
        # A websocket route has no `.methods` and can't be driven by `client.request` at all;
        # test_every_websocket_route_is_deliberately_excluded covers that side instead.
        if not isinstance(route, APIRoute):
            continue
        method = next(iter(route.methods - {"HEAD", "OPTIONS"}))
        yield pytest.param(method, _dummy_path(route), id=f"{method} {route.path}")


@pytest.mark.parametrize("method,path", list(_cases()))
def test_route_requires_auth_token(auth_client, method, path):
    """Calling any /api route with no token must 401, never reach the handler body. Safe even for
    POST /api/system/shutdown and /system/wipe: if auth is enforced first (the property under
    test), their side-effecting bodies never run."""
    resp = auth_client.request(method, path)
    assert resp.status_code == 401, (
        f"{method} {path} returned {resp.status_code}, not 401 — either the auth dependency is "
        "missing from this route, or something else (e.g. request validation) ran before it."
    )


def test_every_websocket_route_is_deliberately_excluded():
    """A websocket route can't take a Request-typed dependency, so `dependencies=auth` can't cover
    it and the parametrized test above can't exercise it. Each one must therefore check its token
    by hand in the handler and be named in EXCLUDED_PATHS, as a decision rather than an oversight."""
    app = create_app()
    unreviewed = sorted(_full_path(r) for r in _api_routes(app) if isinstance(r, APIWebSocketRoute))
    assert unreviewed == [], (
        f"Websocket route(s) missing from EXCLUDED_PATHS: {unreviewed}. Check the token by hand in "
        "the handler (see routers/exec.py) and add the path to EXCLUDED_PATHS."
    )

    # And the converse: an entry left behind after its route is gone excludes nothing.
    served = {_full_path(r) for r in _flatten_routes(app.routes)}
    stale = sorted(EXCLUDED_PATHS - served)
    assert stale == [], f"EXCLUDED_PATHS names route(s) that no longer exist: {stale}"


def test_no_token_configured_leaves_every_route_reachable(monkeypatch):
    """Sanity check for the enumeration itself: with no auth_token configured (the default for
    every deployment except the desktop app), the same routes must NOT 401 — otherwise the 401s
    above would just mean "auth_token happened to be set", not "the dependency works"."""
    monkeypatch.setattr("kathara_api.dependencies.get_settings", lambda: SimpleNamespace(auth_token=None))
    client = TestClient(create_app(), raise_server_exceptions=False)
    app = create_app()
    # A representative sample rather than the whole surface: this is only guarding against the
    # parametrized test above being vacuously true, not re-testing every route.
    sample = [r for r in _api_routes(app) if _full_path(r) in (f"{API_PREFIX}/health", f"{API_PREFIX}/labs")]
    assert sample
    for route in sample:
        method = next(iter(route.methods - {"HEAD", "OPTIONS"}))
        resp = client.request(method, _dummy_path(route))
        assert resp.status_code != 401
