"""Unit tests for POST /system/shutdown (no Docker required).

The SIGTERM is sent from a `BackgroundTask`, which Starlette runs only after the response has
been sent. Sending it inline, before the response body reaches ASGI for writing, races the
response against the process's own shutdown.
"""

import os
import signal
import threading

import pytest
from fastapi.testclient import TestClient

from kathara_api.main import create_app
from kathara_api.routers import system


class _FakeTimer:
    instances: list["_FakeTimer"] = []

    def __init__(self, interval, function, args=()):
        self.interval, self.function, self.args = interval, function, args
        self.daemon = False
        self.started = False
        _FakeTimer.instances.append(self)

    def start(self):
        self.started = True


def test_shutdown_responds_and_sends_sigterm_via_background_task(monkeypatch):
    calls: list[tuple] = []
    monkeypatch.setattr(os, "kill", lambda *args: calls.append(args))
    monkeypatch.setattr(threading, "Timer", _FakeTimer)

    client = TestClient(create_app())
    resp = client.post("/api/system/shutdown")

    assert resp.status_code == 200
    assert resp.json()["detail"] == "Shutting down."
    assert calls == [(os.getpid(), signal.SIGTERM)]


def test_shutdown_arms_a_daemon_hard_exit_backstop(monkeypatch):
    _FakeTimer.instances.clear()
    monkeypatch.setattr(os, "kill", lambda *args: None)
    monkeypatch.setattr(threading, "Timer", _FakeTimer)

    TestClient(create_app()).post("/api/system/shutdown")

    assert len(_FakeTimer.instances) == 1
    timer = _FakeTimer.instances[0]
    assert timer.started and timer.daemon
    assert timer.interval == system.SHUTDOWN_HARD_EXIT_S
    assert timer.function is os._exit and timer.args == (0,)


@pytest.mark.skipif(not hasattr(signal, "pthread_sigmask"), reason="no signal masks on this platform")
def test_create_app_unblocks_shutdown_signals():
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    try:
        create_app()
        blocked = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        assert signal.SIGTERM not in blocked
        assert signal.SIGINT not in blocked
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)
