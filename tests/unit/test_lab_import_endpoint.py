"""Unit tests for the lab-import endpoint's own wiring (no Docker required).

Distinct from ``test_lab_import_service.py``, which drives ``KatharaService`` directly: what is
covered here only exists in the router layer — in particular that a deploy-on-import acts on the
name the lab was actually *stored* under, not the raw one the client submitted.
"""

import pytest
from fastapi.testclient import TestClient

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


class _FakeFacade(FakeFacadeBase):
    def __init__(self):
        self.deployed = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.deployed.append(lab.name)
        for machine in lab.machines.values():
            machine.api_object = object()


@pytest.fixture
def client_and_service(tmp_path):
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = _FakeFacade()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


LAB_CONF = 'pc1[image]="kathara/base"\npc1[0]="A"\n'


def test_import_deploys_the_lab_under_its_sanitized_name(client_and_service):
    """A name needing sanitization must still deploy.

    ``import_lab`` registers the lab under ``sanitize_lab_name(name)`` — which strips surrounding
    whitespace — so deploying by the raw submitted name looks up a lab that was never registered
    and 404s on one that had just been created successfully.
    """
    client, service = client_and_service

    resp = client.post(
        "/api/labs/import",
        json={"name": "  spaced-lab  ", "files": {"lab.conf": LAB_CONF}, "deploy": True},
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "spaced-lab"
    assert resp.json()["deployed"] is True
    assert service._instance.deployed == ["spaced-lab"]


def test_import_without_deploy_still_stores_under_the_sanitized_name(client_and_service):
    client, service = client_and_service

    resp = client.post(
        "/api/labs/import",
        json={"name": "  spaced-lab  ", "files": {"lab.conf": LAB_CONF}},
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["deployed"] is False
    assert service._instance.deployed == []
    assert service.store.lab_dir("spaced-lab").is_dir()
