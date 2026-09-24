"""Validation of the settings that get interpolated into URLs, and the CORS wildcard rule.

Both exist to stop a mis-set (or hostile) environment variable from widening what the backend
does: `gallery_ref`/`gallery_section` reach the same URLs `gallery_repo` does, so all three are
validated the same way.
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


# -- gallery repo ----------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("repo", "expected"),
    [("KatharaFramework/Kathara-Labs", "KatharaFramework/Kathara-Labs"), (" /me/my.labs_v2/ ", "me/my.labs_v2")],
)
def test_gallery_repo_accepts_owner_slash_repo(repo, expected):
    assert ApiSettings(gallery_repo=repo).gallery_slug() == expected


@pytest.mark.parametrize(
    "repo", ["owner", "owner/repo/extra", "owner/repo?x=1", "owner/repo#frag", "own er/repo", "", "a/" + "b" * 101]
)
def test_gallery_repo_rejects_anything_but_a_single_owner_and_repo(repo):
    # Interpolated into the GitHub API and raw.githubusercontent URLs, so an extra segment or a
    # query string would point the fetcher at something other than a repository root.
    with pytest.raises(ValueError, match="must be `owner/repo`"):
        ApiSettings(gallery_repo=repo).gallery_slug()


# -- examples catalog and Kathara overrides --------------------------------------------------

def test_examples_dir_override_is_expanded_and_resolved(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert ApiSettings(examples_dir=" ~/course/../labs ").examples_dir_path() == tmp_path / "labs"


def test_examples_dir_defaults_to_the_bundled_catalog():
    path = ApiSettings(examples_dir="  ").examples_dir_path()
    assert path.name == "examples" and path.parent.name == "kathara_api"


def test_kathara_overrides_forward_only_the_settings_that_are_set():
    assert ApiSettings().kathara_overrides() == {}
    assert ApiSettings(manager_type="docker", default_image="kathara/frr").kathara_overrides() == {
        "manager_type": "docker",
        "image": "kathara/frr",
    }


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


# -- TTY session cap --------------------------------------------------------------------------

def test_tty_max_sessions_default():
    assert ApiSettings().tty_max_sessions == 32


def test_tty_max_sessions_env_override(monkeypatch):
    monkeypatch.setenv("KATHARA_API_TTY_MAX_SESSIONS", "4")
    assert ApiSettings().tty_max_sessions == 4
