"""With the Docker daemon unreachable, reads must answer from the on-disk model instead of 503-ing.

A lab's configuration lives on disk and needs no daemon to be described, so a stopped Docker should
cost only the live "what is running?" overlay. Before ``KatharaService._facade_or_offline`` it cost
the whole response, and because the frontend's dock area only mounts once a lab detail loads, that
also took ``lab.conf``, the file editor and the topology — none of which involve Docker — down with
it.

No Docker required: ``Kathara.get_instance`` is monkeypatched to fail, which is the one thing these
tests need it to do.
"""

import time

import pytest
from Kathara.exceptions import DockerDaemonConnectionError, LabNotFoundError

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services import lab_builder, serializers
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore


class _CountingDeadDaemon:
    """Stands in for ``Kathara.get_instance``, always failing the way a stopped daemon does, and
    counting how many times it was actually attempted — that count is the point of the negative
    cache."""

    def __init__(self) -> None:
        self.attempts = 0

    def __call__(self):
        self.attempts += 1
        raise DockerDaemonConnectionError("Cannot connect to Docker Daemon")


@pytest.fixture
def dead_daemon(monkeypatch) -> _CountingDeadDaemon:
    probe = _CountingDeadDaemon()
    monkeypatch.setattr(kathara_service_module.Kathara, "get_instance", staticmethod(probe))
    return probe


@pytest.fixture
def service(tmp_path) -> KatharaService:
    """A service holding one two-device lab, over an explicitly empty store.

    The store matters: the default one points at the configured labs directory, so without it these
    assertions would see whatever labs the developer happens to have on disk.
    """
    svc = KatharaService(store=LabStore(tmp_path))
    spec = LabCreate.model_validate(
        {
            "name": "offlinelab",
            "machines": [
                {"name": "pc1", "interfaces": [{"link": "shared", "number": 0}]},
                {"name": "pc2", "interfaces": [{"link": "shared", "number": 0}]},
            ],
        }
    )
    svc.registry.add(lab_builder.build_lab(spec))
    return svc


def _mark_deployed(lab) -> None:
    for machine in lab.machines.values():
        machine.api_object = object()
    for link in lab.links.values():
        link.api_object = object()


# -- the labs on disk stay visible ------------------------------------------------------------


def test_list_labs_returns_disk_labs_with_nothing_running(dead_daemon, service):
    labs = service.list_labs()

    assert [lab.name for lab in labs] == ["offlinelab"]
    summary = serializers.lab_to_summary(labs[0])
    assert summary.deployed is False
    assert summary.n_machines == 2


def test_get_lab_or_reconstruct_returns_the_registered_model(dead_daemon, service):
    detail = serializers.lab_to_detail(service.get_lab_or_reconstruct("offlinelab"))

    assert detail.deployed is False
    assert {m.name: m.running for m in detail.machines} == {"pc1": False, "pc2": False}
    # The configuration itself — what the editor and topology need — is fully present.
    assert {iface.link for m in detail.machines for iface in m.interfaces} == {"shared"}


def test_system_info_keeps_every_field_that_does_not_need_docker(dead_daemon, service):
    info = service.system_info()

    assert info["manager"] == "Docker (Kathara)"
    assert info["available_managers"] == {"docker": "Docker (Kathara)"}
    # is_admin is a plain real-UID check, and it's the field the frontend actually consumes.
    assert isinstance(info["is_admin"], bool)
    # The daemon's own version is the one thing that genuinely can't be known.
    assert info["version"] is None


# -- stale state must not survive -------------------------------------------------------------


def test_stale_api_object_is_cleared_so_a_lost_daemon_stops_claiming_deployed(dead_daemon, service):
    """The reason ``_offline_lab_state`` exists rather than just skipping the facade call: Kathara
    never clears ``api_object`` itself, so a lab that was up before the daemon went away would keep
    reporting ``deployed``/``running`` forever."""
    lab = service.registry.get("offlinelab")
    _mark_deployed(lab)

    detail = serializers.lab_to_detail(service.get_lab_or_reconstruct("offlinelab"))

    assert detail.deployed is False
    assert all(m.running is False for m in detail.machines)
    assert all(m.api_object is None for m in lab.machines.values())
    assert all(lk.api_object is None for lk in lab.links.values())


def test_list_labs_clears_stale_state_too(dead_daemon, service):
    _mark_deployed(service.registry.get("offlinelab"))

    assert serializers.lab_to_summary(service.list_labs()[0]).deployed is False


def test_unknown_lab_is_still_a_404(dead_daemon, service):
    """An unregistered lab exists only as running containers, so with no daemon to ask there is
    genuinely no such lab — the same answer as "nothing is running under that name"."""
    with pytest.raises(LabNotFoundError):
        service.get_lab_or_reconstruct("never-existed")


# -- operations that really need Docker keep failing -------------------------------------------


@pytest.mark.parametrize(
    "operation",
    [
        pytest.param(lambda s: s.deploy_lab("offlinelab"), id="deploy_lab"),
        pytest.param(lambda s: s.undeploy_lab("offlinelab"), id="undeploy_lab"),
        pytest.param(lambda s: s.exec_command("offlinelab", "pc1", ["true"]), id="exec_command"),
        pytest.param(lambda s: s.machines_stats_snapshot("offlinelab"), id="machines_stats_snapshot"),
        pytest.param(lambda s: s.add_link("offlinelab", "newlink"), id="add_link"),
    ],
)
def test_docker_dependent_operations_still_raise(dead_daemon, service, operation):
    with pytest.raises(DockerDaemonConnectionError):
        operation(service)


# -- the negative cache ------------------------------------------------------------------------


def test_many_reads_cost_one_connection_attempt(dead_daemon, service):
    """Kathara builds its client with ``timeout=None``, so one attempt can be arbitrarily slow.
    Caching only success meant every read paid that again — which is what made opening the app slow
    rather than merely degraded."""
    for _ in range(5):
        service.list_labs()
        service.get_lab_or_reconstruct("offlinelab")
        service.system_info()

    assert dead_daemon.attempts == 1


def test_a_recovered_daemon_is_picked_up_once_the_ttl_lapses(dead_daemon, service, monkeypatch):
    """The cache must not latch the process into offline mode."""
    service.list_labs()
    assert dead_daemon.attempts == 1

    # Read the real clock *before* patching, or the lambda would call the patched function itself.
    later = time.monotonic() + service._FACADE_FAILURE_TTL + 1
    monkeypatch.setattr(kathara_service_module.time, "monotonic", lambda: later)
    service.list_labs()

    assert dead_daemon.attempts == 2
