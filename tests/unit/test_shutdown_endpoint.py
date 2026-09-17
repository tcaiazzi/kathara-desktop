"""Unit test for POST /system/shutdown (no Docker required).

See docs/audit_2.md minor reperti: the SIGTERM used to be sent inline, before the response body
was handed to ASGI for writing, racing the response against the process's own shutdown. It is now
sent from a `BackgroundTask`, which Starlette only runs after the response has been sent.
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
