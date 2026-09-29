"""The password gate on a deploy that reaches outside its containers, and the Kathara check it
replaces.

A privileged device, a host volume or the ``/hosthome`` mount starts only with a one-shot grant
the desktop shell issues after the user's password (services/deploy_grants.py); a browser build,
with no shell to issue one, keeps Kathara's own rule that privileged needs root. No Docker.
"""

import inspect
import time

import Kathara.utils
import pytest
from Kathara.exceptions import PrivilegeError
from Kathara.manager.docker import DockerMachine
from Kathara.setting.Setting import Setting

from kathara_api.config import get_settings
from kathara_api.errors import DeployNotAuthorizedError
from kathara_api.kathara_compat import _UtilsWithoutRootCheck, allow_privileged_devices_without_root
from kathara_api.main import create_app
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate, VolumeMount
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services.deploy_grants import DeployGrants, HostAccess
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, lab_id, make_client, make_service

SHELL_TOKEN = "shell-secret"


class _RecordingFacade(FakeFacadeBase):
    def __init__(self):
        self.deploy_calls = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.deploy_calls.append(set(selected_machines))
        for name in selected_machines:
            lab.machines[name].api_object = object()


@pytest.fixture
def facade():
    return _RecordingFacade()


@pytest.fixture
def service(tmp_path, facade):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    service.create_lab(
        LabCreate(
            name="l",
            machines=[
                MachineCreate(name="pc1", privileged=True),
                MachineCreate(name="pc2"),
                MachineCreate(name="pc3", volumes=[VolumeMount(host_path="/srv/data", guest_path="/data", mode="ro")]),
            ],
        )
    )
    return service


@pytest.fixture
def shell(monkeypatch):
    monkeypatch.setattr(get_settings(), "shell_token", SHELL_TOKEN)


@pytest.fixture
def hosthome(monkeypatch):
    setting = Setting.get_instance()
    monkeypatch.setattr(setting, "hosthome_mount", True)
    monkeypatch.setattr(setting, "remote_url", None)


def _id(service):
    return lab_id(service, "l")


# -- the proxy on DockerMachine ----------------------------------------------------------------


def test_only_dockermachine_sees_a_root_check_that_always_passes():
    allow_privileged_devices_without_root()
    allow_privileged_devices_without_root()

    assert isinstance(DockerMachine.utils, _UtilsWithoutRootCheck)
    assert DockerMachine.utils.is_admin() is True
    assert Kathara.utils.is_admin is not DockerMachine.utils.is_admin
    assert DockerMachine.utils.get_current_user_name is Kathara.utils.get_current_user_name


def test_the_app_installs_the_proxy_on_startup(monkeypatch):
    monkeypatch.setattr(DockerMachine, "utils", Kathara.utils)

    create_app()

    assert isinstance(DockerMachine.utils, _UtilsWithoutRootCheck)


def test_katharas_privileged_check_still_reads_is_admin_through_the_utils_module():
    """The proxy only works while `DockerMachine.create` asks `utils.is_admin()`: a Kathara upgrade
    that imports the function by name or moves the check fails here, before a deploy does."""
    source = inspect.getsource(DockerMachine.DockerMachine.create)

    assert "if privileged and not utils.is_admin():" in source


# -- DeployGrants --------------------------------------------------------------------------------


def test_a_grant_serves_one_deploy_of_its_own_lab():
    grants = DeployGrants()
    access = HostAccess(privileged=frozenset({"pc1"}))
    grants.grant("a", access)

    assert grants.consume("b") is None
    assert grants.consume("a") == access
    assert grants.consume("a") is None


def test_an_expired_grant_is_no_grant(monkeypatch):
    grants = DeployGrants(ttl=1)
    grants.grant("a", HostAccess(hosthome=True))
    later = time.monotonic() + 2
    monkeypatch.setattr(time, "monotonic", lambda: later)

    assert grants.consume("a") is None


def test_what_a_grant_does_not_cover_is_named_item_by_item():
    needed = HostAccess(
        privileged=frozenset({"pc1", "pc2"}),
        volumes=frozenset({("pc3", "/srv", "/data", "ro")}),
        hosthome=True,
    )
    granted = HostAccess(privileged=frozenset({"pc1"}), volumes=needed.volumes)

    missing = needed.beyond(granted)

    assert missing == HostAccess(privileged=frozenset({"pc2"}), hosthome=True)
    assert missing.describe() == (
        "device `pc2` is privileged; the host home directory is mounted at `/hosthome`"
    )
    assert needed.beyond(needed).is_empty()
    assert needed.beyond(None) == needed


# -- deploy_lab with the desktop shell -------------------------------------------------------------


@pytest.mark.parametrize("device", ["pc1", "pc3"])
def test_a_device_reaching_the_host_is_refused_without_a_grant(service, facade, shell, device):
    with pytest.raises(DeployNotAuthorizedError):
        service.deploy_lab(_id(service), selected_machines={device})

    assert facade.deploy_calls == []


def test_the_host_home_mount_needs_a_grant_even_for_a_plain_device(service, facade, shell, hosthome):
    with pytest.raises(DeployNotAuthorizedError, match="/hosthome"):
        service.deploy_lab(_id(service), selected_machines={"pc2"})

    assert facade.deploy_calls == []


def test_a_refused_deploy_starts_nothing_and_leaves_the_lab_deployable(service, facade, shell):
    """Refused before any network or container exists: nothing is recorded as a failed deploy,
    and the lab is not left marked as transitioning, so a granted deploy goes through at once."""
    with pytest.raises(DeployNotAuthorizedError):
        service.deploy_lab(_id(service))

    assert service.deploy_failure(service.get_lab_or_reconstruct(_id(service))) is None
    service.grant_deploy(_id(service))
    service.deploy_lab(_id(service))
    assert facade.deploy_calls == [{"pc1", "pc2", "pc3"}]


def test_the_host_home_mount_of_a_remote_daemon_needs_no_grant(service, facade, shell, monkeypatch):
    """Kathara mounts /hosthome only for a local daemon: on a remote one the setting reaches no
    directory of this host."""
    setting = Setting.get_instance()
    monkeypatch.setattr(setting, "hosthome_mount", True)
    monkeypatch.setattr(setting, "remote_url", "tcp://elsewhere:2376")

    service.deploy_lab(_id(service), selected_machines={"pc2"})

    assert facade.deploy_calls == [{"pc2"}]


def test_a_plain_device_needs_no_grant(service, facade, shell):
    service.deploy_lab(_id(service), selected_machines={"pc2"})

    assert facade.deploy_calls == [{"pc2"}]


def test_a_grant_lets_one_deploy_through(service, facade, shell, hosthome):
    service.grant_deploy(_id(service))

    service.deploy_lab(_id(service))

    assert facade.deploy_calls == [{"pc1", "pc2", "pc3"}]


def test_a_grant_is_used_up_by_the_deploy_it_allowed(service, facade, shell):
    service.grant_deploy(_id(service))
    service.deploy_lab(_id(service), selected_machines={"pc2"})
    service.deploy_lab(_id(service), selected_machines={"pc1"})

    with pytest.raises(DeployNotAuthorizedError):
        service.deploy_lab(_id(service), selected_machines={"pc3"})


def test_a_grant_covers_only_what_the_lab_asked_for_when_it_was_issued(service, facade, shell):
    service.grant_deploy(_id(service))
    lab = service.get_lab_or_reconstruct(_id(service))
    lab.machines["pc2"].meta["privileged"] = True

    with pytest.raises(DeployNotAuthorizedError, match=r"^This deploy needs your password first: device `pc2` is privileged\.$"):
        service.deploy_lab(_id(service))

    assert facade.deploy_calls == []


def test_a_device_already_running_needs_no_grant(service, facade, shell):
    service.grant_deploy(_id(service))
    service.deploy_lab(_id(service))

    service.deploy_lab(_id(service))

    assert facade.deploy_calls == [{"pc1", "pc2", "pc3"}]


# -- deploy_lab without the desktop shell ----------------------------------------------------------


def test_without_the_shell_a_privileged_device_needs_a_root_backend(service, facade, monkeypatch):
    monkeypatch.setattr(get_settings(), "shell_token", None)
    monkeypatch.setattr(kathara_service_module, "is_admin", lambda: False)

    with pytest.raises(PrivilegeError, match=r"^You must be root in order to start device `pc1` in privileged mode\.$"):
        service.deploy_lab(_id(service), selected_machines={"pc1"})

    monkeypatch.setattr(kathara_service_module, "is_admin", lambda: True)
    service.deploy_lab(_id(service), selected_machines={"pc1"})
    assert facade.deploy_calls == [{"pc1"}]


def test_without_the_shell_a_host_mount_relies_on_the_pages_own_confirmation(service, facade, monkeypatch, hosthome):
    monkeypatch.setattr(get_settings(), "shell_token", None)

    service.deploy_lab(_id(service), selected_machines={"pc3"})

    assert facade.deploy_calls == [{"pc3"}]


# -- POST /labs/{lab_id}/deploy-grant ---------------------------------------------------------------


@pytest.mark.parametrize(("configured", "headers"), [
    (None, {"X-Kathara-Shell-Token": "x"}),
    (SHELL_TOKEN, {}),
    (SHELL_TOKEN, {"X-Kathara-Shell-Token": "wrong"}),
])
def test_only_the_desktop_shell_can_grant_a_deploy(service, monkeypatch, configured, headers):
    monkeypatch.setattr(get_settings(), "shell_token", configured)

    with make_client(service) as client:
        resp = client.post(f"/api/labs/{_id(service)}/deploy-grant", headers=headers)

    assert resp.status_code == 403
    assert resp.json()["error_type"] == "ShellOnlyError"
    assert service.grants.consume(_id(service)) is None


def test_the_shell_grants_a_deploy_of_what_the_lab_asks_for(service, shell):
    with make_client(service) as client:
        resp = client.post(f"/api/labs/{_id(service)}/deploy-grant", headers={"X-Kathara-Shell-Token": SHELL_TOKEN})

    assert resp.status_code == 200
    assert service.grants.consume(_id(service)) == HostAccess(
        privileged=frozenset({"pc1"}), volumes=frozenset({("pc3", "/srv/data", "/data", "ro")})
    )


def test_granting_a_deploy_of_an_unknown_lab_is_a_404(service, shell):
    with make_client(service) as client:
        resp = client.post(
            f"/api/labs/{lab_id(service, 'nope')}/deploy-grant", headers={"X-Kathara-Shell-Token": SHELL_TOKEN}
        )

    assert resp.status_code == 404
