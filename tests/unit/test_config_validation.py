"""Validation of the settings that get interpolated into URLs, and the CORS wildcard rule.

Both exist to stop a mis-set (or hostile) environment variable from widening what the backend
does: `gallery_repo` was already validated for this reason — `gallery_ref`/`gallery_section`
reach the same URLs and now are too.
"""

import pytest
from fastapi.testclient import TestClient

from kathara_api.config import ApiSettings
from kathara_api.main import create_app


# -- gallery ref -----------------------------------------------------------------------------

@pytest.mark.parametrize("ref", ["main", "v1.2.3", "feature/foo", "0" * 40])
def test_gallery_ref_accepts_plain_refs(ref):
    assert ApiSettings(gallery_ref=ref).gallery_ref_value() == ref


@pytest.mark.parametrize("ref", ["../../other/repo", "..", "main/../../x", "-x", "", "a b"])
def test_gallery_ref_rejects_traversal_and_junk(ref):
    # `quote()` treats "/" as safe and never escapes ".", so these would survive into the URL.
    with pytest.raises(ValueError):
        ApiSettings(gallery_ref=ref).gallery_ref_value()


# -- gallery section -------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("section", "expected"),
    [("main-labs", "main-labs"), ("/main-labs/", "main-labs"), ("a/b", "a/b"), ("", ""), ("v1.0/labs", "v1.0/labs")],
)
def test_gallery_section_normalizes(section, expected):
    assert ApiSettings(gallery_section=section).gallery_section_path() == expected


@pytest.mark.parametrize("section", ["../secrets", "main-labs/../../x", "labs/../x", ".", "..", "a b"])
def test_gallery_section_rejects_traversal(section):
    # A ".." here would point the catalog outside the subtree gallery_section exists to bound.
    with pytest.raises(ValueError):
        ApiSettings(gallery_section=section).gallery_section_path()


# -- CORS ------------------------------------------------------------------------------------

def _cors_headers(monkeypatch, origins):
    """Response CORS headers for a cross-origin GET, with KATHARA_API_CORS_ORIGINS set."""
    import kathara_api.config as config

    monkeypatch.setattr(config, "_settings", None)
    monkeypatch.setenv("KATHARA_API_CORS_ORIGINS", origins)
    client = TestClient(create_app())
    res = client.get("/api/health", headers={"Origin": "https://evil.example"})
    return (
        res.headers.get("access-control-allow-origin"),
        res.headers.get("access-control-allow-credentials"),
    )


def test_cors_wildcard_does_not_grant_credentials(monkeypatch):
    """The spec forbids `*` together with credentials, and Starlette's fallback is to echo the
    caller's own Origin — which would let any website make credentialed calls to this API."""
    allow_origin, allow_credentials = _cors_headers(monkeypatch, "*")
    assert allow_origin == "*"
    assert allow_credentials is None


def test_cors_unlisted_origin_is_refused(monkeypatch):
    allow_origin, _ = _cors_headers(monkeypatch, "http://localhost:5173")
    assert allow_origin is None


def test_cors_empty_default_refuses_every_origin(monkeypatch):
    allow_origin, _ = _cors_headers(monkeypatch, "")
    assert allow_origin is None
