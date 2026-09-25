"""Unit tests for the ``lab.conf`` read/write endpoints (no Docker required).

The point of ``GET /labs/{lab}/lab-conf`` is that it returns exactly the bytes on disk — never a
regenerated approximation — so the editor can show (and, on save, faithfully round-trip) the same
file an import/upload wrote. See services/kathara_service.read_lab_conf.
"""

from Kathara.exceptions import LabNotFoundError

from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate
from kathara_api.services.lab_store import LabStore
from tests.helpers import lab_id, make_service

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



def test_read_lab_conf_is_byte_identical(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    store.write_lab("mylab", {"lab.conf": HOSTILE_CONF})

    view = service.read_lab_conf(lab_id(service, "mylab"))

    assert view.exists is True
    assert view.content == HOSTILE_CONF


def test_read_lab_conf_absent(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    service.create_lab(
        LabCreate(
            name="folderlab",
            machines=[MachineCreate(name="pc1", image="kathara/base", interfaces=[InterfaceAttach(link="A", number=0)])],
        )
    )
    (store.lab_dir("folderlab") / "lab.conf").unlink()

    view = service.read_lab_conf(lab_id(service, "folderlab"))

    assert view.exists is False
    assert view.content == ""


def test_read_lab_conf_unknown_lab_raises(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    try:
        service.read_lab_conf(lab_id(service, "unknown_lab"))
        assert False, "expected LabNotFoundError"
    except LabNotFoundError:
        pass


def test_read_lab_conf_rejects_oversized(tmp_path):
    from kathara_api.services import lab_store as lab_store_module

    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    store.write_lab("biglab", {"lab.conf": "pc1[image]=kathara/base\n"})
    (store.lab_dir("biglab") / "lab.conf").write_bytes(b"x" * (lab_store_module.MAX_LAB_CONF_BYTES + 1))

    view = service.read_lab_conf(lab_id(service, "biglab"))
    assert view.exists is False


def test_read_lab_conf_rejects_non_utf8(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    store.write_lab("binlab", {"lab.conf": "pc1[image]=kathara/base\n"})
    (store.lab_dir("binlab") / "lab.conf").write_bytes(b"\xff\xfe\x00bad")

    view = service.read_lab_conf(lab_id(service, "binlab"))
    assert view.exists is False


# -- remove_link persistence ----------------------------------------------------


def test_remove_link_persists_interface_removal_to_lab_conf(tmp_path):
    """Removing a collision domain must reach disk, not just the in-memory model: leaving each
    attached (stopped) machine's interface line in lab.conf resurrects the domain and its
    interfaces on a full undeploy or a backend restart."""
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    conf = (
        'LAB_NAME="testlab"\n'
        "\n"
        'pc1[image]="kathara/base"\n'
        'pc1[0]="shared"\n'
        'pc1[1]="priv1"\n'
        'pc2[image]="kathara/base"\n'
        'pc2[0]="shared"\n'
    )
    store.write_lab("testlab", {"lab.conf": conf})
    service._reload_lab_from_disk(service.store.lab_dir("testlab"))

    service.remove_link(lab_id(service, "testlab"), "shared")

    on_disk = (store.lab_dir("testlab") / "lab.conf").read_text()
    assert 'pc1[0]="shared"' not in on_disk
    assert 'pc2[0]="shared"' not in on_disk
    # pc1's surviving interface (priv1) is renumbered down to fill the gap "shared" left, both on
    # disk and in the live model.
    assert 'pc1[0]="priv1"' in on_disk
    lab = service.registry.get(lab_id(service, "testlab"))
    assert "shared" not in lab.links
    assert lab.machines["pc2"].interfaces == {}
    assert lab.machines["pc1"].interfaces[0].link.name == "priv1"


# -- routes --------------------------------------------------------------------


def test_lab_conf_routes(client, tmp_path, monkeypatch):
    from kathara_api import dependencies
    from kathara_api.services import lab_builder

    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    monkeypatch.setattr(dependencies, "_service", service)
    store.write_lab("routelab", {"lab.conf": HOSTILE_CONF})
    service.registry.add_if_absent(
        lab_builder.build_lab(LabCreate(name="routelab"), path=str(store.lab_dir("routelab"))),
        store.lab_dir("routelab"),
    )

    resp = client.get(f"/api/labs/{lab_id(service, 'routelab')}/lab-conf")
    assert resp.status_code == 200
    assert resp.json() == {"content": HOSTILE_CONF, "exists": True}

    edited = 'pc1[image]="kathara/base"\npc1[0]=A\n'
    put_resp = client.put(f"/api/labs/{lab_id(service, 'routelab')}/lab-conf", json={"content": edited})
    assert put_resp.status_code == 200

    resp2 = client.get(f"/api/labs/{lab_id(service, 'routelab')}/lab-conf")
    assert resp2.json() == {"content": edited, "exists": True}

    assert client.get(f"/api/labs/{lab_id(service, 'unknown_lab')}/lab-conf").status_code == 404
