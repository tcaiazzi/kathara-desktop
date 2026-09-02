"""Unit tests for the host-filesystem browser (`GET /api/system/browse`) — no Docker required.

Backs the volume host-path picker: lists a real directory on the host machine itself, not a
lab's or a device's.
"""

from pathlib import Path

from kathara_api.services.kathara_service import KatharaService


def _service() -> KatharaService:
    return KatharaService()


def test_browse_host_directory_lists_entries(tmp_path):
    (tmp_path / "a.txt").write_text("hi\n")
    (tmp_path / "sub").mkdir()

    resolved_path, entries = _service().browse_host_directory(str(tmp_path))

    assert resolved_path == str(tmp_path)
    assert {e.name for e in entries} == {"a.txt", "sub"}


def test_browse_host_directory_reports_the_expanded_path_for_a_tilde_path(monkeypatch, tmp_path):
    """The response `path` must be the directory actually listed, not a re-derivation via a
    guest-path helper with no notion of a home directory — `~/x` used to come back as the
    nonexistent `/~/x`, silently pointing any breadcrumb/"up" navigation built from it at the
    wrong place, even though the *entries* themselves were always correctly listed from the real,
    expanded directory."""
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / "Documents").mkdir()
    (tmp_path / "Documents" / "notes.txt").write_text("hi\n")

    resolved_path, entries = _service().browse_host_directory("~/Documents")

    assert resolved_path == str(Path.home() / "Documents")
    assert not resolved_path.startswith("/~")
    assert {e.name for e in entries} == {"notes.txt"}


def test_browse_host_route_reports_the_resolved_path(client, monkeypatch, tmp_path):
    from kathara_api import dependencies

    monkeypatch.setattr(dependencies, "_service", _service())

    resp = client.get("/api/system/browse", params={"path": str(tmp_path)})

    assert resp.status_code == 200
    assert resp.json()["path"] == str(tmp_path)
