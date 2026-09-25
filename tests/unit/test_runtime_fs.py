"""KatharaService operations on a *running* device and on a running lab's collision domains.

Every runtime-filesystem method turns into a command exec'd in the device (or a copy into it),
so these tests use a facade that records each exec/copy and returns a scripted result. They
check the exact command each method runs (paths normalized, `--` before user paths, `shlex`
quoting where a shell is involved), how a non-zero exit becomes an error, and how `find`'s
output is parsed. The listing's symlink handling, the directory/binary read errors and the
startup-log polling are covered in test_kathara_service_errors.py.
"""

import pytest
from Kathara.exceptions import MachineNotRunningError

from kathara_api.errors import ApiError, NotSupportedError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services import lab_builder
from kathara_api.services.docker_tty import SHELL_PATHS
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, make_lab, make_service


class _RuntimeFacade(FakeFacadeBase):
    """Records execs, copies and deploys; every exec returns `result`."""

    def __init__(self):
        self.result: tuple = (b"", b"", 0)
        self.execs: list[tuple[str, object, str, bool]] = []
        self.copies: list[tuple[str, dict[str, bytes]]] = []
        self.deployed_links = []
        self.deployed_machines = []
        self.deploy_machine_error: Exception | None = None
        self.streams: list[bool] = []
        self.connects: list[tuple[str, str, object]] = []
        self.disconnects: list[tuple[str, str, object]] = []
        self.undeployed_machines: list[tuple[str, object]] = []

    def exec(self, machine_name, command, lab_name=None, wait=False, stream=False):
        self.execs.append((machine_name, command, lab_name, wait))
        self.streams.append(stream)
        return self.result

    def connect_machine_to_link(self, machine, link, mac_address=None):
        self.connects.append((machine.name, link.name, mac_address))

    def disconnect_machine_from_link(self, machine, link, keep_link=False):
        self.disconnects.append((machine.name, link.name, keep_link))

    def undeploy_machine(self, machine, keep_links=False):
        self.undeployed_machines.append((machine.name, keep_links))

    def copy_files(self, machine, guest_to_host):
        self.copies.append((machine.name, {path: data.read() for path, data in guest_to_host.items()}))

    def deploy_link(self, link):
        self.deployed_links.append(link)

    def deploy_machine(self, machine):
        if self.deploy_machine_error is not None:
            raise self.deploy_machine_error
        self.deployed_machines.append(machine.name)
        machine.api_object = object()

    def get_machine_api_object(self, machine_name, lab_name=None):
        return ("api-object", machine_name, lab_name)


@pytest.fixture
def facade():
    return _RuntimeFacade()


@pytest.fixture
def service(tmp_path, facade):
    """A service holding lab `l` (pc1 running, pc2 stopped, both on collision domain A)."""
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    lab = lab_builder.build_lab(
        LabCreate.model_validate(
            {"name": "l", "machines": [{"name": "pc1", "interfaces": [{"link": "A"}]},
                                       {"name": "pc2", "interfaces": [{"link": "A"}]}]}
        )
    )
    lab.machines["pc1"].api_object = object()
    service.registry.add(lab)
    return service


def _commands(facade):
    return [command for _, command, _, _ in facade.execs]


# ---------------------------------------------------------------------------
# Preconditions shared by every runtime method
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "call",
    [
        lambda s: s.fs_list_directory("l", "pc2", "/"),
        lambda s: s.fs_read_bytes("l", "pc2", "/etc/hosts"),
        lambda s: s.fs_write_text("l", "pc2", "/x", "y"),
        lambda s: s.fs_upload_bytes("l", "pc2", "/x", b"y"),
        lambda s: s.fs_mkdir("l", "pc2", "/d"),
        lambda s: s.fs_move("l", "pc2", "/a", "/b"),
        lambda s: s.fs_copy("l", "pc2", "/a", "/b"),
        lambda s: s.fs_delete("l", "pc2", "/a"),
        lambda s: s.get_machine_api_object("l", "pc2"),
    ],
)
def test_runtime_operations_on_a_stopped_device_fail_without_touching_it(service, facade, call):
    with pytest.raises(MachineNotRunningError):
        call(service)
    assert facade.execs == [] and facade.copies == []


@pytest.mark.parametrize(
    "raw, normalized",
    [("etc/hosts", "/etc/hosts"), ("  /etc//./hosts ", "/etc/hosts"), ("/a/../../b", "/b")],
)
def test_normalize_guest_path_makes_an_absolute_canonical_path(service, raw, normalized):
    assert service.normalize_guest_path(raw) == normalized


@pytest.mark.parametrize("raw", ["", "   "])
def test_normalize_guest_path_rejects_an_empty_path(service, raw):
    with pytest.raises(ApiError, match="Path cannot be empty"):
        service.normalize_guest_path(raw)


# ---------------------------------------------------------------------------
# Commands run in the device
# ---------------------------------------------------------------------------


def test_mkdir_creates_parents_at_the_normalized_path(service, facade):
    service.fs_mkdir("l", "pc1", "tmp/new//dir")

    assert facade.execs == [("pc1", ["mkdir", "-p", "/tmp/new/dir"], "l", False)]


def test_move_and_copy_separate_options_from_paths(service, facade):
    service.fs_move("l", "pc1", "/tmp/-a", "tmp/b")
    service.fs_copy("l", "pc1", "/tmp/-a", "tmp/c")

    assert _commands(facade) == [["mv", "--", "/tmp/-a", "/tmp/b"], ["cp", "-a", "--", "/tmp/-a", "/tmp/c"]]


def test_recursive_delete_uses_rm_rf(service, facade):
    service.fs_delete("l", "pc1", "/tmp/dir", recursive=True)

    assert _commands(facade) == [["rm", "-rf", "--", "/tmp/dir"]]


def test_non_recursive_delete_removes_a_file_or_an_empty_directory_with_quoting(service, facade):
    service.fs_delete("l", "pc1", "/tmp/it's here")

    quoted = "'/tmp/it'\"'\"'s here'"
    assert _commands(facade) == [["sh", "-lc", f"rm -f -- {quoted} || rmdir -- {quoted}"]]


@pytest.mark.parametrize(
    "call, message",
    [
        (lambda s: s.fs_mkdir("l", "pc1", "/d"), "Create directory `/d` failed on `pc1`: mkdir: denied"),
        (lambda s: s.fs_move("l", "pc1", "/a", "/b"), "Move `/a` failed on `pc1`: mkdir: denied"),
        (lambda s: s.fs_copy("l", "pc1", "/a", "/b"), "Copy `/a` failed on `pc1`: mkdir: denied"),
        (lambda s: s.fs_delete("l", "pc1", "/a"), "Delete `/a` failed on `pc1`: mkdir: denied"),
        (lambda s: s.fs_list_directory("l", "pc1", "/a"), "List directory `/a` failed on `pc1`: mkdir: denied"),
    ],
)
def test_a_failing_command_reports_the_action_and_its_stderr(service, facade, call, message):
    facade.result = (b"", b"mkdir: denied\n", 1)

    with pytest.raises(ApiError) as exc_info:
        call(service)
    assert exc_info.value.detail == message


def test_a_failing_command_without_stderr_reports_its_exit_code(service, facade):
    facade.result = (None, None, 2)

    with pytest.raises(ApiError, match=r"Create directory `/d` failed on `pc1`: exit code 2"):
        service.fs_mkdir("l", "pc1", "/d")


# ---------------------------------------------------------------------------
# fs_list_directory output parsing
# ---------------------------------------------------------------------------


def test_listing_skips_malformed_records_and_tolerates_unparseable_numbers(service, facade):
    facade.result = (
        b"\0"
        b"only\tthree\tfields\0"
        b"f\tf\t1\t644\t0\t\0"  # no name
        b"f\tf\tbig\t644\tsoon\tb.txt\0"
        b"f\tf\t12\t600\t1700000000.5\tA.txt\0",
        b"",
        0,
    )

    entries = service.fs_list_directory("l", "pc1", "/srv")

    assert [(e.name, e.path, e.is_dir, e.size, e.mode, e.mtime) for e in entries] == [
        ("A.txt", "/srv/A.txt", False, 12, "600", 1700000000.5),
        ("b.txt", "/srv/b.txt", False, None, "644", None),
    ]


def test_listing_sorts_directories_first_then_by_name_case_insensitively(service, facade):
    facade.result = (
        b"d\td\t4096\t755\t0\tzeta\0"
        b"f\tf\t1\t644\t0\tbeta\0"
        b"f\tf\t1\t644\t0\tAlpha\0"
        b"d\td\t4096\t755\t0\tOps\0",
        b"",
        0,
    )

    entries = service.fs_list_directory("l", "pc1", "/")

    assert [e.name for e in entries] == ["Ops", "zeta", "Alpha", "beta"]
    assert [e.path for e in entries] == ["/Ops", "/zeta", "/Alpha", "/beta"]


def test_listing_keeps_names_with_tabs_newlines_and_spaces_whole(service, facade):
    """Regression: with tab-separated fields and one entry per line, a tab in a name shifted every
    field after it (a folder `conf<TAB>bak` came out as a *file* named `conf`, which then failed
    to open), and a newline split one entry into two broken ones."""
    facade.result = (
        b"d\td\t4096\t755\t1700000001\tconf\tbak\0"
        b"f\tf\t0\t644\t1700000002\treport\t2026.txt\0"
        b"f\tf\t5\t600\t1700000003\ttwo\nlines\0"
        b"f\tf\t1\t644\t1700000004\t \0",
        b"",
        0,
    )

    entries = service.fs_list_directory("l", "pc1", "/root")

    assert [(e.name, e.path, e.is_dir, e.size, e.mode) for e in entries] == [
        ("conf\tbak", "/root/conf\tbak", True, 4096, "755"),
        (" ", "/root/ ", False, 1, "644"),
        ("report\t2026.txt", "/root/report\t2026.txt", False, 0, "644"),
        ("two\nlines", "/root/two\nlines", False, 5, "600"),
    ]


def test_listing_asks_find_for_nul_terminated_records_with_the_name_last(service, facade):
    service.fs_list_directory("l", "pc1", "/")

    [(_, [_, _, cmd], _, _)] = facade.execs
    assert cmd.endswith("-printf '%y\\t%Y\\t%s\\t%m\\t%T@\\t%f\\0'")


def test_listing_quotes_the_path_inside_the_find_command(service, facade):
    service.fs_list_directory("l", "pc1", "/tmp/a b")

    [(_, [shell, flag, cmd], _, wait)] = facade.execs
    assert (shell, flag, wait) == ("sh", "-lc", False)
    assert cmd.startswith("find -H '/tmp/a b' -mindepth 1 -maxdepth 1 -printf ")


# ---------------------------------------------------------------------------
# Reading and writing files
# ---------------------------------------------------------------------------


def test_read_bytes_returns_the_file_content(service, facade):
    facade.result = (b"\x00\x01", b"", 0)

    assert service.fs_read_bytes("l", "pc1", "bin/blob") == b"\x00\x01"
    [(_, [_, _, cmd], _, _)] = facade.execs
    assert cmd == f"[ -d /bin/blob ] && exit {KatharaService._FS_READ_IS_DIR_EXIT}; cat /bin/blob"


def test_read_bytes_of_an_empty_file_returns_empty_bytes(service, facade):
    facade.result = (None, None, 0)

    assert service.fs_read_bytes("l", "pc1", "/empty") == b""


@pytest.mark.parametrize(
    "stderr, message",
    [(b"cat: /nope: No such file or directory\n", "cat: /nope: No such file or directory"), (None, "exit code 1")],
)
def test_read_bytes_failure_reports_stderr_or_exit_code(service, facade, stderr, message):
    facade.result = (b"", stderr, 1)

    with pytest.raises(ApiError, match=f"Read file `/nope` failed: {message}"):
        service.fs_read_bytes("l", "pc1", "/nope")


def test_write_text_copies_utf8_content_and_returns_its_byte_size(service, facade):
    size = service.fs_write_text("l", "pc1", "etc/motd", "ciao è\n")

    assert size == len("ciao è\n".encode())
    assert facade.copies == [("pc1", {"/etc/motd": "ciao è\n".encode()})]


def test_upload_bytes_copies_the_raw_content_and_returns_its_size(service, facade):
    size = service.fs_upload_bytes("l", "pc1", "tmp//blob", b"\xff\x00\xfe")

    assert size == 3
    assert facade.copies == [("pc1", {"/tmp/blob": b"\xff\x00\xfe"})]


# ---------------------------------------------------------------------------
# Live-terminal support
# ---------------------------------------------------------------------------


def test_machine_api_object_comes_from_the_facade(service):
    assert service.get_machine_api_object("l", "pc1") == ("api-object", "pc1", "l")


def test_machine_api_object_on_a_manager_without_it_is_not_supported(service, facade, monkeypatch):
    monkeypatch.setattr(_RuntimeFacade, "get_machine_api_object", None)

    with pytest.raises(NotSupportedError, match="Live TTY is not supported"):
        service.get_machine_api_object("l", "pc1")


def test_available_shells_falls_back_to_every_shell_when_the_probe_fails(service, monkeypatch):
    def failing_exec(*_args, **_kwargs):
        raise RuntimeError("exec failed")

    monkeypatch.setattr(service, "exec_command", failing_exec)

    assert service.available_shells("l", "pc1") == ["bash", "sh", "ash", "zsh"]


# ---------------------------------------------------------------------------
# A running lab's topology
# ---------------------------------------------------------------------------


def test_add_link_deploys_it_with_its_external_interfaces(service, facade):
    link = service.add_link("l", "B", external=["eth0", "eth1.20"])

    assert facade.deployed_links == [link]
    assert link.name == "B"
    assert [ext.get_full_name() for ext in link.external] == ["eth0", "eth1.20"]
    assert service.registry.get("l").links["B"] is link


def test_add_link_without_external_interfaces(service, facade):
    link = service.add_link("l", "B")

    assert facade.deployed_links == [link]
    assert link.external == []


@pytest.fixture
def running_disk_lab(tmp_path, facade):
    """A lab persisted on disk (so add_machine has a lab.conf to append to), with pc1 running."""
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    make_lab(service, "disk", {"lab.conf": "pc1[0]=A\n"})
    service.registry.get("disk").machines["pc1"].api_object = object()
    return service


def test_add_machine_to_a_running_lab_deploys_it_and_persists_it(running_disk_lab, facade):
    service = running_disk_lab

    machine = service.add_machine("disk", MachineCreate(name="pc2", interfaces=[{"link": "A"}]))

    assert facade.deployed_machines == ["pc2"]
    assert machine.api_object is not None
    assert "pc2[0]=" in service.store.read_lab_conf_text("disk")


def test_add_machine_whose_deploy_fails_leaves_no_trace(running_disk_lab, facade):
    service = running_disk_lab
    facade.deploy_machine_error = RuntimeError("image not found")

    with pytest.raises(RuntimeError, match="image not found"):
        service.add_machine("disk", MachineCreate(name="pc2", interfaces=[{"link": "A"}]))

    lab = service.registry.get("disk")
    assert "pc2" not in lab.machines
    assert list(lab.links["A"].machines) == ["pc1"]
    assert service.store.read_lab_conf_text("disk") == "pc1[0]=A\n"



# ---------------------------------------------------------------------------
# The exact exec each runtime operation sends, and to which device of which lab
# ---------------------------------------------------------------------------

_SHELL_PROBE = "".join(f"[ -x {path} ] && echo {name}\n" for name, path in SHELL_PATHS.items())


@pytest.mark.parametrize(
    "call, command",
    [
        (lambda s: s.fs_read_bytes("l", "pc1", "/etc/hosts"),
         ["sh", "-lc", f"[ -d /etc/hosts ] && exit {KatharaService._FS_READ_IS_DIR_EXIT}; cat /etc/hosts"]),
        (lambda s: s.fs_mkdir("l", "pc1", "/d"), ["mkdir", "-p", "/d"]),
        (lambda s: s.fs_move("l", "pc1", "/a", "/b"), ["mv", "--", "/a", "/b"]),
        (lambda s: s.fs_copy("l", "pc1", "/a", "/b"), ["cp", "-a", "--", "/a", "/b"]),
        (lambda s: s.fs_delete("l", "pc1", "/a", recursive=True), ["rm", "-rf", "--", "/a"]),
        (lambda s: s.fs_delete("l", "pc1", "/a"), ["sh", "-lc", "rm -f -- /a || rmdir -- /a"]),
        (lambda s: s.get_startup_log("l", "pc1"), ["cat", "/var/log/startup.log"]),
        (lambda s: s.is_startup_finished("l", "pc1"), ["test", "-f", "/tmp/EOS"]),
        (lambda s: s.available_shells("l", "pc1"), ["sh", "-lc", _SHELL_PROBE]),
    ],
    ids=["read", "mkdir", "move", "copy", "delete -r", "delete", "startup log", "startup finished", "shells"],
)
def test_each_runtime_operation_runs_one_non_blocking_exec_on_the_right_device(service, facade, call, command):
    call(service)

    assert facade.execs == [("pc1", command, "l", False)]
    assert facade.streams == [False]


def test_listing_runs_its_find_on_the_right_device_without_blocking(service, facade):
    service.fs_list_directory("l", "pc1", "/srv")

    [(machine, command, lab, wait)] = facade.execs
    assert (machine, lab, wait, command[:2]) == ("pc1", "l", False, ["sh", "-lc"])


# ---------------------------------------------------------------------------
# Output that is not valid UTF-8 is shown with replacement characters, never raised on
# ---------------------------------------------------------------------------


def test_a_startup_log_with_invalid_utf8_is_still_returned(service, facade):
    facade.result = (b"ip a \xff done\n", b"", 0)

    assert service.get_startup_log("l", "pc1") == "ip a \ufffd done\n"


def test_a_failing_command_with_invalid_utf8_stderr_still_reports_it(service, facade):
    facade.result = (b"", b"denied \xff", 1)

    with pytest.raises(ApiError, match="denied \ufffd"):
        service.fs_mkdir("l", "pc1", "/d")
    with pytest.raises(ApiError, match="denied \ufffd"):
        service.fs_read_bytes("l", "pc1", "/d")


def test_a_listing_with_an_invalid_utf8_name_is_still_returned(service, facade):
    facade.result = (b"f\tf\t1\t644\t0\tbad\xffname\0", b"", 0)

    assert [e.name for e in service.fs_list_directory("l", "pc1", "/")] == ["bad\ufffdname"]


def test_a_shell_probe_with_invalid_utf8_still_finds_the_shells(service, facade):
    facade.result = (b"bash\n\xff\nzsh\n", b"", 0)

    assert service.available_shells("l", "pc1") == ["bash", "zsh"]


# ---------------------------------------------------------------------------
# What reaches Kathara when a running device's topology changes
# ---------------------------------------------------------------------------


def test_connecting_a_running_device_hands_its_mac_address_to_kathara(service, facade):
    service.connect_machine("l", "pc1", "B", mac_address="02:42:ac:11:00:02")

    assert facade.connects == [("pc1", "B", "02:42:ac:11:00:02")]


def test_a_running_device_refuses_an_explicit_interface_number(service, facade):
    with pytest.raises(NotSupportedError, match=r"Explicit interface_number is only supported when the device is not running\.$"):
        service.connect_machine("l", "pc1", "B", interface_number=3)
    assert facade.connects == []


@pytest.mark.parametrize("keep_link", [False, True])
def test_disconnecting_a_running_device_hands_keep_link_to_kathara(service, facade, keep_link):
    if keep_link:
        service.disconnect_machine("l", "pc1", "A", keep_link=True)
    else:
        service.disconnect_machine("l", "pc1", "A")

    assert facade.disconnects == [("pc1", "A", keep_link)]


@pytest.mark.parametrize("keep_links", [False, True])
def test_removing_a_running_device_hands_keep_links_to_kathara(service, facade, keep_links):
    if keep_links:
        service.remove_machine("l", "pc1", keep_links=True)
    else:
        service.remove_machine("l", "pc1")

    assert facade.undeployed_machines == [("pc1", keep_links)]
    assert "pc1" not in service.registry.get("l").machines


def test_connecting_a_stopped_device_appends_the_next_interface_with_its_mac_to_lab_conf(tmp_path, facade):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    make_lab(service, "disk", {"lab.conf": "pc1[0]=A\n"})

    service.connect_machine("disk", "pc1", "B", mac_address="02:42:ac:11:00:02")

    assert service.store.read_lab_conf_text("disk") == "pc1[0]=A\npc1[1]=B/02:42:ac:11:00:02\n"
    assert [(n, i.link.name, i.mac_address) for n, i in service.registry.get("disk").machines["pc1"].interfaces.items()] == [
        (0, "A", None),
        (1, "B", "02:42:ac:11:00:02"),
    ]
    assert facade.connects == []


def test_listing_shows_a_symlink_to_a_file_as_a_file_and_sorts_names_case_insensitively(service, facade):
    facade.result = (
        b"l\tf\t4\t777\t0\tlink-to-file\0"
        b"l\td\t4\t777\t0\tlink-to-dir\0"
        b"f\tf\t1\t644\t0\tb\0"
        b"f\tf\t1\t644\t0\t_a\0"
        b"f\tf\t1\t644\t0\tA\0",
        b"",
        0,
    )

    entries = service.fs_list_directory("l", "pc1", "/")

    # "_" sorts before letters once names are lower-cased (it would sort after them upper-cased).
    assert [(e.name, e.is_dir) for e in entries] == [
        ("link-to-dir", True), ("_a", False), ("A", False), ("b", False), ("link-to-file", False),
    ]


def test_a_failing_recursive_delete_names_the_path(service, facade):
    facade.result = (b"", b"rm: busy\n", 1)

    with pytest.raises(ApiError) as exc_info:
        service.fs_delete("l", "pc1", "/a", recursive=True)
    assert exc_info.value.detail == "Delete `/a` failed on `pc1`: rm: busy"


def test_exec_command_by_default_neither_waits_nor_streams(service, facade):
    service.exec_command("l", "pc1", ["ip", "a"])

    assert facade.execs == [("pc1", ["ip", "a"], "l", False)]
    assert facade.streams == [False]


def test_live_tty_on_a_manager_without_api_objects_is_not_supported(tmp_path):
    service = make_service(facade=FakeFacadeBase())  # has no get_machine_api_object at all
    lab = lab_builder.build_lab(LabCreate.model_validate({"name": "l", "machines": [{"name": "pc1"}]}))
    lab.machines["pc1"].api_object = object()
    service.registry.add(lab)

    with pytest.raises(NotSupportedError, match="Live TTY is not supported"):
        service.get_machine_api_object("l", "pc1")


def test_a_failed_add_to_a_running_lab_keeps_a_device_folder_that_already_existed(tmp_path, facade):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    make_lab(service, "disk", {"lab.conf": "pc1[0]=A\n", "pc2/etc/motd": "keep me"})
    service.registry.get("disk").machines["pc1"].api_object = object()
    facade.deploy_machine_error = RuntimeError("image not found")

    with pytest.raises(RuntimeError):
        service.add_machine("disk", MachineCreate(name="pc2"))

    assert (service.store.lab_dir("disk") / "pc2" / "etc" / "motd").read_text() == "keep me"

