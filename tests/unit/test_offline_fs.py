"""Unit tests for the offline lab filesystem (the Lab Configuration tab's backing store) — real
on-disk reads/writes/deletes/moves against a lab's own directory, no Docker required.

No separate "pending" cache exists to test here: a write lands on disk in the same call, so
there's nothing that can drift or be lost on an undeploy/rename model rebuild. The regression
tests below (``test_undeploy_does_not_lose_*``/``test_rename_does_not_lose_*``) exist specifically
because an earlier design *did* keep such a cache, and it did exactly that.
"""

import pytest

from kathara_api.errors import ApiError, PathNotFoundError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


def _service(tmp_path) -> tuple[KatharaService, LabStore]:
    store = LabStore(tmp_path / "labs")
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()
    return service, store


def _two_machine_lab(tmp_path, lab_name="testlab"):
    service, store = _service(tmp_path)
    service.create_lab(
        LabCreate(name=lab_name, machines=[MachineCreate(name="pc1"), MachineCreate(name="pc2")])
    )
    return service, store


# -- device-owned files/dirs ----------------------------------------------------------------


def test_write_and_read_device_file(tmp_path):
    service, store = _two_machine_lab(tmp_path)

    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"
    assert service.fs_read_text_offline("testlab", "/pc1/etc/motd") == "hi\n"


def test_mkdir_device_dir(tmp_path):
    service, store = _two_machine_lab(tmp_path)

    service.fs_mkdir_offline("testlab", "/pc1/etc/frr")

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "frr").is_dir()


def test_delete_device_file(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_delete_offline("testlab", "/pc1/etc/motd")

    assert not (store.lab_dir("testlab") / "pc1" / "etc" / "motd").exists()
    with pytest.raises(PathNotFoundError):
        service.fs_read_text_offline("testlab", "/pc1/etc/motd")


def test_delete_device_root_removes_the_folder_entirely(tmp_path):
    """Deleting a device's tree-root node removes the folder like a normal directory delete —
    it stops existing (on disk and in listings) until something is written under this device
    again, matching a real filesystem instead of leaving a permanent empty shell behind."""
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")
    service.fs_write_text_offline("testlab", "/pc1/root.txt", "hi\n")

    service.fs_delete_offline("testlab", "/pc1", recursive=True)

    assert not (store.lab_dir("testlab") / "pc1").exists()
    assert "pc1" not in {e.name for e in service.fs_list_offline("testlab", "/")}

    # Writing under it again recreates it from scratch.
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi again\n")
    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi again\n"


def test_delete_never_touched_device_root_is_a_noop_not_an_error(tmp_path):
    """A device with nothing ever written to it doesn't even appear in a listing — deleting it
    anyway (e.g. a stale UI selection) must still be a no-op, not a 404."""
    service, _store = _two_machine_lab(tmp_path)

    service.fs_delete_offline("testlab", "/pc1", recursive=True)  # must not raise

    assert "pc1" not in {e.name for e in service.fs_list_offline("testlab", "/")}


def test_move_file_same_device(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_move_offline("testlab", "/pc1/etc/motd", "/pc1/etc/motd2")

    assert not (store.lab_dir("testlab") / "pc1" / "etc" / "motd").exists()
    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd2").read_text() == "hi\n"


def test_move_file_cross_device(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_move_offline("testlab", "/pc1/etc/motd", "/pc2/etc/motd")

    assert not (store.lab_dir("testlab") / "pc1" / "etc" / "motd").exists()
    assert (store.lab_dir("testlab") / "pc2" / "etc" / "motd").read_text() == "hi\n"


def test_move_dir_cross_device_recursive(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/frr/frr.conf", "hostname pc1\n")

    service.fs_move_offline("testlab", "/pc1/etc/frr", "/pc2/etc/frr2")

    assert not (store.lab_dir("testlab") / "pc1" / "etc" / "frr").exists()
    assert (store.lab_dir("testlab") / "pc2" / "etc" / "frr2" / "frr.conf").read_text() == "hostname pc1\n"


def test_moving_a_file_out_of_a_folder_leaves_the_folder_in_place(tmp_path):
    """Regression: dragging a file out of a folder must not also remove the folder."""
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/ciao/ciao.txt", "hi\n")

    service.fs_move_offline("testlab", "/pc1/ciao/ciao.txt", "/pc1/ciao.txt")

    assert (store.lab_dir("testlab") / "pc1" / "ciao").is_dir()  # the folder survives
    assert (store.lab_dir("testlab") / "pc1" / "ciao.txt").read_text() == "hi\n"


# -- root-level (device-less) files/dirs -----------------------------------------------------


def test_write_and_read_root_file(tmp_path):
    service, store = _two_machine_lab(tmp_path)

    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")

    assert (store.lab_dir("testlab") / "notes.txt").read_text() == "hi\n"
    assert service.fs_read_text_offline("testlab", "/notes.txt") == "hi\n"


def test_mkdir_root_dir(tmp_path):
    service, store = _two_machine_lab(tmp_path)

    service.fs_mkdir_offline("testlab", "/scratch")

    assert (store.lab_dir("testlab") / "scratch").is_dir()


def test_move_root_file_into_root_dir_keeps_the_dir(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/ciao.txt", "hi\n")
    service.fs_mkdir_offline("testlab", "/ciao")

    service.fs_move_offline("testlab", "/ciao.txt", "/ciao/ciao.txt")

    assert (store.lab_dir("testlab") / "ciao").is_dir()
    assert (store.lab_dir("testlab") / "ciao" / "ciao.txt").read_text() == "hi\n"
    assert not (store.lab_dir("testlab") / "ciao.txt").exists()


def test_move_file_from_device_to_root(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_move_offline("testlab", "/pc1/etc/motd", "/motd")

    assert not (store.lab_dir("testlab") / "pc1" / "etc" / "motd").exists()
    assert (store.lab_dir("testlab") / "motd").read_text() == "hi\n"


def test_move_file_from_root_to_device(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/motd", "hi\n")

    service.fs_move_offline("testlab", "/motd", "/pc1/etc/motd")

    assert not (store.lab_dir("testlab") / "motd").exists()
    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"


# -- <machine>.startup: just a real file at the lab root, no special-casing needed ------------


def test_startup_file_is_a_plain_root_file(tmp_path):
    service, store = _two_machine_lab(tmp_path)

    service.fs_write_text_offline("testlab", "/pc1.startup", "ip a\n")

    assert (store.lab_dir("testlab") / "pc1.startup").read_text() == "ip a\n"
    assert service.get_startup_scripts("testlab")["pc1"] == "ip a\n"


def test_moving_startup_file_between_devices_updates_get_startup_scripts(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1.startup", "ip a\n")

    service.fs_move_offline("testlab", "/pc1.startup", "/pc2.startup")

    scripts = service.get_startup_scripts("testlab")
    assert scripts["pc1"] == ""
    assert scripts["pc2"] == "ip a\n"


# -- listing ------------------------------------------------------------------------------------


def test_fs_list_offline_root_is_a_real_listing_no_synthesized_devices(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    names = {e.name for e in service.fs_list_offline("testlab", "/")}

    # pc1 has real content, so it shows; pc2 has never been written to, so it doesn't.
    assert names == {"lab.conf", "pc1", "notes.txt"}


def test_fs_list_offline_empty_device_is_an_empty_list_not_an_error(tmp_path):
    service, _store = _two_machine_lab(tmp_path)

    assert service.fs_list_offline("testlab", "/pc1") == []


def test_fs_list_offline_missing_path_raises_not_found(tmp_path):
    service, _store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    with pytest.raises(PathNotFoundError):
        service.fs_list_offline("testlab", "/pc1/nonexistent")


def test_fs_write_text_offline_routes_lab_conf_through_update_lab_conf(tmp_path):
    """lab.conf has real side effects (topology rebuild) a generic write must not bypass."""
    service, store = _two_machine_lab(tmp_path)

    service.fs_write_text_offline("testlab", "/lab.conf", 'pc3[image]="kathara/base"\n')

    lab = service.registry.get("testlab")
    assert "pc3" in lab.machines


def test_fs_delete_offline_rejects_lab_conf(tmp_path):
    service, _store = _two_machine_lab(tmp_path)
    with pytest.raises(ApiError):
        service.fs_delete_offline("testlab", "/lab.conf")


# -- regression: deploy/undeploy/rename must never lose queued content ------------------------


def test_undeploy_does_not_lose_root_or_device_content(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    service.fs_mkdir_offline("testlab", "/scratch")
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.deploy_lab("testlab")
    service.undeploy_lab("testlab")

    names = {e.name for e in service.fs_list_offline("testlab", "/")}
    assert {"notes.txt", "scratch", "pc1"} <= names
    assert service.fs_read_text_offline("testlab", "/pc1/etc/motd") == "hi\n"


def test_rename_does_not_lose_root_or_device_content(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.rename_lab("testlab", "renamed")

    names = {e.name for e in service.fs_list_offline("renamed", "/")}
    assert {"notes.txt", "pc1"} <= names
    assert service.fs_read_text_offline("renamed", "/pc1/etc/motd") == "hi\n"
