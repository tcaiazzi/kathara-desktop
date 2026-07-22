"""End-to-end integration test. Requires a running Docker daemon.

Run with: ``pytest -m docker``
"""

import base64
import json

import pytest

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
    # Clean up any leftover lab from a previous failed run.
    client.request("DELETE", "/api/labs/apitest")

    assert client.post("/api/labs", json=LAB).status_code == 201
    resp = client.post("/api/labs/apitest/deploy")
    assert resp.status_code == 200, resp.text
    yield
    client.request("DELETE", "/api/labs/apitest")


def test_system_endpoints(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    info = client.get("/api/system").json()
    assert info["manager"]
    assert "docker" in info["available_managers"]


def test_deploy_lists_machines(client, deployed_lab):
    machines = client.get("/api/labs/apitest/machines").json()
    names = {m["name"] for m in machines}
    assert names == {"pc1", "pc2"}
    assert all(m["running"] for m in machines)


def test_exec_command(client, deployed_lab):
    resp = client.post(
        "/api/labs/apitest/machines/pc1/exec",
        json={"command": "hostname"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["exit_code"] == 0
    assert "pc1" in body["stdout"]


def test_exec_stream(client, deployed_lab):
    with client.stream(
        "POST",
        "/api/labs/apitest/machines/pc1/exec/stream",
        json={"command": ["echo", "streamed"]},
    ) as resp:
        assert resp.status_code == 200
        collected = ""
        exit_code = None
        for line in resp.iter_lines():
            if line.startswith("data:"):
                payload = json.loads(line[len("data:"):].strip())
                if "data" in payload:
                    collected += base64.b64decode(payload["data"]).decode()
                elif "exit_code" in payload:
                    exit_code = payload["exit_code"]
        assert "streamed" in collected
        assert exit_code == 0


def test_stats_snapshot(client, deployed_lab):
    stats = client.get("/api/labs/apitest/stats").json()
    assert len(stats) == 2
    assert all(s["name"] in {"pc1", "pc2"} for s in stats)


def test_unknown_lab_404(client):
    assert client.get("/api/labs/does_not_exist_xyz/machines").status_code == 404


def test_duplicate_lab_409(client, deployed_lab):
    assert client.post("/api/labs", json=LAB).status_code == 409
