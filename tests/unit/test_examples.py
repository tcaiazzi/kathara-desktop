"""Unit tests for the bundled example network scenarios (services/examples.py) and the
``/api/labs/examples`` endpoints.

Two groups: the router/service tests below drive the *real* bundled catalog under
``src/kathara_api/examples/`` (kathara-lab_basic-ipv4/ipv6, sanitized copies of the dev fixtures
in ``data/labs/``) into a throwaway labs directory, proving the shipped examples actually parse
and install as deployable labs. ``TestExamplesCatalog`` below that drives a small synthetic
catalog instead, to cover the parse-failure and traversal cases without depending on what the
real bundled examples happen to contain.
"""

import pytest
from fastapi.testclient import TestClient

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.services import examples
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


@pytest.fixture
def client_and_service(tmp_path):
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def test_list_examples_reports_the_bundled_catalog(client_and_service):
    client, _service = client_and_service

    resp = client.get("/api/labs/examples")

    assert resp.status_code == 200, resp.text
    by_id = {e["id"]: e for e in resp.json()}
    assert set(by_id) == {"kathara-lab_basic-ipv4", "kathara-lab_basic-ipv6"}
    ipv4 = by_id["kathara-lab_basic-ipv4"]
    assert ipv4["description"] == "Basic IPv4 configurations, ping, traceroute, and arp"
    assert ipv4["n_machines"] == 5
    assert ipv4["installed"] is False


def test_create_example_lab_installs_a_deployable_lab(client_and_service):
    client, service = client_and_service

    resp = client.post("/api/labs/examples", json={"id": "kathara-lab_basic-ipv4"})

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "kathara-lab_basic-ipv4"
    assert body["n_machines"] == 5
    assert body["warnings"] == []
    machine_names = {m["name"] for m in body["machines"]}
    assert machine_names == {"r1", "r2", "pc1", "pc2", "pc3"}

    lab_dir = service.store.lab_dir("kathara-lab_basic-ipv4")
    assert (lab_dir / "lab.conf").is_file()
    assert (lab_dir / "lab.layout").is_file()
    assert (lab_dir / "pc1.startup").is_file()

    # Deployable without administrator privileges: the bundled copy must not carry the dev
    # fixture's `pc2[privileged]=True`, nor the bridged/host-port wireshark device.
    conf_text = (lab_dir / "lab.conf").read_text()
    assert "privileged" not in conf_text
    assert "wireshark" not in conf_text


def test_create_example_lab_defaults_installed_to_true_afterwards(client_and_service):
    client, _service = client_and_service
    client.post("/api/labs/examples", json={"id": "kathara-lab_basic-ipv6"})

    resp = client.get("/api/labs/examples")

    by_id = {e["id"]: e for e in resp.json()}
    assert by_id["kathara-lab_basic-ipv6"]["installed"] is True
    assert by_id["kathara-lab_basic-ipv4"]["installed"] is False


def test_create_example_lab_accepts_a_custom_name(client_and_service):
    client, service = client_and_service

    resp = client.post("/api/labs/examples", json={"id": "kathara-lab_basic-ipv4", "name": "my-copy"})

    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "my-copy"
    assert service.store.lab_dir("my-copy").is_dir()
    # The original id must not itself be installed by this — it's a fresh copy under a new name.
    assert not service.store.lab_dir("kathara-lab_basic-ipv4").exists()


def test_create_example_lab_twice_is_a_conflict(client_and_service):
    client, _service = client_and_service
    client.post("/api/labs/examples", json={"id": "kathara-lab_basic-ipv4"})

    resp = client.post("/api/labs/examples", json={"id": "kathara-lab_basic-ipv4"})

    assert resp.status_code == 409, resp.text


def test_create_example_lab_unknown_id_is_not_found(client_and_service):
    client, _service = client_and_service

    resp = client.post("/api/labs/examples", json={"id": "does-not-exist"})

    assert resp.status_code == 404, resp.text


@pytest.mark.parametrize("bad_id", ["../../etc", "..", "a/b", "a\\b"])
def test_create_example_lab_rejects_traversal_attempts(client_and_service, bad_id):
    client, service = client_and_service

    resp = client.post("/api/labs/examples", json={"id": bad_id})

    # Never a 500, and never anything actually created in (or outside) the labs root.
    assert resp.status_code in (400, 404), resp.text
    assert service.store.lab_names() == []


class _FakeSettings:
    """Just enough of ApiSettings for examples.py's _catalog() to work against a synthetic
    catalog instead of the real bundled one."""

    def __init__(self, examples_dir):
        self._examples_dir = examples_dir

    def examples_dir_path(self):
        return self._examples_dir


class TestExamplesCatalog:
    """Drives services/examples.py directly against a small synthetic catalog, so parse-failure
    handling doesn't depend on the real bundled examples staying broken-free forever."""

    def test_a_broken_example_is_skipped_not_raised(self, tmp_path, monkeypatch):
        catalog = tmp_path / "examples"
        good = catalog / "good-lab"
        good.mkdir(parents=True)
        (good / "lab.conf").write_text('LAB_DESCRIPTION="A good lab"\npc1[image]="kathara/base"\npc1[0]="A"\n')

        broken = catalog / "broken-lab"
        broken.mkdir(parents=True)
        # No lab.conf and no machine folders/startups: translate_lab_files reports this as an
        # error ("no lab.conf and no machine folders found"), which list_examples must swallow.
        (broken / "readme.txt").write_text("not a lab")

        monkeypatch.setattr(examples, "get_settings", lambda: _FakeSettings(catalog))

        summaries = examples.list_examples(installed=set())

        assert {s.id for s in summaries} == {"good-lab"}
        assert summaries[0].description == "A good lab"
        assert summaries[0].n_machines == 1

    def test_example_dir_rejects_an_id_outside_the_catalog(self, tmp_path, monkeypatch):
        catalog = tmp_path / "examples"
        catalog.mkdir()
        monkeypatch.setattr(examples, "get_settings", lambda: _FakeSettings(catalog))

        with pytest.raises(Exception):
            examples.example_dir("../../etc")

    def test_example_dir_404s_on_an_id_not_in_the_catalog(self, tmp_path, monkeypatch):
        catalog = tmp_path / "examples"
        catalog.mkdir()
        monkeypatch.setattr(examples, "get_settings", lambda: _FakeSettings(catalog))

        from kathara_api.errors import ExampleNotFoundError

        with pytest.raises(ExampleNotFoundError):
            examples.example_dir("nonexistent")
