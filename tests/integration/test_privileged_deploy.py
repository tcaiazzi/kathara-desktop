"""A privileged device deployed by a backend that is not root, behind the desktop shell's grant.
Requires a running Docker daemon.

Run with: ``pytest -m docker``. Meaningful as a non-root user in the ``docker`` group: that is
the setup where Kathara's own root check (bypassed in kathara_compat.py) would otherwise refuse.
"""

import pytest
from Kathara.manager.Kathara import Kathara

from kathara_api.config import get_settings

pytestmark = pytest.mark.docker

SHELL_TOKEN = "integration-shell-token"
LAB = {
    "name": "apitest-privileged",
    "machines": [
        {"name": "pc1", "image": "kathara/base", "privileged": True},
        {"name": "pc2", "image": "kathara/base"},
    ],
}


@pytest.fixture
def lab_id(client, monkeypatch):
    """The id of a fresh, undeployed lab with one privileged device, the shell token configured."""
    monkeypatch.setattr(get_settings(), "shell_token", SHELL_TOKEN)
    for leftover in client.get("/api/labs").json():
        if leftover["name"] == LAB["name"]:
            client.request("DELETE", f"/api/labs/{leftover['id']}")
    created = client.post("/api/labs", json=LAB)
    assert created.status_code == 201, created.text
    yield created.json()["id"]
    client.request("DELETE", f"/api/labs/{created.json()['id']}")


def _grant(client, lab_id):
    return client.post(f"/api/labs/{lab_id}/deploy-grant", headers={"X-Kathara-Shell-Token": SHELL_TOKEN})


def test_a_privileged_device_needs_the_shells_grant(client, lab_id):
    refused = client.post(f"/api/labs/{lab_id}/deploy", json={})

    assert refused.status_code == 403
    assert refused.json()["error_type"] == "DeployNotAuthorizedError"
    assert client.post(f"/api/labs/{lab_id}/deploy-grant").status_code == 403


def test_with_a_grant_the_device_runs_privileged_and_the_plain_one_does_not(client, lab_id):
    assert _grant(client, lab_id).status_code == 200

    resp = client.post(f"/api/labs/{lab_id}/deploy", json={})

    assert resp.status_code == 200, resp.text
    facade = Kathara.get_instance()
    privileged = {
        name: facade.get_machine_api_object(name, lab_hash=lab_id).attrs["HostConfig"]["Privileged"]
        for name in ("pc1", "pc2")
    }
    assert privileged == {"pc1": True, "pc2": False}


def test_a_grant_serves_one_deploy(client, lab_id):
    assert _grant(client, lab_id).status_code == 200
    assert client.post(f"/api/labs/{lab_id}/deploy", json={"selected_machines": ["pc1"]}).status_code == 200
    assert client.post(f"/api/labs/{lab_id}/undeploy", json={}).status_code == 200

    again = client.post(f"/api/labs/{lab_id}/deploy", json={})

    assert again.status_code == 403
    assert again.json()["error_type"] == "DeployNotAuthorizedError"
