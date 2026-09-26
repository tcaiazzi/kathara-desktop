"""Opening a folder from anywhere on the host as a lab, and closing it again (no Docker required).

An opened folder is used where it is: nothing is copied under the labs root, the lab's id is the
hash of the folder's own path, and the folder is remembered across restarts (``KnownLabs``). What
this API may then read and write is exactly that folder — so the route is the desktop shell's
alone, and a symbolic link inside the folder cannot carry the lab filesystem anywhere else.
"""

import os

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.config import get_settings
from kathara_api.errors import (
    ApiError,
    LabCloseRefusedError,
    LabDeleteRefusedError,
    NotALabError,
    PathNotFoundError,
)
from kathara_api.services import serializers
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.known_labs import KnownLabs
from kathara_api.services.lab_store import LabStore, lab_id_for
from kathara_api.services.lab_watch import LabWatcher
from tests.helpers import FakeFacadeBase

LAB_CONF = 'pc1[image]="kathara/base"\npc1[0]="A"\n'


class _RecordingFacade(FakeFacadeBase):
    def __init__(self):
        self.undeploy_calls: list[dict] = []

    def undeploy_lab(self, **kwargs):
        self.undeploy_calls.append(kwargs)


def _service(tmp_path, facade=None) -> KatharaService:
    """A service with its labs root and its state file both under ``tmp_path``."""
    service = KatharaService(
        store=LabStore(tmp_path / "root"), known=KnownLabs(tmp_path / "state" / "known_labs.json")
    )
    service._instance = facade or FakeFacadeBase()
    return service


def _folder(tmp_path, name="mylab", files=None):
    """A folder outside the labs root, populated from a ``{path: text}`` map."""
    folder = tmp_path / "elsewhere" / name
    folder.mkdir(parents=True)
    for rel, text in (files if files is not None else {"lab.conf": LAB_CONF}).items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text)
    return folder


# -- opening -----------------------------------------------------------------------------------


def test_an_opened_folder_is_used_in_place_under_the_id_of_its_path(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)

    lab, warnings = service.open_lab(str(folder))

    assert warnings == []
    assert lab.hash == lab_id_for(folder)
    assert lab.name == "mylab"
    assert sorted(lab.machines) == ["pc1"]
    assert service.store.lab_names() == []  # nothing was copied under the root
    assert service.lab_place(lab) == (folder, False)
    assert service.known.dirs() == [folder]


def test_opening_an_open_folder_again_returns_the_same_lab(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    other = _folder(tmp_path, "other")
    first, _ = service.open_lab(str(folder))
    service.open_lab(str(other))

    again, _ = service.open_lab(str(folder))

    assert again is first
    assert service.known.dirs() == [folder, other]  # most recently opened first


def test_a_path_through_a_symlink_opens_the_real_folder(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    link = tmp_path / "shortcut"
    link.symlink_to(folder, target_is_directory=True)

    lab, _ = service.open_lab(str(link))

    assert lab.hash == lab_id_for(folder)
    assert service.known.dirs() == [folder]


def test_opening_a_folder_under_the_root_returns_that_lab_without_remembering_it(tmp_path):
    service = _service(tmp_path)
    (service.store.root / "inside").mkdir(parents=True)
    (service.store.root / "inside" / "lab.conf").write_text(LAB_CONF)
    service._reload_from_disk()

    lab, _ = service.open_lab(str(service.store.root / "inside"))

    assert service.lab_place(lab).managed is True
    assert service.known.dirs() == []


@pytest.mark.parametrize("path", ["relative/lab", "lab"])
def test_a_relative_path_is_refused(tmp_path, path):
    with pytest.raises(ApiError, match="absolute path"):
        _service(tmp_path).open_lab(path)


def test_a_path_that_is_not_a_folder_is_not_found(tmp_path):
    service = _service(tmp_path)
    (tmp_path / "file.txt").write_text("x")

    with pytest.raises(PathNotFoundError):
        service.open_lab(str(tmp_path / "file.txt"))
    with pytest.raises(PathNotFoundError):
        service.open_lab(str(tmp_path / "missing"))


def test_the_filesystem_root_is_refused(tmp_path):
    with pytest.raises(ApiError, match="root of the filesystem"):
        _service(tmp_path).open_lab(os.path.abspath(os.sep))


def test_an_empty_folder_is_not_a_lab_until_initialized(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={})

    with pytest.raises(NotALabError):
        service.open_lab(str(folder))
    assert service.known.dirs() == []
    assert not (folder / "lab.conf").exists()

    lab, _ = service.open_lab(str(folder), init=True)

    assert (folder / "lab.conf").is_file()
    assert lab.machines == {}
    assert service.known.dirs() == [folder]


def test_init_leaves_an_existing_lab_conf_alone(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)

    service.open_lab(str(folder), init=True)

    assert (folder / "lab.conf").read_text() == LAB_CONF


def test_a_folder_based_lab_without_lab_conf_opens(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={"pc1/etc/motd": "hi\n", "pc1.startup": "ip a\n"})

    lab, _ = service.open_lab(str(folder))

    assert sorted(lab.machines) == ["pc1"]


def test_a_lab_conf_that_does_not_parse_is_an_error_not_a_non_lab(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={"lab.conf": "pc1[0]=A\npc1[2]=B\n"})

    with pytest.raises(ApiError) as caught:
        service.open_lab(str(folder))
    assert not isinstance(caught.value, NotALabError)
    assert service.known.dirs() == []


def test_a_folder_with_too_many_files_is_refused_before_it_is_read(tmp_path, monkeypatch):
    """Opening the wrong folder (a home directory, a source tree) must fail fast, not load it."""
    monkeypatch.setattr(get_settings(), "max_files_per_lab", 2)
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={"lab.conf": LAB_CONF, "a.txt": "a", "b.txt": "b"})
    monkeypatch.setattr(service.store, "read_lab", lambda *_: pytest.fail("the folder was read"))

    with pytest.raises(ApiError, match="more than 2 files"):
        service.open_lab(str(folder))


def test_a_folder_too_large_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_bytes_per_lab", 10)
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={"lab.conf": LAB_CONF})

    with pytest.raises(ApiError, match="more than"):
        service.open_lab(str(folder))


# -- across restarts ---------------------------------------------------------------------------


def test_opened_folders_are_loaded_again_after_a_restart(tmp_path):
    folder = _folder(tmp_path)
    _service(tmp_path).open_lab(str(folder))

    restarted = _service(tmp_path)

    assert restarted.registry.get(lab_id_for(folder)) is not None
    assert [lab.name for lab in restarted.list_labs()] == ["mylab"]


def test_a_missing_folder_stays_known_and_can_still_be_closed(tmp_path):
    folder = _folder(tmp_path)
    _service(tmp_path).open_lab(str(folder))
    for child in folder.iterdir():
        child.unlink()
    folder.rmdir()

    restarted = _service(tmp_path)

    assert restarted.list_labs() == []
    assert restarted.known.dirs() == [folder]
    restarted.close_lab(lab_id_for(folder))
    assert restarted.known.dirs() == []


# -- closing, deleting, renaming ---------------------------------------------------------------


def test_closing_undeploys_and_forgets_the_lab_but_keeps_its_folder(tmp_path):
    facade = _RecordingFacade()
    service = _service(tmp_path, facade)
    folder = _folder(tmp_path)
    lab, _ = service.open_lab(str(folder))

    service.close_lab(lab.hash)

    assert facade.undeploy_calls == [{"lab_hash": lab.hash}]
    assert service.registry.get(lab.hash) is None
    assert service.known.dirs() == []
    assert (folder / "lab.conf").read_text() == LAB_CONF
    with pytest.raises(LabNotFoundError):
        service.close_lab(lab.hash)


def test_a_lab_under_the_root_cannot_be_closed(tmp_path):
    service = _service(tmp_path)
    (service.store.root / "inside").mkdir(parents=True)
    (service.store.root / "inside" / "lab.conf").write_text(LAB_CONF)
    service._reload_from_disk()

    with pytest.raises(LabCloseRefusedError):
        service.close_lab(lab_id_for(service.store.root / "inside"))


def test_an_opened_folder_cannot_be_deleted(tmp_path):
    facade = _RecordingFacade()
    service = _service(tmp_path, facade)
    folder = _folder(tmp_path)
    lab, _ = service.open_lab(str(folder))

    with pytest.raises(LabDeleteRefusedError):
        service.delete_lab(lab.hash)

    assert (folder / "lab.conf").is_file()
    assert facade.undeploy_calls == []  # refused before anything was stopped
    assert service.registry.get(lab.hash) is lab


def test_renaming_an_opened_folder_renames_it_in_place_and_remembers_the_new_path(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    other = _folder(tmp_path, "other")
    lab, _ = service.open_lab(str(folder))
    service.open_lab(str(other))

    renamed = service.rename_lab(lab.hash, "renamed")

    moved = folder.parent / "renamed"
    assert (moved / "lab.conf").read_text() == LAB_CONF
    assert renamed.hash == lab_id_for(moved)
    assert service.known.dirs() == [other, moved]  # kept its place in the list
    assert service.lab_place(renamed) == (moved, False)


def test_the_response_says_where_a_lab_lives(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    lab, _ = service.open_lab(str(folder))

    summary = serializers.lab_to_summary(lab, service.lab_place(lab))

    assert (summary.path, summary.managed) == (str(folder), False)


# -- symbolic links out of the lab -------------------------------------------------------------


@pytest.fixture
def linked_lab(tmp_path):
    """An opened lab whose folder holds a file and a directory symlinked to outside it."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret\n")
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    (folder / "pc1").mkdir()
    (folder / "pc1" / "leak.txt").symlink_to(outside / "secret.txt")
    (folder / "escape").symlink_to(outside, target_is_directory=True)
    (folder / "inside.txt").write_text("fine\n")
    (folder / "alias.txt").symlink_to(folder / "inside.txt")
    lab, _ = service.open_lab(str(folder))
    return service, lab, outside


@pytest.mark.parametrize("path", ["/pc1/leak.txt", "/escape/secret.txt"])
def test_a_symlink_out_of_the_lab_cannot_be_read(linked_lab, path):
    service, lab, _ = linked_lab

    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_read_text_offline(lab.hash, path)
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_read_bytes_offline(lab.hash, path)


def test_a_symlink_out_of_the_lab_cannot_be_written_listed_or_moved_through(linked_lab):
    service, lab, outside = linked_lab

    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_write_text_offline(lab.hash, "/escape/new.txt", "x")
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_upload_bytes_offline(lab.hash, "/escape/new.bin", b"x")
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_mkdir_offline(lab.hash, "/escape/dir")
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_list_offline(lab.hash, "/escape")
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_delete_offline(lab.hash, "/escape/secret.txt")
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_copy_offline(lab.hash, "/escape/secret.txt", "/stolen.txt")
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_move_offline(lab.hash, "/inside.txt", "/escape/moved.txt")
    assert sorted(p.name for p in outside.iterdir()) == ["secret.txt"]


def test_a_search_skips_files_reached_through_a_symlink_out_of_the_lab(linked_lab):
    service, lab, _ = linked_lab

    matches, _ = service.fs_search_offline(lab.hash, "/", "secret")

    assert matches == []


def test_a_symlink_that_stays_inside_the_lab_still_works(linked_lab):
    service, lab, _ = linked_lab

    assert service.fs_read_text_offline(lab.hash, "/alias.txt") == "fine\n"


def test_a_lab_conf_symlinked_out_of_the_lab_is_not_read(tmp_path):
    outside = tmp_path / "outside.conf"
    outside.write_text(LAB_CONF)
    folder = _folder(tmp_path, files={"pc1/etc/motd": "hi\n"})
    (folder / "lab.conf").symlink_to(outside)
    service = _service(tmp_path)

    lab, _ = service.open_lab(str(folder))

    assert service.read_lab_conf(lab.hash).exists is False


# -- the route ---------------------------------------------------------------------------------


@pytest.fixture
def api(tmp_path, monkeypatch, client):
    from kathara_api import dependencies

    service = _service(tmp_path)
    monkeypatch.setattr(dependencies, "_service", service)
    return client, service


def test_the_open_route_is_closed_when_no_shell_token_is_configured(api, tmp_path, monkeypatch):
    client, _ = api
    monkeypatch.setattr(get_settings(), "shell_token", None)

    resp = client.post("/api/labs/open", json={"path": str(_folder(tmp_path))}, headers={"X-Kathara-Shell-Token": "x"})

    assert resp.status_code == 403
    assert resp.json()["error_type"] == "ShellOnlyError"


@pytest.mark.parametrize("headers", [{}, {"X-Kathara-Shell-Token": "wrong"}])
def test_the_open_route_needs_the_shell_token(api, tmp_path, monkeypatch, headers):
    client, service = api
    monkeypatch.setattr(get_settings(), "shell_token", "shell-secret")

    resp = client.post("/api/labs/open", json={"path": str(_folder(tmp_path))}, headers=headers)

    assert resp.status_code == 403
    assert service.known.dirs() == []


def test_the_open_route_opens_the_folder_for_the_shell(api, tmp_path, monkeypatch):
    client, _ = api
    monkeypatch.setattr(get_settings(), "shell_token", "shell-secret")
    folder = _folder(tmp_path)

    resp = client.post(
        "/api/labs/open", json={"path": str(folder)}, headers={"X-Kathara-Shell-Token": "shell-secret"}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert (body["id"], body["path"], body["managed"]) == (lab_id_for(folder), str(folder), False)
    assert [lab["id"] for lab in client.get("/api/labs").json()] == [lab_id_for(folder)]


def test_the_open_route_reports_a_non_lab_as_such(api, tmp_path, monkeypatch):
    client, _ = api
    monkeypatch.setattr(get_settings(), "shell_token", "shell-secret")

    resp = client.post(
        "/api/labs/open",
        json={"path": str(_folder(tmp_path, files={}))},
        headers={"X-Kathara-Shell-Token": "shell-secret"},
    )

    assert resp.status_code == 422
    assert resp.json()["error_type"] == "NotALabError"


def test_the_close_route_closes_an_opened_lab(api, tmp_path):
    client, service = api
    lab, _ = service.open_lab(str(_folder(tmp_path)))

    assert client.post(f"/api/labs/{lab.hash}/close").status_code == 200
    assert client.get("/api/labs").json() == []


# -- symbolic links *inside* what an operation touches -----------------------------------------


@pytest.fixture
def nested_link_lab(tmp_path):
    """An opened lab with a directory, and a device folder, that each hold a link to a directory
    outside the lab — the shape a recursive delete, copy or move walks into."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "precious.txt").write_text("PRECIOUS\n")
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={"lab.conf": LAB_CONF + 'pc2[0]="A"\n', "docs/readme.txt": "hi\n"})
    (folder / "docs" / "ext").symlink_to(outside, target_is_directory=True)
    (folder / "pc2").mkdir()
    (folder / "pc2" / "ext").symlink_to(outside, target_is_directory=True)
    lab, _ = service.open_lab(str(folder))
    return service, lab, folder, outside


def test_a_recursive_delete_removes_a_nested_link_and_nothing_it_points_at(nested_link_lab):
    service, lab, folder, outside = nested_link_lab

    service.fs_delete_offline(lab.hash, "/docs", recursive=True)

    assert not (folder / "docs").exists()
    assert (outside / "precious.txt").read_text() == "PRECIOUS\n"


def test_removing_a_device_leaves_what_its_folder_links_to(nested_link_lab):
    service, lab, folder, outside = nested_link_lab

    service.remove_machine(lab.hash, "pc2")

    assert not (folder / "pc2").exists()
    assert (outside / "precious.txt").read_text() == "PRECIOUS\n"
    assert "pc2" not in (folder / "lab.conf").read_text()


@pytest.mark.parametrize("destination", ["/docs-moved", "/pc1/docs"], ids=["same device", "across devices"])
def test_moving_a_directory_moves_a_nested_link_as_a_link(nested_link_lab, destination):
    service, lab, folder, outside = nested_link_lab

    service.fs_move_offline(lab.hash, "/docs", destination)

    moved = folder / destination.lstrip("/")
    assert (moved / "ext").is_symlink()
    assert (moved / "readme.txt").read_text() == "hi\n"
    assert (outside / "precious.txt").read_text() == "PRECIOUS\n"


def test_copying_a_directory_copies_a_nested_link_as_a_link_that_stays_unreadable(nested_link_lab):
    service, lab, folder, _outside = nested_link_lab

    service.fs_copy_offline(lab.hash, "/docs", "/docs2")

    assert (folder / "docs2" / "ext").is_symlink()
    with pytest.raises(ApiError, match="outside the lab"):
        service.fs_read_text_offline(lab.hash, "/docs2/ext/precious.txt")


def test_the_zip_download_leaves_out_files_linked_from_outside_the_lab(nested_link_lab, tmp_path):
    import io
    import zipfile

    service, lab, folder, outside = nested_link_lab
    (folder / "notes.txt").symlink_to(outside / "precious.txt")

    _name, buf = service.export_lab_zip(lab.hash)

    names = zipfile.ZipFile(io.BytesIO(buf.getvalue())).namelist()
    assert "docs/readme.txt" in names
    assert not any("precious" in n or n == "notes.txt" for n in names)


def test_a_search_neither_loops_on_a_link_cycle_nor_walks_out_of_the_lab(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path, files={"lab.conf": LAB_CONF, "notes.txt": "needle\n"})
    (folder / "loop").symlink_to(folder, target_is_directory=True)
    (folder / "root").symlink_to(os.path.abspath(os.sep), target_is_directory=True)
    lab, _ = service.open_lab(str(folder))

    matches, _ = service.fs_search_offline(lab.hash, "/", "needle")

    assert [m.path for m in matches] == ["/notes.txt"]


def test_a_fifo_in_an_opened_folder_is_skipped_rather_than_read(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    os.mkfifo(folder / "pipe")

    lab, _ = service.open_lab(str(folder))
    _name, buf = service.export_lab_zip(lab.hash)

    assert sorted(lab.machines) == ["pc1"]
    assert buf.getvalue()


# -- identity edge cases -----------------------------------------------------------------------


def test_a_folder_whose_path_differs_only_in_non_ascii_characters_is_refused(tmp_path):
    """Kathara's hash drops non-ASCII characters, so the two would share an id — and containers."""
    service = _service(tmp_path)
    first = _folder(tmp_path, "lab_")
    second = _folder(tmp_path, "lab_é")
    assert lab_id_for(first) == lab_id_for(second)
    service.open_lab(str(first))

    with pytest.raises(ApiError, match="same identity"):
        service.open_lab(str(second))
    assert service.known.dirs() == [first]


def test_a_lab_under_the_root_that_is_a_symlink_is_still_the_roots(tmp_path):
    service = _service(tmp_path)
    real = _folder(tmp_path, "elsewhere-lab")
    service.store.root.mkdir(parents=True)
    (service.store.root / "linked").symlink_to(real, target_is_directory=True)
    service._reload_from_disk()
    lab_id = lab_id_for(service.store.root / "linked")

    lab, _ = service.open_lab(str(real))  # the same lab, reached by its real path

    assert lab.hash == lab_id
    assert service.lab_place(lab).managed is True
    assert service.known.dirs() == []
    with pytest.raises(LabCloseRefusedError):
        service.close_lab(lab_id)


def test_a_state_dir_that_cannot_be_written_does_not_stop_a_folder_opening(tmp_path, monkeypatch):
    service = _service(tmp_path)
    folder = _folder(tmp_path)

    def refuse(_directory):
        raise PermissionError("read-only")

    monkeypatch.setattr(service.known, "add", refuse)
    lab, _ = service.open_lab(str(folder))

    assert service.registry.get(lab.hash) is lab


# -- opened folders that are remembered but not loaded -----------------------------------------


def test_a_remembered_folder_that_is_missing_or_broken_is_listed_so_it_can_be_closed(api, tmp_path, monkeypatch):
    client, service = api
    missing = _folder(tmp_path, "gone")
    broken = _folder(tmp_path, "broken")
    service.open_lab(str(missing))
    service.open_lab(str(broken))
    (missing / "lab.conf").unlink()
    missing.rmdir()
    (broken / "lab.conf").write_text("pc1[0]=A\npc1[2]=B\n")
    from kathara_api import dependencies

    monkeypatch.setattr(dependencies, "_service", _service(tmp_path))  # a restart

    listed = {lab["name"]: lab for lab in client.get("/api/labs").json()}

    assert (listed["gone"]["problem"], listed["broken"]["problem"]) == ("missing", "unloadable")
    assert listed["gone"]["id"] == lab_id_for(missing)
    assert client.post(f"/api/labs/{listed['gone']['id']}/close").status_code == 200
    assert [lab["name"] for lab in client.get("/api/labs").json()] == ["broken"]


def test_a_broken_remembered_folder_loads_by_itself_once_its_lab_conf_is_fixed(tmp_path):
    folder = _folder(tmp_path)
    _service(tmp_path).open_lab(str(folder))
    (folder / "lab.conf").write_text("pc1[0]=A\npc1[2]=B\n")
    service = _service(tmp_path)
    lab_id = lab_id_for(folder)
    assert lab_id in service.watched_labs()
    published = []
    service.events.publish = published.append

    (folder / "lab.conf").write_text(LAB_CONF)
    service.handle_disk_change(lab_id, {"lab.conf"})

    assert service.registry.get(lab_id) is not None
    assert [e["kind"] for e in published] == ["conf-reloaded"]


def test_an_opened_folder_moved_away_is_listed_missing_and_loads_again_when_it_is_back(tmp_path):
    service = _service(tmp_path)
    folder = _folder(tmp_path)
    lab_id = service.open_lab(str(folder))[0].hash
    published = []
    service.events.publish = published.append
    watcher = LabWatcher(service.watched_labs, service.handle_disk_change)
    watcher.poll_once()

    moved = folder.with_name("moved")
    folder.rename(moved)
    watcher.poll_once()

    assert service.registry.get(lab_id) is None
    assert service.unloaded_opened_labs() == [(lab_id, folder, "missing")]
    assert [e["kind"] for e in published] == ["missing"]

    moved.rename(folder)
    watcher.poll_once()

    assert service.registry.get(lab_id) is not None
    assert [e["kind"] for e in published] == ["missing", "conf-reloaded"]


def test_a_leftover_temporary_file_does_not_block_saving_the_list(tmp_path):
    state = tmp_path / "state" / "known_labs.json"
    state.parent.mkdir()
    leftover = state.parent / ".known_labs.json.tmp"
    leftover.write_text("{}")
    leftover.chmod(0o400)
    known = KnownLabs(state)

    known.add(tmp_path / "a")

    assert KnownLabs(state).dirs() == [tmp_path / "a"]
