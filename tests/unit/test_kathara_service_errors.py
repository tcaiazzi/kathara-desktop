"""Unit tests for KatharaService error semantics (no Docker required)."""

import pytest

from Kathara.exceptions import DockerDaemonConnectionError, MachineNotRunningError
from Kathara.model.Lab import Lab

from kathara_api.errors import ApiError, BinaryFileError
from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from kathara_api.services.kathara_service import KatharaService


class _FacadeEmptyMachineStats:
    def get_machine_stats(self, machine_name, lab_name=None):
        if False:
            yield (machine_name, lab_name)


class _FacadeNoneMachineStats:
    # Mirrors DockerManager.get_machine_stats, which *yields None* (rather than stopping) for a device
    # that isn't running.
    def get_machine_stats(self, machine_name, lab_name=None):
        yield None


class _FacadeLabFromApiFailure:
    def get_lab_from_api(self, lab_name):
        raise DockerDaemonConnectionError("daemon down")


class _FacadeRefreshFailure:
    def update_lab_from_api(self, lab):
        raise DockerDaemonConnectionError("daemon down")


class _FacadeNoCopyOnStopped:
    def update_lab_from_api(self, lab):
        return lab

    def copy_files(self, machine, guest_to_host):
        raise AssertionError("copy_files should not be called for stopped machines")


def test_machine_stats_snapshot_raises_machine_not_running_on_empty_stream():
    service = KatharaService()
    service._instance = _FacadeEmptyMachineStats()

    with pytest.raises(MachineNotRunningError):
        service.machine_stats_snapshot("lab1", "pc1")


def test_machine_stats_snapshot_raises_machine_not_running_on_none_sample():
    service = KatharaService()
    service._instance = _FacadeNoneMachineStats()

    with pytest.raises(MachineNotRunningError):
        service.machine_stats_snapshot("lab1", "pc1")


def test_get_lab_or_reconstruct_propagates_non_not_found_errors():
    service = KatharaService()
    service._instance = _FacadeLabFromApiFailure()

    with pytest.raises(DockerDaemonConnectionError):
        service.get_lab_or_reconstruct("lab1")


def test_list_labs_propagates_refresh_errors():
    service = KatharaService()
    service._instance = _FacadeRefreshFailure()
    service.registry.add(Lab("lab1"))

    with pytest.raises(DockerDaemonConnectionError):
        service.list_labs()


def test_copy_files_on_stopped_machine_raises_machine_not_running():
    service = KatharaService()
    service._instance = _FacadeNoCopyOnStopped()

    spec = LabCreate.model_validate({"name": "lab1", "machines": [{"name": "pc1"}]})
    lab = lab_builder.build_lab(spec)
    service.registry.add(lab)

    with pytest.raises(MachineNotRunningError):
        service.copy_files("lab1", "pc1", {"/tmp/x.txt": "hello"})


def _service_with_running_machine() -> KatharaService:
    service = KatharaService()
    spec = LabCreate.model_validate({"name": "lab1", "machines": [{"name": "pc1"}]})
    lab = lab_builder.build_lab(spec)
    machine = lab.get_machine("pc1")
    machine.api_object = object()
    service.registry.add(lab)
    return service


def test_available_shells_returns_detected_subset_in_canonical_order():
    service = _service_with_running_machine()
    # Probe reports zsh + bash present (out of order); result must be canonical order, detected only.
    service.exec_command = lambda *a, **k: (b"zsh\nbash\n", b"", 0)  # type: ignore[method-assign]
    assert service.available_shells("lab1", "pc1") == ["bash", "zsh"]


def test_available_shells_falls_back_when_detection_yields_nothing():
    service = _service_with_running_machine()
    service.exec_command = lambda *a, **k: (b"", b"", 0)  # type: ignore[method-assign]
    assert service.available_shells("lab1", "pc1") == ["bash", "sh", "ash", "zsh"]


def test_available_shells_requires_running_machine():
    service = KatharaService()
    service._instance = _FacadeNoCopyOnStopped()
    spec = LabCreate.model_validate({"name": "lab1", "machines": [{"name": "pc1"}]})
    service.registry.add(lab_builder.build_lab(spec))

    with pytest.raises(MachineNotRunningError):
        service.available_shells("lab1", "pc1")


def test_fs_read_bytes_rejects_directory_paths_before_cat():
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        assert command[:2] == ["sh", "-lc"]
        return (b"", b"", KatharaService._FS_READ_IS_DIR_EXIT)

    service.exec_command = _fake_exec  # type: ignore[method-assign]

    with pytest.raises(ApiError, match="is a directory"):
        service.fs_read_bytes("lab1", "pc1", "/bin")


def test_fs_read_text_raises_binary_file_error_on_non_utf8_content():
    # A distinct exception (not a generic ApiError) so the frontend can detect this specific case
    # by error_type and offer a binary-aware fallback (download/delete) instead of a plain toast.
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        assert command[:2] == ["sh", "-lc"]
        return (b"\xff\xfe\x00\x01", b"", 0)

    service.exec_command = _fake_exec  # type: ignore[method-assign]

    with pytest.raises(BinaryFileError):
        service.fs_read_text("lab1", "pc1", "/blob.bin")


def test_fs_list_directory_marks_symlink_to_directory_as_directory():
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        if command[0:2] == ["sh", "-lc"]:
            payload = (
                "bin\tl\td\t7\t777\t1700000000\n"
                "etc\td\td\t4096\t755\t1700000001\n"
                "hosts\tf\tf\t123\t644\t1700000002\n"
            )
            return (payload.encode("utf-8"), b"", 0)
        raise AssertionError(f"Unexpected command: {command}")

    service.exec_command = _fake_exec  # type: ignore[method-assign]

    entries = service.fs_list_directory("lab1", "pc1", "/")
    by_name = {entry["name"]: entry for entry in entries}

    assert by_name["bin"]["is_dir"] is True
    assert by_name["etc"]["is_dir"] is True
    assert by_name["hosts"]["is_dir"] is False


def test_fs_list_directory_dereferences_a_symlinked_query_path():
    # Debian/Ubuntu-based images (kathara/base included) use a merged-usr layout where /bin, /lib,
    # /sbin are themselves symlinks to /usr/{bin,lib,sbin}. Plain `find` (`-P`) never descends into
    # a symlinked *starting* path — with `-mindepth 1` excluding that depth-0 node, listing one of
    # these would silently return zero entries unless the command dereferences it via `-H`.
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        if command[0:2] == ["sh", "-lc"]:
            assert "find -H " in command[2]
            payload = "ls\td\td\t4096\t755\t1700000000\n"
            return (payload.encode("utf-8"), b"", 0)
        raise AssertionError(f"Unexpected command: {command}")

    service.exec_command = _fake_exec  # type: ignore[method-assign]

    entries = service.fs_list_directory("lab1", "pc1", "/bin")
    assert [entry["name"] for entry in entries] == ["ls"]


def test_get_startup_log_returns_empty_string_when_file_does_not_exist_yet():
    # A device with no `.startup` script (or one that hasn't run yet) never gets a
    # /var/log/startup.log at all — `cat` fails, and that must read as "no log yet", not an error,
    # since the whole point is to poll this while a device is still booting.
    service = _service_with_running_machine()
    service.exec_command = lambda *a, **k: (b"", b"cat: No such file or directory\n", 1)  # type: ignore[method-assign]
    assert service.get_startup_log("lab1", "pc1") == ""


def test_get_startup_log_returns_file_content_when_present():
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        assert command == ["cat", "/var/log/startup.log"]
        assert wait is False
        return (b"+ ip addr add 10.0.0.1/24 dev eth0\n", b"", 0)

    service.exec_command = _fake_exec  # type: ignore[method-assign]
    assert service.get_startup_log("lab1", "pc1") == "+ ip addr add 10.0.0.1/24 dev eth0\n"


def test_is_startup_finished_checks_the_eos_marker_without_blocking():
    # Kathara's own startup-wait logic (`wait=True`) blocks on this exact same condition — passing
    # it here would hang instead of reporting current status, so this must always poll with
    # `wait=False` and just test for the /tmp/EOS marker Kathara's startup sequence touches last.
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        assert command == ["test", "-f", "/tmp/EOS"]
        assert wait is False
        return (b"", b"", 0)

    service.exec_command = _fake_exec  # type: ignore[method-assign]
    assert service.is_startup_finished("lab1", "pc1") is True


def test_is_startup_finished_is_false_before_the_marker_exists():
    service = _service_with_running_machine()
    service.exec_command = lambda *a, **k: (b"", b"", 1)  # type: ignore[method-assign]
    assert service.is_startup_finished("lab1", "pc1") is False


def test_get_startup_log_requires_running_machine():
    service = KatharaService()
    service._instance = _FacadeNoCopyOnStopped()
    spec = LabCreate.model_validate({"name": "lab1", "machines": [{"name": "pc1"}]})
    service.registry.add(lab_builder.build_lab(spec))

    with pytest.raises(MachineNotRunningError):
        service.get_startup_log("lab1", "pc1")


def test_is_startup_finished_requires_running_machine():
    service = KatharaService()
    service._instance = _FacadeNoCopyOnStopped()
    spec = LabCreate.model_validate({"name": "lab1", "machines": [{"name": "pc1"}]})
    service.registry.add(lab_builder.build_lab(spec))

    with pytest.raises(MachineNotRunningError):
        service.is_startup_finished("lab1", "pc1")


def test_fs_list_directory_handles_none_stdout_from_exec():
    service = _service_with_running_machine()

    def _fake_exec(lab_name, machine_name, command, wait=False):
        if command[0:2] == ["sh", "-lc"]:
            return (None, None, 0)
        raise AssertionError(f"Unexpected command: {command}")

    service.exec_command = _fake_exec  # type: ignore[method-assign]

    entries = service.fs_list_directory("lab1", "pc1", "/home")
    assert entries == []
