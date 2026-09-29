"""The pairing proof (routers/pairing.py) and the stdin launcher of the elevated backend
(stdin_secrets.py): the two ways the desktop shell keeps its tokens from reaching anyone else."""

import hashlib
import hmac
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import kathara_api.config as config
from kathara_api.main import create_app
from kathara_api.stdin_secrets import SECRET_KEYS, read_secrets

NONCE = "ab" * 16


@pytest.fixture
def token(monkeypatch):
    monkeypatch.setenv("KATHARA_API_AUTH_TOKEN", "pairing-secret")
    monkeypatch.setattr(config, "_settings", None)
    yield "pairing-secret"
    monkeypatch.setattr(config, "_settings", None)


def test_the_proof_is_an_hmac_of_the_nonce_and_needs_no_token(token):
    res = TestClient(create_app()).get("/api/pairing/proof", params={"nonce": NONCE})

    assert res.status_code == 200
    assert res.json() == {"proof": hmac.new(token.encode(), NONCE.encode(), hashlib.sha256).hexdigest()}


@pytest.mark.parametrize("nonce", ["", "short", "zz" * 16, "ab" * 65])
def test_a_malformed_nonce_is_refused(token, nonce):
    assert TestClient(create_app()).get("/api/pairing/proof", params={"nonce": nonce}).status_code == 422


def test_without_a_token_there_is_nothing_to_prove(monkeypatch):
    monkeypatch.delenv("KATHARA_API_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(config, "_settings", None)
    try:
        res = TestClient(create_app()).get("/api/pairing/proof", params={"nonce": NONCE})
    finally:
        monkeypatch.setattr(config, "_settings", None)
    assert res.json() == {"proof": None}


# -- stdin launcher ----------------------------------------------------------------------------


def test_read_secrets_takes_both_keys_and_skips_everything_else():
    """The sudo password comes first when a NOPASSWD rule means sudo never read it."""
    lines = ["the-password\n", "KATHARA_API_AUTH_TOKEN=a\n", "OTHER=x\n", "KATHARA_API_SHELL_TOKEN=b\n", "late=1\n"]

    assert read_secrets(iter(lines)) == {"KATHARA_API_AUTH_TOKEN": "a", "KATHARA_API_SHELL_TOKEN": "b"}


def test_read_secrets_stops_once_both_are_found():
    consumed = []

    def lines():
        for line in ["KATHARA_API_AUTH_TOKEN=a\n", "KATHARA_API_SHELL_TOKEN=b\n", "never read\n"]:
            consumed.append(line)
            yield line

    read_secrets(lines())
    assert consumed[-1] == "KATHARA_API_SHELL_TOKEN=b\n"


def test_the_launcher_refuses_to_start_without_both_secrets():
    """An elevated backend with no token would answer anyone on loopback."""
    result = subprocess.run(
        [sys.executable, "-m", "kathara_api.stdin_secrets", "--version"],
        input="KATHARA_API_AUTH_TOKEN=a\n",
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode != 0
    assert SECRET_KEYS[1] in result.stderr


def test_the_launcher_hands_the_remaining_arguments_to_uvicorn():
    result = subprocess.run(
        [sys.executable, "-m", "kathara_api.stdin_secrets", "--version"],
        input="KATHARA_API_AUTH_TOKEN=a\nKATHARA_API_SHELL_TOKEN=b\n",
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode == 0, result.stderr
    assert "uvicorn" in result.stdout.lower()


def _is_gone(pid: int) -> bool:
    """Exited: no process, or a zombie nobody has reaped yet."""
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "Z"
    except FileNotFoundError:
        return True


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="PR_SET_PDEATHSIG is Linux-only")
def test_the_launcher_dies_with_its_parent_even_when_stopped():
    """The shell's last resort against a hung elevated backend is SIGKILL to sudo, which sudo cannot
    pass on; the backend must go with it — stopped or not — instead of staying up as root."""
    child_code = (
        "import sys, time; from kathara_api.stdin_secrets import die_with_parent; "
        "die_with_parent(); print('ready', flush=True); time.sleep(60)"
    )
    parent_code = (
        "import subprocess, sys, time; "
        f"p = subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
        "print(p.pid, flush=True); time.sleep(60)"
    )
    parent = subprocess.Popen([sys.executable, "-c", parent_code], stdout=subprocess.PIPE, text=True)
    try:
        child_pid = int(parent.stdout.readline())
        assert parent.stdout.readline().strip() == "ready"
        os.kill(child_pid, signal.SIGSTOP)

        parent.kill()
        parent.wait(timeout=10)

        deadline = time.monotonic() + 10
        while not _is_gone(child_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert _is_gone(child_pid)
    finally:
        parent.kill()
