"""End-to-end integration test. Requires a running Docker daemon.

Run with: ``pytest -m docker``
"""

import base64

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
    machines = client.get("/api/labs/apitest").json()["machines"]
    names = {m["name"] for m in machines}
    assert names == {"pc1", "pc2"}
    assert all(m["running"] for m in machines)


def test_live_tty_websocket_smoke(client, deployed_lab):
    """End-to-end smoke test for the live-TTY bridge (routers/exec.py:tty_live_ws) against a real
    container, after moving its session I/O onto a dedicated executor (see I4 in docs/audit_2.md):
    a real astart/aread/awrite/aresize/aclose round trip must still behave exactly as before.
    """
    with client.websocket_connect("/api/labs/apitest/machines/pc1/tty/ws") as ws:
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
