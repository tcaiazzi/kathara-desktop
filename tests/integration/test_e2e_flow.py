"""End-to-end integration test. Requires a running Docker daemon.

Run with: ``pytest -m docker``
"""

import base64

import pytest
from Kathara.manager.Kathara import Kathara
from Kathara.parser.netkit.LabParser import LabParser

pytestmark = pytest.mark.docker

LAB = {
    "name": "apitest",
    "machines": [
        {"name": "pc1", "image": "kathara/base", "interfaces": [{"link": "a", "number": 0}]},
        {"name": "pc2", "image": "kathara/base", "interfaces": [{"link": "a", "number": 0}]},
    ],
}


@pytest.fixture(scope="module")
def deployed_lab(client):
    """The id of the deployed test lab."""
    # Clean up any leftover lab from a previous failed run.
    for leftover in client.get("/api/labs").json():
        if leftover["name"] == LAB["name"]:
            client.request("DELETE", f"/api/labs/{leftover['id']}")

    created = client.post("/api/labs", json=LAB)
    assert created.status_code == 201
    lab_id = created.json()["id"]
    resp = client.post(f"/api/labs/{lab_id}/deploy")
    assert resp.status_code == 200, resp.text
    yield lab_id
    client.request("DELETE", f"/api/labs/{lab_id}")


def test_system_endpoints(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    info = client.get("/api/system").json()
    assert info["manager"]
    assert "docker" in info["available_managers"]


def test_deploy_lists_machines(client, deployed_lab):
    machines = client.get(f"/api/labs/{deployed_lab}").json()["machines"]
    names = {m["name"] for m in machines}
    assert names == {"pc1", "pc2"}
    assert all(m["running"] for m in machines)


def test_the_cli_sees_the_deployed_lab_as_its_own(client, deployed_lab):
    """`kathara lstart`/`linfo`/`lclean` in the lab's directory hash that directory the way
    `LabParser.parse` does, so they must find exactly the containers this app deployed."""
    path = client.get(f"/api/labs/{deployed_lab}/location").json()["path"]
    cli_hash = LabParser.parse(path).hash

    assert cli_hash == deployed_lab
    containers = Kathara.get_instance().get_machines_api_objects(lab_hash=cli_hash)
    assert sorted(c.labels["name"] for c in containers) == ["pc1", "pc2"]


def test_live_tty_websocket_smoke(client, deployed_lab):
    """End-to-end smoke test for the live-TTY bridge (routers/exec.py:tty_live_ws) against a real
    container: a real astart/aread/awrite/aresize/aclose round trip over the dedicated TTY
    executor (see docs/DESIGN-NOTES.md) must behave like any other session.
    """
    with client.websocket_connect(f"/api/labs/{deployed_lab}/machines/pc1/tty/ws") as ws:
        assert ws.receive_json() == {"event": "ready"}
        ws.send_json({"type": "resize", "cols": 100, "rows": 30})
        ws.send_json({"type": "input", "data": "echo tty_smoke_marker\n"})

        collected = ""
        for _ in range(200):
            msg = ws.receive_json()
            if msg["event"] != "output":
                continue
            collected += base64.b64decode(msg["data"]).decode(errors="replace")
            if "tty_smoke_marker" in collected:
                break
        assert "tty_smoke_marker" in collected

        ws.send_json({"type": "close"})
        assert ws.receive_json() == {"event": "closed"}


def test_unknown_lab_404(client):
    assert client.get("/api/labs/does_not_exist_xyz").status_code == 404


def test_duplicate_lab_409(client, deployed_lab):
    assert client.post("/api/labs", json=LAB).status_code == 409
