"""Unit tests for the upstream lab gallery (services/lab_gallery.py) and the
``/api/labs/gallery`` endpoints — the remote twin of test_examples.py.

Every test drives a synthetic GitHub repo: a hand-built tree (as the Trees API would return it)
plus a path->content map, with ``httpx.get``/``httpx.Client`` monkeypatched to serve them. Nothing
here ever makes a real network call except the one test marked ``network`` at the bottom, which is
skipped by default and exists only to catch the real repo drifting out from under this feature.
"""

import pytest
from fastapi.testclient import TestClient

from kathara_api.dependencies import get_service
from kathara_api.errors import ApiError, GalleryLabNotFoundError, GalleryUnavailableError, LabAlreadyRegisteredError
from kathara_api.main import create_app
from kathara_api.services import lab_gallery
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


# ---------------------------------------------------------------------------
# Fake GitHub
# ---------------------------------------------------------------------------


class _FakeSettings:
    """Just enough of ApiSettings for lab_gallery.py to work against a synthetic repo."""

    def __init__(self, repo="acme/kathara-labs-fork", ref="main", section="main-labs"):
        self.gallery_repo = repo
        self.gallery_ref = ref
        self.gallery_section = section
        self.gallery_cache_ttl = 900
        self.gallery_token = None

    def gallery_slug(self):
        return self.gallery_repo

    def gallery_ref_value(self):
        return self.gallery_ref

    def gallery_section_path(self):
        return self.gallery_section.strip("/")


class _FakeResponse:
    def __init__(self, status_code=200, json_data=None, text_data="", content=None, headers=None):
        self.status_code = status_code
        self._json = json_data
        self.text = text_data
        self.content = content if content is not None else text_data.encode()
        self.headers = headers or {}

    def json(self):
        if self._json is None:
            raise ValueError("no json body")
        return self._json


def _blob(path, content):
    size = len(content) if isinstance(content, bytes) else len(content.encode())
    return {"path": path, "type": "blob", "size": size}


def _install_fake_repo(monkeypatch, tree, files, settings=None):
    """Point lab_gallery at a synthetic repo: `tree` (list of blob dicts) for the Trees API,
    `files` (path -> str|bytes) for every raw.githubusercontent GET."""
    settings = settings or _FakeSettings()
    monkeypatch.setattr(lab_gallery, "get_settings", lambda: settings)

    def fake_get(url, params=None, headers=None, timeout=None, follow_redirects=None):
        assert "git/trees" in url
        return _FakeResponse(200, json_data={"tree": tree, "truncated": False})

    monkeypatch.setattr(lab_gallery.httpx, "get", fake_get)

    url_to_path = {lab_gallery._raw_url(path): path for path in files}

    class _FakeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, timeout=None, follow_redirects=None):
            path = url_to_path.get(url)
            if path is None:
                return _FakeResponse(404)
            content = files[path]
            if isinstance(content, str):
                return _FakeResponse(200, text_data=content)
            return _FakeResponse(200, content=content)

    monkeypatch.setattr(lab_gallery.httpx, "Client", _FakeClient)
    return settings


@pytest.fixture(autouse=True)
def _clear_gallery_cache():
    lab_gallery.invalidate_cache()
    yield
    lab_gallery.invalidate_cache()


# A small two-category repo used by most tests: one lab with a described README table, one pair
# of same-basename labs (the frr/quagga collision), and one grouped-labs README fallback case.
_TREE = [
    _blob("main-labs/README.md", "# Main Labs\n* [Basic Topics](basic-topics)\n* [Grouped](grouped)\n"),
    _blob(
        "main-labs/basic-topics/README.md",
        "# Basic Topics\n"
        "| Name | Description | Slides | Lab |\n"
        "|---|---|---|---|\n"
        "| **ARP** | Understanding ARP. | [pdf](arp/005-arp.pdf) | [zip](arp/kathara-lab_arp.zip) |\n",
    ),
    _blob("main-labs/basic-topics/arp/005-arp.pdf", b"%PDF-fake"),
    _blob("main-labs/basic-topics/arp/kathara-lab_arp/lab.conf", "pc1[image]=kathara/base\npc1[0]=A\n"),
    _blob("main-labs/basic-topics/arp/kathara-lab_arp/pc1.startup", "echo hi\n"),
    _blob(
        "main-labs/interdomain/frr/bgp/kathara-lab_bgp/lab.conf",
        "r1[image]=kathara/base\nr1[0]=A\n",
    ),
    _blob("main-labs/interdomain/frr/bgp/kathara-lab_bgp/r1.startup", "echo frr\n"),
    _blob(
        "main-labs/interdomain/quagga/bgp/kathara-lab_bgp/lab.conf",
        "r1[image]=kathara/base\nr1[0]=A\n",
    ),
    _blob("main-labs/interdomain/quagga/bgp/kathara-lab_bgp/r1.startup", "echo quagga\n"),
    _blob(
        "main-labs/grouped/README.md",
        "# Grouped\n"
        "| Name | Description | Slides | Lab |\n"
        "|---|---|---|---|\n"
        "| **OSPF** | A grouped OSPF scenario. | [pdf](ospf/000-ospf.pdf) | - |\n",
    ),
    _blob("main-labs/grouped/ospf/000-ospf.pdf", b"%PDF-fake"),
    _blob("main-labs/grouped/ospf/subA/lab.conf", "pc1[image]=kathara/base\npc1[0]=A\n"),
    _blob("main-labs/grouped/ospf/subA/pc1.startup", "echo a\n"),
    _blob("main-labs/grouped/ospf/subB/lab.conf", "pc1[image]=kathara/base\npc1[0]=A\n"),
    _blob("main-labs/grouped/ospf/subB/pc1.startup", "echo b\n"),
    # Outside the configured section entirely — must never show up in the catalog.
    _blob("exam-labs/some-exam/lab.conf", "pc1[image]=kathara/base\npc1[0]=A\n"),
]
_FILES = {
    "main-labs/README.md": "# Main Labs\n* [Basic Topics](basic-topics)\n* [Grouped](grouped)\n",
    "main-labs/basic-topics/README.md": (
        "# Basic Topics\n"
        "| Name | Description | Slides | Lab |\n"
        "|---|---|---|---|\n"
        "| **ARP** | Understanding ARP. | [pdf](arp/005-arp.pdf) | [zip](arp/kathara-lab_arp.zip) |\n"
    ),
    "main-labs/basic-topics/arp/005-arp.pdf": b"%PDF-fake",
    "main-labs/basic-topics/arp/kathara-lab_arp/lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n",
    "main-labs/basic-topics/arp/kathara-lab_arp/pc1.startup": "echo hi\n",
    "main-labs/interdomain/frr/bgp/kathara-lab_bgp/lab.conf": "r1[image]=kathara/base\nr1[0]=A\n",
    "main-labs/interdomain/frr/bgp/kathara-lab_bgp/r1.startup": "echo frr\n",
    "main-labs/interdomain/quagga/bgp/kathara-lab_bgp/lab.conf": "r1[image]=kathara/base\nr1[0]=A\n",
    "main-labs/interdomain/quagga/bgp/kathara-lab_bgp/r1.startup": "echo quagga\n",
    "main-labs/grouped/README.md": (
        "# Grouped\n"
        "| Name | Description | Slides | Lab |\n"
        "|---|---|---|---|\n"
        "| **OSPF** | A grouped OSPF scenario. | [pdf](ospf/000-ospf.pdf) | - |\n"
    ),
    "main-labs/grouped/ospf/000-ospf.pdf": b"%PDF-fake",
    "main-labs/grouped/ospf/subA/lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n",
    "main-labs/grouped/ospf/subA/pc1.startup": "echo a\n",
    "main-labs/grouped/ospf/subB/lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n",
    "main-labs/grouped/ospf/subB/pc1.startup": "echo b\n",
    "exam-labs/some-exam/lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n",
}


def _catalog(monkeypatch, tree=_TREE, files=_FILES, settings=None):
    _install_fake_repo(monkeypatch, tree, files, settings)
    return lab_gallery.fetch_catalog()


# ---------------------------------------------------------------------------
# Catalog building
# ---------------------------------------------------------------------------


def test_discovers_every_lab_dir_under_the_configured_section(monkeypatch):
    catalog = _catalog(monkeypatch)

    assert set(catalog.entries) == {
        "main-labs/basic-topics/arp/kathara-lab_arp",
        "main-labs/interdomain/frr/bgp/kathara-lab_bgp",
        "main-labs/interdomain/quagga/bgp/kathara-lab_bgp",
        "main-labs/grouped/ospf/subA",
        "main-labs/grouped/ospf/subB",
    }
    # The exam-labs lab.conf is outside main-labs/ and must not leak in.
    assert not any("exam-labs" in lab_id for lab_id in catalog.entries)


def test_catalog_reports_provenance(monkeypatch):
    settings = _FakeSettings(repo="acme/fork", ref="dev", section="main-labs")
    catalog = _catalog(monkeypatch, settings=settings)

    assert catalog.repo == "acme/fork"
    assert catalog.ref == "dev"
    assert catalog.section == "main-labs"
    assert catalog.fetched_at > 0


def test_colliding_basenames_get_disambiguated_names(monkeypatch):
    catalog = _catalog(monkeypatch)

    frr = catalog.entries["main-labs/interdomain/frr/bgp/kathara-lab_bgp"]
    quagga = catalog.entries["main-labs/interdomain/quagga/bgp/kathara-lab_bgp"]

    assert frr.name != quagga.name
    assert frr.name != "kathara-lab_bgp"  # never left ambiguous
    assert quagga.name != "kathara-lab_bgp"
    assert {frr.name, quagga.name} == {"kathara-lab_bgp_frr", "kathara-lab_bgp_quagga"}


def test_non_colliding_lab_keeps_its_plain_basename(monkeypatch):
    catalog = _catalog(monkeypatch)

    arp = catalog.entries["main-labs/basic-topics/arp/kathara-lab_arp"]
    assert arp.name == "kathara-lab_arp"


def test_slides_link_points_at_the_sibling_pdf(monkeypatch):
    catalog = _catalog(monkeypatch)

    arp = catalog.entries["main-labs/basic-topics/arp/kathara-lab_arp"]
    assert arp.slides_url == lab_gallery._blob_url("main-labs/basic-topics/arp/005-arp.pdf")


def test_repo_url_points_at_the_lab_directory(monkeypatch):
    catalog = _catalog(monkeypatch)

    arp = catalog.entries["main-labs/basic-topics/arp/kathara-lab_arp"]
    assert arp.repo_url == lab_gallery._tree_url("main-labs/basic-topics/arp/kathara-lab_arp")


def test_readme_table_supplies_title_and_description(monkeypatch):
    catalog = _catalog(monkeypatch)

    arp = catalog.entries["main-labs/basic-topics/arp/kathara-lab_arp"]
    assert arp.title == "ARP"
    assert arp.description == "Understanding ARP."
    assert arp.category == "basic-topics"
    assert arp.category_title == "Basic Topics"


def test_readme_row_with_no_zip_falls_back_to_the_slides_directory(monkeypatch):
    catalog = _catalog(monkeypatch)

    sub_a = catalog.entries["main-labs/grouped/ospf/subA"]
    sub_b = catalog.entries["main-labs/grouped/ospf/subB"]
    assert sub_a.title == sub_b.title == "OSPF"
    assert "grouped OSPF" in sub_a.description


def test_section_readme_supplies_category_order(monkeypatch):
    catalog = _catalog(monkeypatch)

    orders = {entry.category: entry.category_order for entry in catalog.entries.values()}
    assert orders["basic-topics"] < orders["grouped"]


def test_missing_readmes_leave_labs_undescribed_without_raising(monkeypatch):
    tree = [_blob("main-labs/noreadme/kathara-lab_x/lab.conf", "pc1[image]=kathara/base\npc1[0]=A\n")]
    files = {"main-labs/noreadme/kathara-lab_x/lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}

    catalog = _catalog(monkeypatch, tree=tree, files=files)

    entry = catalog.entries["main-labs/noreadme/kathara-lab_x"]
    assert entry.title is None
    assert entry.description is None


def test_a_broken_readme_fetch_does_not_break_the_catalog(monkeypatch):
    """_enrich is decoration only — a README that 404s (or the whole README fetch blowing up)
    must never cost the user the underlying lab list, mirroring examples.list_examples."""
    _install_fake_repo(monkeypatch, _TREE, {})  # every raw file 404s

    catalog = lab_gallery.fetch_catalog()

    assert len(catalog.entries) == 5
    assert all(entry.title is None for entry in catalog.entries.values())


# ---------------------------------------------------------------------------
# Upstream failures
# ---------------------------------------------------------------------------


def test_truncated_tree_is_unavailable(monkeypatch):
    settings = _FakeSettings()
    monkeypatch.setattr(lab_gallery, "get_settings", lambda: settings)
    monkeypatch.setattr(
        lab_gallery.httpx,
        "get",
        lambda *a, **kw: _FakeResponse(200, json_data={"tree": [], "truncated": True}),
    )

    with pytest.raises(GalleryUnavailableError):
        lab_gallery.fetch_catalog()


def test_non_200_tree_response_is_unavailable(monkeypatch):
    settings = _FakeSettings()
    monkeypatch.setattr(lab_gallery, "get_settings", lambda: settings)
    monkeypatch.setattr(lab_gallery.httpx, "get", lambda *a, **kw: _FakeResponse(500))

    with pytest.raises(GalleryUnavailableError):
        lab_gallery.fetch_catalog()


def test_network_error_fetching_the_tree_is_unavailable(monkeypatch):
    import httpx

    settings = _FakeSettings()
    monkeypatch.setattr(lab_gallery, "get_settings", lambda: settings)

    def boom(*a, **kw):
        raise httpx.ConnectError("no route to host")

    monkeypatch.setattr(lab_gallery.httpx, "get", boom)

    with pytest.raises(GalleryUnavailableError):
        lab_gallery.fetch_catalog()


def test_exhausted_rate_limit_says_so(monkeypatch):
    settings = _FakeSettings()
    monkeypatch.setattr(lab_gallery, "get_settings", lambda: settings)
    monkeypatch.setattr(
        lab_gallery.httpx,
        "get",
        lambda *a, **kw: _FakeResponse(403, headers={"x-ratelimit-remaining": "0"}),
    )

    with pytest.raises(GalleryUnavailableError, match="rate limit"):
        lab_gallery.fetch_catalog()


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def test_catalog_is_cached_until_refresh_is_requested(monkeypatch):
    settings = _FakeSettings()
    monkeypatch.setattr(lab_gallery, "get_settings", lambda: settings)
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        return _FakeResponse(200, json_data={"tree": _TREE, "truncated": False})

    monkeypatch.setattr(lab_gallery.httpx, "get", fake_get)
    monkeypatch.setattr(lab_gallery.httpx, "Client", lambda *a, **kw: _NullClient())

    lab_gallery.fetch_catalog()
    lab_gallery.fetch_catalog()
    assert len(calls) == 1  # second call served from cache

    lab_gallery.fetch_catalog(refresh=True)
    assert len(calls) == 2


class _NullClient:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, *a, **kw):
        return _FakeResponse(404)  # READMEs 404 — fine, enrichment is best-effort


# ---------------------------------------------------------------------------
# Installing a gallery lab (through KatharaService, like test_lab_import_service.py)
# ---------------------------------------------------------------------------


def _service(tmp_path):
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    return service


def test_install_gallery_lab_writes_and_registers_it(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    service = _service(tmp_path)

    lab, warnings = service.install_gallery_lab("main-labs/basic-topics/arp/kathara-lab_arp")

    assert lab.name == "kathara-lab_arp"
    assert warnings == []
    lab_dir = service.store.lab_dir("kathara-lab_arp")
    assert (lab_dir / "lab.conf").read_text() == "pc1[image]=kathara/base\npc1[0]=A\n"
    assert (lab_dir / "pc1.startup").read_text() == "echo hi\n"
    # The sibling slides PDF lives outside the lab dir upstream and must never be fetched.
    assert not (lab_dir / "005-arp.pdf").exists()


def test_install_gallery_lab_flips_installed_on_next_listing(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    service = _service(tmp_path)
    service.install_gallery_lab("main-labs/basic-topics/arp/kathara-lab_arp")

    catalog = service.list_gallery_labs()

    by_id = {e.id: e for e in catalog.labs}
    assert by_id["main-labs/basic-topics/arp/kathara-lab_arp"].installed is True
    assert by_id["main-labs/interdomain/frr/bgp/kathara-lab_bgp"].installed is False


def test_install_gallery_lab_accepts_a_custom_name(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    service = _service(tmp_path)

    lab, _warnings = service.install_gallery_lab(
        "main-labs/basic-topics/arp/kathara-lab_arp", name="my-arp"
    )

    assert lab.name == "my-arp"
    assert service.store.lab_dir("my-arp").is_dir()
    assert not service.store.lab_dir("kathara-lab_arp").exists()


def test_install_gallery_lab_twice_is_a_conflict(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    service = _service(tmp_path)
    service.install_gallery_lab("main-labs/basic-topics/arp/kathara-lab_arp")

    with pytest.raises(LabAlreadyRegisteredError):
        service.install_gallery_lab("main-labs/basic-topics/arp/kathara-lab_arp")


def test_install_gallery_lab_unknown_id_is_not_found(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    service = _service(tmp_path)

    with pytest.raises(GalleryLabNotFoundError):
        service.install_gallery_lab("main-labs/does/not/exist")


def test_install_gallery_lab_rolls_back_directory_on_parse_error(tmp_path, monkeypatch):
    tree = [_blob("main-labs/bad/kathara-lab_bad/lab.conf", "not a valid conf line at all\n")]
    files = {"main-labs/bad/kathara-lab_bad/lab.conf": "not a valid conf line at all\n"}
    _install_fake_repo(monkeypatch, tree, files)
    service = _service(tmp_path)

    with pytest.raises(ApiError):
        service.install_gallery_lab("main-labs/bad/kathara-lab_bad")

    assert not service.store.lab_dir("kathara-lab_bad").exists()


def test_install_gallery_lab_enforces_the_file_count_cap(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    monkeypatch.setattr(lab_gallery, "MAX_FILES_PER_LAB", 1)
    service = _service(tmp_path)

    with pytest.raises(GalleryUnavailableError):
        service.install_gallery_lab("main-labs/basic-topics/arp/kathara-lab_arp")  # 2 files upstream

    assert not service.store.lab_dir("kathara-lab_arp").exists()


def test_install_gallery_lab_enforces_the_per_file_size_cap(tmp_path, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    monkeypatch.setattr(lab_gallery, "MAX_BYTES_PER_FILE", 4)  # smaller than "echo hi\n"
    service = _service(tmp_path)

    with pytest.raises(GalleryUnavailableError):
        service.install_gallery_lab("main-labs/basic-topics/arp/kathara-lab_arp")

    assert not service.store.lab_dir("kathara-lab_arp").exists()


@pytest.mark.parametrize("bad_id", ["../../etc", "does/not/exist"])
def test_install_gallery_lab_bad_or_unknown_id_never_creates_anything(tmp_path, monkeypatch, bad_id):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    service = _service(tmp_path)

    with pytest.raises(ApiError):
        service.install_gallery_lab(bad_id)

    assert service.store.lab_names() == []


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


@pytest.fixture
def client_and_service(tmp_path):
    service = _service(tmp_path)
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def test_get_gallery_lists_the_catalog(client_and_service, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    client, _service = client_and_service

    resp = client.get("/api/labs/gallery")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["repo"] == "acme/kathara-labs-fork"
    ids = {lab["id"] for lab in body["labs"]}
    assert "main-labs/basic-topics/arp/kathara-lab_arp" in ids


def test_post_gallery_installs_a_lab(client_and_service, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    client, service = client_and_service

    resp = client.post(
        "/api/labs/gallery", json={"id": "main-labs/basic-topics/arp/kathara-lab_arp"}
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "kathara-lab_arp"
    assert service.store.lab_dir("kathara-lab_arp").is_dir()


def test_post_gallery_unknown_id_is_404(client_and_service, monkeypatch):
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    client, _service = client_and_service

    resp = client.post("/api/labs/gallery", json={"id": "main-labs/nope"})

    assert resp.status_code == 404, resp.text


def test_get_gallery_route_is_not_shadowed_by_get_lab_name(client_and_service, monkeypatch):
    """`/labs/gallery` must resolve to the gallery route, not GET /{lab_name} with lab_name
    literally "gallery" — the same registration-order trap the /examples routes are guarded
    against (see routers/labs.py)."""
    _install_fake_repo(monkeypatch, _TREE, _FILES)
    client, _service = client_and_service

    resp = client.get("/api/labs/gallery")

    assert resp.status_code == 200, resp.text
    assert "labs" in resp.json()  # a GalleryCatalog, not a 404 LabDetail lookup


# ---------------------------------------------------------------------------
# Live smoke test — skipped unless explicitly requested (`pytest -m network`)
# ---------------------------------------------------------------------------


@pytest.mark.network
def test_real_gallery_has_the_expected_shape():
    lab_gallery.invalidate_cache()
    catalog = lab_gallery.fetch_catalog(refresh=True)

    assert catalog.repo == "KatharaFramework/Kathara-Labs"
    assert len(catalog.entries) >= 60
    assert all("/" in entry.id for entry in catalog.entries.values())
    assert any(entry.description for entry in catalog.entries.values())
