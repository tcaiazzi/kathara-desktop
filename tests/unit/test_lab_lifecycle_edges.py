"""Refusals and rollbacks in KatharaService's lab lifecycle that the happy-path suites don't reach.

Deploy option validation (select *or* exclude, only devices the lab has), the rollback a failed
create or rename owes the disk and the registry, a running-state lookup that finds nothing, and
the host sysctl discovery behind the device editor's autocomplete. No Docker.
"""

import asyncio

import pytest
from Kathara.exceptions import InvocationError, LabNotFoundError, MachineNotFoundError
from Kathara.model.Lab import Lab

from kathara_api.errors import ApiError, LabAlreadyRegisteredError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, make_service, zip_bytes


class _RecordingFacade(FakeFacadeBase):
    def __init__(self):
        self.deploy_calls = []
        self.undeploy_calls = []
        self.stats_labs = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.deploy_calls.append(selected_machines)

    def undeploy_lab(self, **kwargs):
        self.undeploy_calls.append(kwargs)

    def get_machines_stats(self, lab_name=None, machine_name=None, user=None):
        self.stats_labs.append(lab_name)
        yield {}
        yield {}

    def get_formatted_manager_name(self):
        return "Docker (Kathara)"

    def get_release_version(self):
        return "29.7.2"


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


# ---------------------------------------------------------------------------
# What reaches Kathara from the lab lifecycle
# ---------------------------------------------------------------------------


def test_deploy_accepts_selecting_every_device(service, facade):
    service.deploy_lab("l", selected_machines={"pc1", "pc2"})

    assert facade.deploy_calls == [{"pc1", "pc2"}]


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"selected_machines": {"pc1"}},
        {"excluded_machines": {"pc2"}},
        {"selected_links": {"A"}},
    ],
    ids=["whole lab", "selected", "excluded", "links"],
)
def test_undeploy_hands_its_selection_to_kathara_unchanged(service, facade, kwargs):
    service.undeploy_lab("l", **kwargs)

    assert facade.undeploy_calls == [
        {"lab_name": "l", "selected_machines": None, "excluded_machines": None, "selected_links": None, **kwargs}
    ]


def test_undeploying_only_some_links_leaves_the_other_links_and_the_model_in_place(tmp_path, facade):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=facade)
    service.create_lab(LabCreate(name="net", machines=[
        MachineCreate(name="pc1", interfaces=[{"link": "A"}]), MachineCreate(name="pc2", interfaces=[{"link": "B"}]),
    ]))
    lab = service.registry.get("net")
    for obj in [*lab.machines.values(), *lab.links.values()]:
        obj.api_object = object()

    service.undeploy_lab("net", selected_links={"A"})

    assert service.registry.get("net") is lab  # a partial undeploy does not reload the lab from disk
    assert lab.links["A"].api_object is None
    assert lab.links["B"].api_object is not None


def test_deleting_a_lab_undeploys_that_lab_only(service, facade):
    service.delete_lab("l")

    assert facade.undeploy_calls == [{"lab_name": "l"}]


def test_stats_stream_asks_for_that_lab_and_waits_only_the_rest_of_the_interval(service, facade, monkeypatch):
    clock = iter([100.0, 100.0, 100.25, 100.25])
    sleeps = []
    monkeypatch.setattr(kathara_service_module.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(kathara_service_module.time, "sleep", sleeps.append)

    assert list(service.machines_stats_stream("l")) == [[], []]
    assert facade.stats_labs == ["l"]
    assert sleeps == [pytest.approx(0.75)]  # one second between samples, 0.25 of it already gone


def test_uploading_a_lab_does_not_deploy_it_unless_asked(service, facade):
    service.upload_lab("up", zip_bytes({"lab.conf": b"pc1[image]=kathara/base\n"}))

    assert facade.deploy_calls == []


def test_listing_the_gallery_uses_the_cache_unless_asked_to_refresh(service, monkeypatch):
    from kathara_api.services import lab_gallery

    refreshes = []

    async def fake_fetch(refresh=False):
        refreshes.append(refresh)
        return lab_gallery.Catalog(repo="a/b", ref="main", section="", fetched_at=0.0, entries={})

    monkeypatch.setattr(lab_gallery, "fetch_catalog_async", fake_fetch)

    asyncio.run(service.list_gallery_labs())
    asyncio.run(service.list_gallery_labs(refresh=True))

    assert refreshes == [False, True]


def test_system_info_reports_the_manager_and_daemon_version_when_docker_answers(service):
    info = service.system_info()

    assert (info["manager"], info["version"]) == ("Docker (Kathara)", "29.7.2")


def test_the_docker_hub_image_list_is_fetched_again_once_its_cache_expires(service, monkeypatch):
    from kathara_api.services import docker_hub

    fetches = []
    now = [1000.0]
    monkeypatch.setattr(docker_hub, "list_tagged_images", lambda: fetches.append(1) or ["kathara/base"])
    monkeypatch.setattr(kathara_service_module.time, "monotonic", lambda: now[0])

    service._official_images()
    now[0] += service._IMAGES_CACHE_TTL - 1
    service._official_images()
    now[0] += 2
    service._official_images()

    assert len(fetches) == 2


def test_reloading_from_disk_skips_an_unloadable_lab_and_keeps_going(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("a_broken", {"lab.conf": "!!! not a lab.conf\n"})
    store.write_lab("b_good", {"lab.conf": "pc1[image]=kathara/base\n"})

    service = make_service(store=store)
    service._reload_from_disk()

    assert service.registry.get("a_broken") is None
    assert service.registry.get("b_good") is not None


def test_a_name_held_by_an_unregistered_directory_is_not_free(service):
    """A directory can exist without a registry entry (dropped in by hand, or its lab.conf failed
    to parse), and importing over it would destroy it."""
    service.store.write_lab("taken", {"notes.txt": "someone else's"})

    with pytest.raises(LabAlreadyRegisteredError, match=r"^Lab `taken` already exists\.$"):
        service.upload_lab("taken", zip_bytes({"lab.conf": b"pc1[image]=kathara/base\n"}))
    assert (service.store.lab_dir("taken") / "notes.txt").read_text() == "someone else's"
