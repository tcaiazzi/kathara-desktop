"""Unit tests for the offline lab filesystem (the Lab Configuration tab's backing store) — real
on-disk reads/writes/deletes/moves against a lab's own directory, no Docker required.

No separate "pending" cache exists to test here: a write lands on disk in the same call, so
there's nothing that can drift or be lost on an undeploy/rename model rebuild. The regression
tests below (``test_undeploy_does_not_lose_*``/``test_rename_does_not_lose_*``) exist specifically
because an earlier design *did* keep such a cache, and it did exactly that.
"""

import fs.errors
import pytest

from kathara_api.errors import ApiError, LabConfLockedError, PathNotFoundError
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


def test_delete_device_root_honours_recursive_false(tmp_path):
    """`recursive` must mean the same thing everywhere in this endpoint — a non-empty device root
    is refused without it, exactly like any other non-empty directory (see the `/pc1/etc` control
    case below), not force-deleted regardless of the flag."""
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    with pytest.raises(ApiError):
        service.fs_delete_offline("testlab", "/pc1", recursive=False)

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"

    # Control: the generic (non-device-root) branch already enforces this — confirms both
    # branches agree, not just that the device-root one now raises for some other reason.
    with pytest.raises(ApiError):
        service.fs_delete_offline("testlab", "/pc1/etc", recursive=False)


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


# -- copy: like move, but the source always survives ----------------------------------------


def test_copy_file_same_device(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_copy_offline("testlab", "/pc1/etc/motd", "/pc1/etc/motd2")

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"
    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd2").read_text() == "hi\n"


def test_copy_file_cross_device(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_copy_offline("testlab", "/pc1/etc/motd", "/pc2/etc/motd")

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"
    assert (store.lab_dir("testlab") / "pc2" / "etc" / "motd").read_text() == "hi\n"


def test_copy_dir_cross_device_recursive(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/frr/frr.conf", "hostname pc1\n")

    service.fs_copy_offline("testlab", "/pc1/etc/frr", "/pc2/etc/frr2")

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "frr" / "frr.conf").read_text() == "hostname pc1\n"
    assert (store.lab_dir("testlab") / "pc2" / "etc" / "frr2" / "frr.conf").read_text() == "hostname pc1\n"


def test_copy_does_not_remove_source(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_copy_offline("testlab", "/pc1/etc/motd", "/pc1/etc/motd2")

    assert service.fs_read_text_offline("testlab", "/pc1/etc/motd") == "hi\n"


def test_fs_copy_offline_rejects_copying_over_lab_conf(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")

    with pytest.raises(ApiError):
        service.fs_copy_offline("testlab", "/notes.txt", "/lab.conf")

    assert (store.lab_dir("testlab") / "lab.conf").read_text() != "hi\n"


def test_fs_copy_offline_allows_copying_lab_conf_as_source(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    original = service.fs_read_text_offline("testlab", "/lab.conf")

    service.fs_copy_offline("testlab", "/lab.conf", "/lab.conf.bak")

    assert (store.lab_dir("testlab") / "lab.conf.bak").read_text() == original
    assert service.fs_read_text_offline("testlab", "/lab.conf") == original


def test_copy_root_file_into_root_dir_keeps_the_dir(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/ciao.txt", "hi\n")
    service.fs_mkdir_offline("testlab", "/ciao")

    service.fs_copy_offline("testlab", "/ciao.txt", "/ciao/ciao.txt")

    assert (store.lab_dir("testlab") / "ciao").is_dir()
    assert (store.lab_dir("testlab") / "ciao" / "ciao.txt").read_text() == "hi\n"
    assert (store.lab_dir("testlab") / "ciao.txt").read_text() == "hi\n"


def test_copy_file_from_device_to_root(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    service.fs_copy_offline("testlab", "/pc1/etc/motd", "/motd")

    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"
    assert (store.lab_dir("testlab") / "motd").read_text() == "hi\n"


def test_copy_file_from_root_to_device(tmp_path):
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/motd", "hi\n")

    service.fs_copy_offline("testlab", "/motd", "/pc1/etc/motd")

    assert (store.lab_dir("testlab") / "motd").read_text() == "hi\n"
    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"


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


def test_fs_list_offline_back_reference_path_raises_illegal_back_reference(tmp_path):
    """A path that tries to climb above the lab root is refused by pyfilesystem2 itself (OSFS
    never reads/writes outside its own root, regardless of this) — this only checks *which*
    exception surfaces, since `errors.py` maps it to a clean 400 (see test_error_mapping.py's
    `test_illegal_back_reference_maps_to_400_not_500`) instead of an unhandled 500."""
    service, _store = _two_machine_lab(tmp_path)

    with pytest.raises(fs.errors.IllegalBackReference):
        service.fs_list_offline("testlab", "../../../etc")


# Every spelling that resolves to the lab's own lab.conf. The guards used to compare the raw
# string (`path.strip("/") == "lab.conf"`), so only the first four were recognised — "./lab.conf"
# and friends fell through to the generic write path, which overwrote lab.conf with unvalidated
# text, skipped the 409-while-deployed gate and left the registry on the previous model.
LAB_CONF_SPELLINGS = [
    "lab.conf",
    "/lab.conf",
    "//lab.conf",
    "lab.conf/",
    "./lab.conf",
    ".//lab.conf",
    "/./lab.conf",
    "pc1/../lab.conf",
    "  ./lab.conf  ",
]


@pytest.mark.parametrize("path", LAB_CONF_SPELLINGS)
def test_writing_lab_conf_is_validated_whatever_the_spelling(tmp_path, path):
    """Unparseable content must be refused, and lab.conf left byte-for-byte intact — the generic
    write path does no parsing at all, so reaching it is what made this corrupting."""
    service, store = _two_machine_lab(tmp_path)
    before = (store.lab_dir("testlab") / "lab.conf").read_text()

    with pytest.raises(ApiError):
        service.fs_write_text_offline("testlab", path, "GARBAGE\n")

    assert (store.lab_dir("testlab") / "lab.conf").read_text() == before


@pytest.mark.parametrize("path", LAB_CONF_SPELLINGS)
def test_writing_lab_conf_rebuilds_the_model_whatever_the_spelling(tmp_path, path):
    """A *valid* edit must go through update_lab_conf, i.e. actually rebuild the topology — the
    bypass wrote the file but left the registry holding the old machines."""
    service, _store = _two_machine_lab(tmp_path)

    service.fs_write_text_offline("testlab", path, 'pc3[image]="kathara/base"\n')

    assert set(service.registry.get("testlab").machines) == {"pc3"}


@pytest.mark.parametrize("path", LAB_CONF_SPELLINGS)
def test_writing_lab_conf_while_deployed_is_refused_whatever_the_spelling(tmp_path, path):
    service, store = _two_machine_lab(tmp_path)
    before = (store.lab_dir("testlab") / "lab.conf").read_text()
    service.deploy_lab("testlab")
    # `FakeFacadeBase.deploy_lab` is a no-op, so it leaves `api_object` unset — and that attribute
    # is exactly what the 409 gate reads (`any(m.api_object is not None ...)`). Set it by hand so
    # the lab really looks deployed to the code under test.
    for machine in service.get_lab_or_reconstruct("testlab").machines.values():
        machine.api_object = object()

    with pytest.raises(LabConfLockedError):
        service.fs_write_text_offline("testlab", path, 'pc3[image]="kathara/base"\n')

    assert (store.lab_dir("testlab") / "lab.conf").read_text() == before


@pytest.mark.parametrize("path", LAB_CONF_SPELLINGS)
def test_deleting_lab_conf_is_refused_whatever_the_spelling(tmp_path, path):
    service, store = _two_machine_lab(tmp_path)

    with pytest.raises(ApiError):
        service.fs_delete_offline("testlab", path)

    assert (store.lab_dir("testlab") / "lab.conf").exists()


@pytest.mark.parametrize("path", LAB_CONF_SPELLINGS)
def test_moving_lab_conf_is_refused_whatever_the_spelling(tmp_path, path):
    """fs_move_offline's guard had no test at all before this."""
    service, store = _two_machine_lab(tmp_path)

    with pytest.raises(ApiError):
        service.fs_move_offline("testlab", path, "/moved.conf")
    with pytest.raises(ApiError):
        service.fs_move_offline("testlab", "/notes.txt", path)

    assert (store.lab_dir("testlab") / "lab.conf").exists()


@pytest.mark.parametrize("path", LAB_CONF_SPELLINGS)
def test_uploading_over_lab_conf_is_routed_through_update_lab_conf(tmp_path, path):
    """`fs_upload_bytes_offline` had *no* lab.conf guard whatsoever — not even for the literal
    path — so it wrote raw bytes over lab.conf with no validation, no 409 and no rebuild. Being
    bytes, it could also leave the file non-UTF-8, which nothing downstream can parse."""
    service, store = _two_machine_lab(tmp_path)
    before = (store.lab_dir("testlab") / "lab.conf").read_bytes()

    with pytest.raises(ApiError):
        service.fs_upload_bytes_offline("testlab", path, b"\x00\xffnot utf-8\n")

    assert (store.lab_dir("testlab") / "lab.conf").read_bytes() == before

    # A valid edit still works through this entry point, and rebuilds the model.
    service.fs_upload_bytes_offline("testlab", path, b'pc3[image]="kathara/base"\n')
    assert set(service.registry.get("testlab").machines) == {"pc3"}


@pytest.mark.parametrize("path", ["/", "", "//", "/.", "./", "/./"])
def test_fs_move_and_copy_offline_reject_the_lab_root(tmp_path, path):
    """The lab-root guard existed only in fs_delete_offline; moving the root away or copying over
    it is just as destructive."""
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")

    with pytest.raises(ApiError):
        service.fs_move_offline("testlab", path, "/elsewhere")
    with pytest.raises(ApiError):
        service.fs_copy_offline("testlab", "/notes.txt", path)

    assert (store.lab_dir("testlab") / "lab.conf").exists()
    assert (store.lab_dir("testlab") / "notes.txt").read_text() == "hi\n"


def test_a_non_canonical_device_path_still_marks_the_device_dirty(tmp_path):
    """`_dirty_target_for` splits on "/" too, so "./pc1/etc/motd" used to mark nothing dirty and
    the write would never be live-pushed on the next deploy."""
    service, _store = _two_machine_lab(tmp_path)

    service.fs_write_text_offline("testlab", "./pc1/etc/motd", "hi\n")

    assert service.registry.pop_dirty_machines("testlab", {"pc1", "pc2"}) == {"pc1"}


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


@pytest.mark.parametrize("path", ["/", "", "//", "///", "/.", "/./"])
@pytest.mark.parametrize("recursive", [False, True])
def test_fs_delete_offline_rejects_the_lab_root(tmp_path, path, recursive):
    """Every spelling that pyfilesystem resolves to the lab's own root directory must be
    rejected, not just the literal "/" — "/.", "//" and friends all `removetree` the same
    directory once they reach `target_fs`, so the guard has to compare normalized paths."""
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    service.fs_write_text_offline("testlab", "/pc1/etc/motd", "hi\n")

    with pytest.raises(ApiError):
        service.fs_delete_offline("testlab", path, recursive=recursive)

    # The lab must be completely untouched — this is the regression a permissive guard misses.
    assert (store.lab_dir("testlab") / "lab.conf").exists()
    assert (store.lab_dir("testlab") / "notes.txt").read_text() == "hi\n"
    assert (store.lab_dir("testlab") / "pc1" / "etc" / "motd").read_text() == "hi\n"


def test_fs_delete_offline_still_allows_deleting_a_root_level_file_or_dir(tmp_path):
    """The new lab-root guard must not overreach: root-level entries other than the root itself
    stay deletable, same as before."""
    service, store = _two_machine_lab(tmp_path)
    service.fs_write_text_offline("testlab", "/notes.txt", "hi\n")
    service.fs_mkdir_offline("testlab", "/scratch")

    service.fs_delete_offline("testlab", "/notes.txt")
    service.fs_delete_offline("testlab", "/scratch", recursive=True)

    assert not (store.lab_dir("testlab") / "notes.txt").exists()
    assert not (store.lab_dir("testlab") / "scratch").exists()
    assert (store.lab_dir("testlab") / "lab.conf").exists()


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
