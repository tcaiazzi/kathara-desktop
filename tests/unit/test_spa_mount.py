"""Unit tests for the optional static SPA mount (KATHARA_API_STATIC_DIR)."""

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from kathara_api.config import ApiSettings
from kathara_api.spa import mount_spa

API_PREFIX = "/api"


@pytest.fixture
def build_dir(tmp_path):
    """A minimal stand-in for services/frontend/dist."""
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div>")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index-abc123.js").write_text("console.log(1)")
    return tmp_path


@pytest.fixture
def client(build_dir):
    """An app shaped like the real one: API routes first, SPA mounted last."""
    app = FastAPI()
    router = APIRouter()

    @router.get("/health")
    def health():
        return {"status": "ok"}

    app.include_router(router, prefix=API_PREFIX)
    mount_spa(app, build_dir, API_PREFIX)
    return TestClient(app)


def test_root_serves_index(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "id=root" in res.text


def test_index_is_not_cached(client):
    # Asset filenames are content-hashed, index.html's is not: a cached index.html would keep
    # pointing at the previous build's chunks after an update.
    assert client.get("/").headers["cache-control"] == "no-store"


@pytest.mark.parametrize("path", ["/workspace", "/workspace/mylab", "/labs/mylab/terminal/pc1"])
def test_client_side_routes_fall_back_to_index(client, path):
    """BrowserRouter deep links must serve the SPA, not 404 (nginx's try_files equivalent)."""
    res = client.get(path)
    assert res.status_code == 200
    assert "id=root" in res.text


def test_real_file_is_served_over_the_fallback(client):
    res = client.get("/favicon.svg")
    assert res.status_code == 200
    assert res.text == "<svg/>"


def test_hashed_assets_are_served(client):
    res = client.get("/assets/index-abc123.js")
    assert res.status_code == 200
    assert res.text == "console.log(1)"


def test_missing_asset_404s_instead_of_returning_index(client):
    # Returning index.html for a missing chunk would surface as an opaque JS parse error.
    assert client.get("/assets/does-not-exist.js").status_code == 404


def test_api_routes_still_win_over_the_catch_all(client):
    res = client.get(f"{API_PREFIX}/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/api", "/api/", "/api/nope"])
def test_unknown_api_paths_404_rather_than_serving_the_spa(client, path):
    res = client.get(path)
    assert res.status_code == 404
    assert "id=root" not in res.text


def test_path_traversal_is_refused(client, build_dir):
    secret = build_dir.parent / "secret.txt"
    secret.write_text("SENSITIVE")

    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/foo/../../secret.txt"):
        res = client.get(path)
        assert "SENSITIVE" not in res.text, f"{path} escaped the build directory"


def test_mount_requires_an_index_html(tmp_path):
    with pytest.raises(RuntimeError, match="index.html"):
        mount_spa(FastAPI(), tmp_path, API_PREFIX)


def test_mount_works_without_an_assets_dir(tmp_path):
    """A build with no code-split chunks still mounts."""
    (tmp_path / "index.html").write_text("<html/>")
    app = FastAPI()
    mount_spa(app, tmp_path, API_PREFIX)
    assert TestClient(app).get("/").status_code == 200


class TestStaticDirSetting:
    def test_unset_by_default(self):
        assert ApiSettings(static_dir=None).static_dir_path() is None

    def test_blank_is_treated_as_unset(self):
        assert ApiSettings(static_dir="   ").static_dir_path() is None

    def test_missing_directory_is_treated_as_unset(self, tmp_path):
        # The API must still start and serve /api when the frontend hasn't been built.
        assert ApiSettings(static_dir=str(tmp_path / "nope")).static_dir_path() is None

    def test_existing_directory_resolves_to_an_absolute_path(self, tmp_path):
        resolved = ApiSettings(static_dir=str(tmp_path)).static_dir_path()
        assert resolved == tmp_path.resolve()
        assert resolved.is_absolute()
