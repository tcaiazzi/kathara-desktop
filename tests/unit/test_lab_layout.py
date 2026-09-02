"""Unit tests for the fixed topology layout (``lab.layout``) — no Docker required.

Covers the LabStore read/write/delete primitives, the service's forgiving handling of a
broken layout file, the fact that a layout file is inert for the lab.conf/folder importer,
and that it round-trips through the lab .zip.
"""

import json
import zipfile

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.schemas.lab import LabCreate, LabLayout
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate
from kathara_api.services import lab_import
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LAYOUT_FILENAME, LabStore
from tests.helpers import FakeFacadeBase

LAYOUT = {"version": 1, "nodes": {"dev:pc1": {"x": 240, "y": 130}, "cd:A": {"x": 380.5, "y": 210}}}


def _service(store: LabStore) -> KatharaService:
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()
    return service


def _lab_with_pc1(service: KatharaService, name: str = "mylab") -> None:
    service.create_lab(
        LabCreate(
            name=name,
            machines=[MachineCreate(name="pc1", image="kathara/base", interfaces=[InterfaceAttach(link="A", number=0)])],
        )
    )


# -- LabStore primitives -------------------------------------------------------


def test_write_read_layout_round_trip(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("mylab")
    path = store.write_layout("mylab", LAYOUT)
    assert path.name == LAYOUT_FILENAME
    assert store.read_layout("mylab") == LAYOUT
    # No staging file left behind by the atomic write.
    assert not (store.lab_dir("mylab") / f".{LAYOUT_FILENAME}.tmp").exists()


def test_write_layout_overwrites_previous(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("mylab")
    store.write_layout("mylab", LAYOUT)
    store.write_layout("mylab", {"version": 1, "nodes": {"dev:pc1": {"x": 1, "y": 2}}})
    assert store.read_layout("mylab") == {"version": 1, "nodes": {"dev:pc1": {"x": 1, "y": 2}}}


def test_read_layout_absent_returns_none(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("mylab")
    assert store.read_layout("mylab") is None


@pytest.mark.parametrize("content", ["{not json", "[1, 2]", ""])
def test_read_layout_broken_file_returns_none(tmp_path, content):
    """A hand-edited/truncated layout must degrade to "no layout", never raise."""
    store = LabStore(tmp_path / "labs")
    lab_dir = store.ensure_lab_dir("mylab")
    (lab_dir / LAYOUT_FILENAME).write_text(content, encoding="utf-8")
    assert store.read_layout("mylab") is None


def test_write_layout_unknown_lab_raises(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.write_layout("nope", LAYOUT)


def test_read_layout_unknown_lab_raises(tmp_path):
    """Distinct from `test_read_layout_absent_returns_none`: a lab with no layout file returns
    None, but a lab that doesn't exist at all must 404 like every other per-lab operation — not
    read-layout's own "no layout" case, which write_layout already gets right."""
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.read_layout("nope")


def test_delete_layout_unknown_lab_raises(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.delete_layout("nope")


def test_delete_layout_reports_whether_it_existed(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("mylab")
    assert store.delete_layout("mylab") is False
    store.write_layout("mylab", LAYOUT)
    assert store.delete_layout("mylab") is True
    assert not store.layout_path("mylab").exists()


# -- service layer -------------------------------------------------------------


def test_service_layout_round_trip(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _lab_with_pc1(service)
    assert service.get_lab_layout("mylab").nodes == {}
    service.save_lab_layout("mylab", LabLayout.model_validate(LAYOUT))
    layout = service.get_lab_layout("mylab")
    assert layout.version == 1
    assert layout.nodes["dev:pc1"].x == 240
    assert layout.nodes["cd:A"].y == 210


def test_service_ignores_invalid_layout_content(tmp_path):
    """Well-formed JSON that doesn't match the schema (bad node id) is ignored, not a 500."""
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _lab_with_pc1(service)
    store.write_layout("mylab", {"version": 1, "nodes": {"pc1": {"x": 1, "y": 2}}})
    assert service.get_lab_layout("mylab").nodes == {}


def test_clear_lab_layout(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _lab_with_pc1(service)
    service.save_lab_layout("mylab", LabLayout.model_validate(LAYOUT))
    assert service.clear_lab_layout("mylab") is True
    assert service.clear_lab_layout("mylab") is False
    assert service.get_lab_layout("mylab").nodes == {}


# -- interaction with the rest of the lab directory ----------------------------


def test_layout_file_is_inert_for_the_importer():
    """A root lab.layout must not become a machine or a warning/error."""
    conf = 'pc1[image]="kathara/base"\npc1[0]="A"\n'
    layout_text = json.dumps(LAYOUT)

    with_conf = lab_import.translate_lab_files({"lab.conf": conf, LAYOUT_FILENAME: layout_text}, "mylab")
    assert not with_conf.errors
    assert not with_conf.warnings
    assert {m.name for m in with_conf.payload.machines} == {"pc1"}

    # Folder-fallback path (no lab.conf): machines come from subfolders, so a root file is ignored.
    folder = lab_import.translate_lab_files({"pc1/etc/motd": "hi\n", LAYOUT_FILENAME: layout_text}, "mylab")
    assert not folder.errors
    assert {m.name for m in folder.payload.machines} == {"pc1"}


def test_layout_survives_reload_and_zip_round_trip(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _lab_with_pc1(service)
    service.save_lab_layout("mylab", LabLayout.model_validate(LAYOUT))

    # A restart re-parses the lab directory; the extra file must not disturb it, and the layout stays.
    fresh = _service(LabStore(tmp_path / "labs"))
    assert fresh.registry.get("mylab") is not None
    assert fresh.get_lab_layout("mylab").nodes["dev:pc1"].x == 240

    buf = service.export_lab_zip("mylab")
    with zipfile.ZipFile(buf) as archive:
        assert LAYOUT_FILENAME in archive.namelist()
        assert json.loads(archive.read(LAYOUT_FILENAME))["nodes"]["cd:A"]["x"] == 380.5


# -- routes --------------------------------------------------------------------


def test_layout_routes(client, tmp_path, monkeypatch):
    from kathara_api import dependencies

    store = LabStore(tmp_path / "labs")
    service = _service(store)
    monkeypatch.setattr(dependencies, "_service", service)
    _lab_with_pc1(service, "routelab")

    assert client.get("/api/labs/routelab/layout").json() == {"version": 1, "nodes": {}}

    saved = client.put("/api/labs/routelab/layout", json=LAYOUT)
    assert saved.status_code == 200
    assert client.get("/api/labs/routelab/layout").json() == {
        "version": 1,
        "nodes": {"dev:pc1": {"x": 240.0, "y": 130.0}, "cd:A": {"x": 380.5, "y": 210.0}},
    }
    assert store.layout_path("routelab").is_file()

    bad = client.put("/api/labs/routelab/layout", json={"nodes": {"pc1": {"x": 0, "y": 0}}})
    assert bad.status_code == 422  # FastAPI body validation (invalid node id)

    assert client.delete("/api/labs/routelab/layout").status_code == 200
    assert not store.layout_path("routelab").exists()
    assert client.delete("/api/labs/routelab/layout").status_code == 200  # idempotent

    assert client.put("/api/labs/unknown_lab/layout", json=LAYOUT).status_code == 404
    # All three verbs on the same resource must agree about whether the lab needs to exist —
    # GET/DELETE used to treat "no layout" and "no lab" as the same thing (a silent 200), unlike
    # PUT above and every other per-lab endpoint.
    assert client.get("/api/labs/unknown_lab/layout").status_code == 404
    assert client.delete("/api/labs/unknown_lab/layout").status_code == 404
