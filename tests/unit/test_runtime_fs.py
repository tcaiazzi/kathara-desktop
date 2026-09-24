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

    def exec(self, machine_name, command, lab_name=None, wait=False, stream=False):
        self.execs.append((machine_name, command, lab_name, wait))
        return self.result

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


def test_listing_skips_malformed_lines_and_tolerates_unparseable_numbers(service, facade):
    facade.result = (
        b"\n"
        b"only\tthree\tfields\n"
        b"b.txt\tf\tf\tbig\t644\tsoon\n"
        b"A.txt\tf\tf\t12\t600\t1700000000.5\n",
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
        b"zeta\td\td\t4096\t755\t0\n"
        b"beta\tf\tf\t1\t644\t0\n"
        b"Alpha\tf\tf\t1\t644\t0\n"
        b"Ops\td\td\t4096\t755\t0\n",
        b"",
        0,
    )

    entries = service.fs_list_directory("l", "pc1", "/")

    assert [e.name for e in entries] == ["Ops", "zeta", "Alpha", "beta"]
    assert [e.path for e in entries] == ["/Ops", "/zeta", "/Alpha", "/beta"]


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
