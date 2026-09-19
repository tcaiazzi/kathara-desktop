"""Unit test for POST /system/shutdown (no Docker required).

The SIGTERM is sent from a `BackgroundTask`, which Starlette runs only after the response has
been sent. Sending it inline, before the response body reaches ASGI for writing, races the
response against the process's own shutdown.
"""

import os
import signal

from fastapi.testclient import TestClient

from kathara_api.main import create_app


def test_shutdown_responds_and_sends_sigterm_via_background_task(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(os, "kill", lambda *args: calls.append(args))

    client = TestClient(create_app())
    resp = client.post("/api/system/shutdown")

    assert resp.status_code == 200
    assert resp.json()["detail"] == "Shutting down."
    assert calls == [(os.getpid(), signal.SIGTERM)]
