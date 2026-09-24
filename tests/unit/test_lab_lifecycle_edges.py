"""Refusals and rollbacks in KatharaService's lab lifecycle that the happy-path suites don't reach.

Deploy option validation (select *or* exclude, only devices the lab has), the rollback a failed
create or rename owes the disk and the registry, a running-state lookup that finds nothing, and
the host sysctl discovery behind the device editor's autocomplete. No Docker.
"""

import pytest
from Kathara.exceptions import InvocationError, LabNotFoundError, MachineNotFoundError
from Kathara.model.Lab import Lab

from kathara_api.errors import ApiError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, make_service


class _RecordingFacade(FakeFacadeBase):
    def __init__(self):
        self.deploy_calls = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.deploy_calls.append(selected_machines)


@pytest.fixture
def facade():
    return _RecordingFacade()


@pytest.fixture
def service(tmp_path, facade):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    service.create_lab(LabCreate(name="l", machines=[MachineCreate(name="pc1"), MachineCreate(name="pc2")]))
    return service


# ---------------------------------------------------------------------------
# deploy_lab options
# ---------------------------------------------------------------------------


def test_deploy_refuses_selecting_and_excluding_at_once(service, facade):
    with pytest.raises(InvocationError, match="either select or exclude"):
        service.deploy_lab("l", selected_machines={"pc1"}, excluded_machines={"pc2"})
    assert facade.deploy_calls == []


@pytest.mark.parametrize("option", ["selected_machines", "excluded_machines"])
def test_deploy_refuses_devices_the_lab_does_not_have(service, facade, option):
    with pytest.raises(MachineNotFoundError, match="pc9"):
        service.deploy_lab("l", **{option: {"pc1", "pc9"}})
    assert facade.deploy_calls == []


def test_deploy_with_exclusions_deploys_every_other_device(service, facade):
    service.deploy_lab("l", excluded_machines={"pc2"})

    assert facade.deploy_calls == [{"pc1"}]


def test_a_refused_deploy_does_not_leave_the_lab_transitioning(service):
    with pytest.raises(InvocationError):
        service.deploy_lab("l", selected_machines={"pc1"}, excluded_machines={"pc2"})

    service.fs_write_text_offline("l", "/notes.txt", "still editable\n")


# ---------------------------------------------------------------------------
# Rollbacks
# ---------------------------------------------------------------------------


def test_create_lab_whose_lab_conf_write_fails_leaves_nothing_behind(service, monkeypatch):
    def failing_write(lab_dir, lab):
        raise OSError("disk full")

    monkeypatch.setattr(service.store, "write_lab_conf", failing_write)

    with pytest.raises(OSError, match="disk full"):
        service.create_lab(LabCreate(name="broken", machines=[MachineCreate(name="pc1")]))

    assert service.registry.get("broken") is None
    assert not service.store.lab_dir("broken").exists()


def test_rename_to_the_same_name_is_a_no_op(service):
    lab = service.registry.get("l")

    assert service.rename_lab("l", " l ") is lab
    assert service.store.lab_dir("l").is_dir()


def test_rename_whose_reload_fails_moves_the_directory_back(service, monkeypatch):
    monkeypatch.setattr(service, "_reload_lab_from_disk", lambda name: False)

    with pytest.raises(ApiError, match="could not be reloaded after renaming"):
        service.rename_lab("l", "renamed")

    assert service.store.lab_dir("l").is_dir()
    assert not service.store.lab_dir("renamed").exists()
    assert service.registry.get("l") is not None
    assert service.registry.get("renamed") is None


# ---------------------------------------------------------------------------
# A lab known only by its running state
# ---------------------------------------------------------------------------


def test_an_unregistered_lab_with_nothing_running_is_not_found():
    """Docker's manager answers `get_lab_from_api` for an unknown name with an *empty* lab rather
    than raising, so the empty result itself has to read as a 404."""

    class _EmptyLabFacade(FakeFacadeBase):
        def get_lab_from_api(self, lab_name):
            return Lab(lab_name)

    service = make_service(facade=_EmptyLabFacade())

    with pytest.raises(LabNotFoundError, match="Lab `ghost` not found"):
        service.get_lab_or_reconstruct("ghost")


def test_an_unregistered_lab_with_running_devices_is_reconstructed_from_them():
    """A lab started outside this app (e.g. `kathara lstart`) exists only as running containers;
    it is served from what the manager reports, without being registered."""
    running = Lab("cli-lab")
    running.new_machine("pc1")

    class _RunningLabFacade(FakeFacadeBase):
        def get_lab_from_api(self, lab_name):
            return running

    service = make_service(facade=_RunningLabFacade())

    assert service.get_lab_or_reconstruct("cli-lab") is running
    assert service.registry.get("cli-lab") is None


# ---------------------------------------------------------------------------
# list_net_sysctls
# ---------------------------------------------------------------------------


def _point_proc_sys_net_at(monkeypatch, target):
    real_path = kathara_service_module.Path
    monkeypatch.setattr(
        kathara_service_module, "Path", lambda p: real_path(target) if p == "/proc/sys/net" else real_path(p)
    )


def test_net_sysctls_are_the_dotted_file_paths_under_proc_sys_net(service, tmp_path, monkeypatch):
    root = tmp_path / "net"
    for rel in ("core/somaxconn", "ipv4/ip_forward", "ipv4/conf/all/forwarding"):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("0\n")
    _point_proc_sys_net_at(monkeypatch, root)

    assert service.list_net_sysctls() == [
        "net.core.somaxconn",
        "net.ipv4.conf.all.forwarding",
        "net.ipv4.ip_forward",
    ]


def test_net_sysctls_are_empty_without_proc_sys_net(service, tmp_path, monkeypatch):
    _point_proc_sys_net_at(monkeypatch, tmp_path / "missing")

    assert service.list_net_sysctls() == []
