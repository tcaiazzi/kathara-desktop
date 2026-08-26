"""Unit tests for the ``lab.conf`` read/write endpoints (no Docker required).

The point of ``GET /labs/{lab}/lab-conf`` is that it returns exactly the bytes on disk — never a
regenerated approximation — so the editor can show (and, on save, faithfully round-trip) the same
file an import/upload wrote. See services/kathara_service.read_lab_conf.
"""

from Kathara.exceptions import LabNotFoundError

from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase

HOSTILE_CONF = (
    "# a leading comment\n"
    'LAB_NAME="original-name"\n'
    "LAB_DESCRIPTION='single quoted description'\n"
    'MY_CUSTOM_META="keep me"\n'
    "\n"
    "pc1[num_terms]=2\n"
    "pc1[image]='kathara/base'\n"
    "pc1[volume]=/host/data|/mnt/data|rw\n"
    'pc1[0]="A"   # trailing comment\n'
)


def _service(store: LabStore) -> KatharaService:
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()
    return service


def test_read_lab_conf_is_byte_identical(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    store.write_lab("mylab", {"lab.conf": HOSTILE_CONF})

    view = service.read_lab_conf("mylab")

    assert view.exists is True
    assert view.content == HOSTILE_CONF


def test_read_lab_conf_absent(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    service.create_lab(
        LabCreate(
            name="folderlab",
            machines=[MachineCreate(name="pc1", image="kathara/base", interfaces=[InterfaceAttach(link="A", number=0)])],
        )
    )
    (store.lab_dir("folderlab") / "lab.conf").unlink()

    view = service.read_lab_conf("folderlab")

    assert view.exists is False
    assert view.content == ""


def test_read_lab_conf_unknown_lab_raises(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    try:
        service.read_lab_conf("unknown_lab")
        assert False, "expected LabNotFoundError"
    except LabNotFoundError:
        pass


def test_read_lab_conf_rejects_oversized(tmp_path):
    from kathara_api.services import lab_store as lab_store_module

    store = LabStore(tmp_path / "labs")
    service = _service(store)
    store.write_lab("biglab", {"lab.conf": "pc1[image]=kathara/base\n"})
    (store.lab_dir("biglab") / "lab.conf").write_bytes(b"x" * (lab_store_module.MAX_LAB_CONF_BYTES + 1))

    view = service.read_lab_conf("biglab")
    assert view.exists is False


def test_read_lab_conf_rejects_non_utf8(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    store.write_lab("binlab", {"lab.conf": "pc1[image]=kathara/base\n"})
    (store.lab_dir("binlab") / "lab.conf").write_bytes(b"\xff\xfe\x00bad")

    view = service.read_lab_conf("binlab")
    assert view.exists is False


# -- routes --------------------------------------------------------------------


def test_lab_conf_routes(client, tmp_path, monkeypatch):
    from kathara_api import dependencies
    from kathara_api.services import lab_builder

    store = LabStore(tmp_path / "labs")
    service = _service(store)
    monkeypatch.setattr(dependencies, "_service", service)
    store.write_lab("routelab", {"lab.conf": HOSTILE_CONF})
    service.registry.add_if_absent(
        lab_builder.build_lab(LabCreate(name="routelab"), path=str(store.lab_dir("routelab")))
    )

    resp = client.get("/api/labs/routelab/lab-conf")
    assert resp.status_code == 200
    assert resp.json() == {"content": HOSTILE_CONF, "exists": True}

    edited = 'pc1[image]="kathara/base"\npc1[0]=A\n'
    put_resp = client.put("/api/labs/routelab/lab-conf", json={"content": edited})
    assert put_resp.status_code == 200

    resp2 = client.get("/api/labs/routelab/lab-conf")
    assert resp2.json() == {"content": edited, "exists": True}

    assert client.get("/api/labs/unknown_lab/lab-conf").status_code == 404
