"""Unit tests for renaming a lab (no Docker required).

A lab's name *is* its directory name, so a rename must move the directory with everything in it
(lab.conf verbatim, device folders, lab.layout) and re-key the registry — while being refused
outright for a deployed lab, whose containers/networks are named after the old name.
"""

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.errors import LabAlreadyRegisteredError, LabRenameLockedError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase

LAB_CONF = (
    "# keep me\n"
    'LAB_NAME="original-name"\n'
    "\n"
    'pc1[image]="kathara/base"\n'
    'pc1[0]="A"   # trailing comment\n'
    "pc2[0]=A\n"
)


def _service(store: LabStore) -> KatharaService:
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()
    return service


def _make_lab(store: LabStore, service: KatharaService, name: str = "mylab") -> None:
    store.write_lab(
        name,
        {
            "lab.conf": LAB_CONF,
            "pc1.startup": "ip addr\n",
            "pc1/etc/motd": "hello\n",
            "lab.layout": '{"version": 1, "nodes": {"dev:pc1": {"x": 10, "y": 20}}}\n',
        },
    )
    service._reload_lab_from_disk(name)


# -- store ---------------------------------------------------------------------


def test_store_rename_moves_the_whole_directory(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("old", {"lab.conf": LAB_CONF, "pc1/etc/motd": "hello\n", "lab.layout": "{}\n"})

    target = store.rename_lab("old", "new")

    assert target == store.lab_dir("new")
    assert not store.lab_dir("old").exists()
    assert (target / "lab.conf").read_text() == LAB_CONF
    assert (target / "pc1" / "etc" / "motd").read_text() == "hello\n"
    assert (target / "lab.layout").exists()
    assert store.lab_names() == ["new"]


def test_store_rename_to_same_name_is_a_noop(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("same", {"lab.conf": LAB_CONF})

    assert store.rename_lab("same", "same") == store.lab_dir("same")
    assert (store.lab_dir("same") / "lab.conf").read_text() == LAB_CONF


def test_store_rename_refuses_existing_target(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("a", {"lab.conf": LAB_CONF})
    store.write_lab("b", {"lab.conf": "pc9[image]=kathara/base\n"})

    with pytest.raises(LabAlreadyRegisteredError):
        store.rename_lab("a", "b")
    assert (store.lab_dir("b") / "lab.conf").read_text() == "pc9[image]=kathara/base\n"


def test_store_rename_rejects_unsafe_and_missing(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("ok", {"lab.conf": LAB_CONF})

    from kathara_api.errors import ApiError

    with pytest.raises(ApiError):
        store.rename_lab("ok", "../escape")
    with pytest.raises(LabNotFoundError):
        store.rename_lab("ghost", "whatever")


# -- service -------------------------------------------------------------------


def test_service_rename_rekeys_registry_and_keeps_content(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _make_lab(store, service)

    renamed = service.rename_lab("mylab", "renamed")

    assert renamed.name == "renamed"
    assert sorted(renamed.machines) == ["pc1", "pc2"]
    assert service.registry.get("mylab") is None
    assert service.registry.get("renamed") is renamed
    # lab.conf travels verbatim — it is never regenerated, LAB_NAME included.
    assert service.read_lab_conf("renamed").content == LAB_CONF
    # The rebuilt Lab is re-anchored on the new directory.
    assert renamed.fs_path().rstrip("/") == str(store.lab_dir("renamed"))
    # Pending state (the startup script on disk) is re-read under the new key.
    assert service.get_pending("renamed")["pc1"].startup == "ip addr\n"
    assert service.get_pending("mylab") == {}


def test_service_rename_keeps_the_layout(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _make_lab(store, service)

    service.rename_lab("mylab", "renamed")

    assert service.get_lab_layout("renamed").nodes["dev:pc1"].x == 10


def test_service_rename_refuses_while_deployed(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _make_lab(store, service)
    service.registry.get("mylab").machines["pc1"].api_object = object()

    with pytest.raises(LabRenameLockedError):
        service.rename_lab("mylab", "renamed")

    assert store.lab_dir("mylab").is_dir()
    assert not store.lab_dir("renamed").exists()
    assert service.registry.get("mylab") is not None


def test_service_rename_refuses_existing_name(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    _make_lab(store, service, "mylab")
    service.create_lab(
        LabCreate(
            name="taken",
            machines=[MachineCreate(name="pc9", image="kathara/base", interfaces=[InterfaceAttach(link="B", number=0)])],
        )
    )

    with pytest.raises(LabAlreadyRegisteredError):
        service.rename_lab("mylab", "taken")

    assert store.lab_dir("mylab").is_dir()
    assert sorted(service.registry.get("taken").machines) == ["pc9"]


def test_service_rename_unknown_lab(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)

    with pytest.raises(LabNotFoundError):
        service.rename_lab("ghost", "whatever")


# -- route ---------------------------------------------------------------------


def test_rename_route(client, tmp_path, monkeypatch):
    from kathara_api import dependencies

    store = LabStore(tmp_path / "labs")
    service = _service(store)
    monkeypatch.setattr(dependencies, "_service", service)
    _make_lab(store, service, "routelab")

    resp = client.post("/api/labs/routelab/rename", json={"name": "routelab2"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "routelab2"

    assert client.get("/api/labs/routelab").status_code == 404
    detail = client.get("/api/labs/routelab2")
    assert detail.status_code == 200
    assert sorted(m["name"] for m in detail.json()["machines"]) == ["pc1", "pc2"]
    assert client.get("/api/labs/routelab2/lab-conf").json()["content"] == LAB_CONF

    # Invalid name -> 400 (ApiError from sanitize_lab_name), unknown lab -> 404.
    assert client.post("/api/labs/routelab2/rename", json={"name": "not valid/name"}).status_code == 400
    assert client.post("/api/labs/ghost/rename", json={"name": "x"}).status_code == 404


def test_rename_route_conflicts_while_deployed(client, tmp_path, monkeypatch):
    from kathara_api import dependencies

    store = LabStore(tmp_path / "labs")
    service = _service(store)
    monkeypatch.setattr(dependencies, "_service", service)
    _make_lab(store, service, "uplab")
    service.registry.get("uplab").machines["pc1"].api_object = object()

    resp = client.post("/api/labs/uplab/rename", json={"name": "downlab"})
    assert resp.status_code == 409
    assert resp.json()["error_type"] == "LabRenameLockedError"
