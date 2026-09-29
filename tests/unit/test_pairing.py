"""The pairing proof (routers/pairing.py): how the desktop shell tells its own backend apart from
another process on the port, without sending it the token."""

import hashlib
import hmac

import pytest
from fastapi.testclient import TestClient

import kathara_api.config as config
from kathara_api.main import create_app

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
