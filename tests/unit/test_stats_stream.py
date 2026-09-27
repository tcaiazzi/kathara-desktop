"""``KatharaService.machines_stats_stream``: one snapshot per second at most, a row per device
whose container can be read, and every Docker stats stream it opens closed with it."""

import itertools
from types import SimpleNamespace

import pytest
from docker.errors import NotFound

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services import lab_builder
from tests.helpers import FakeFacadeBase, lab_id, make_service, register_lab

_SAMPLE = {"pids_stats": {"current": 1}, "cpu_stats": {}, "memory_stats": {}}


class _FakeContainer:
    """Just what ``DockerMachineStats`` reads off a Docker ``Container``. ``stats()`` hands out a
    generator that records being closed; a ``gone`` container answers 404 on its first sample, as
    Docker does for a container removed after it was listed."""

    def __init__(self, name: str, gone: bool = False):
        self.id = f"id-{name}"
        self.name = f"kathara_{name}"
        self.labels = {"lab_hash": "h", "name": name, "user": "u"}
        self.image = SimpleNamespace(tags=["kathara/base:latest"])
        self.status = "running"
        self.attrs = {"NetworkSettings": {"Networks": {}}}
        self.gone = gone
        self.closed = False

    def reload(self):
        pass

    def stats(self, stream=True, decode=True):
        try:
            if self.gone:
                raise NotFound("No such container")
            while True:
                yield dict(_SAMPLE)
        finally:
            self.closed = True


class _ListingFacade(FakeFacadeBase):
    """Answers each container listing with the next of ``rounds``, repeating the last one."""

    def __init__(self, rounds: list[list[_FakeContainer]]):
        self.rounds = rounds

    def get_machines_api_objects(self, lab_hash=None, lab_name=None, lab=None, all_users=False):
        return self.rounds.pop(0) if len(self.rounds) > 1 else self.rounds[0]


@pytest.fixture
def sleeps(monkeypatch):
    recorded: list[float] = []
    monkeypatch.setattr(kathara_service_module.time, "sleep", lambda s: recorded.append(s))
    return recorded


def _stream(rounds):
    service = make_service(facade=_ListingFacade(rounds))
    spec = LabCreate.model_validate({"name": "testlab", "machines": [{"name": "pc1"}, {"name": "pc2"}]})
    register_lab(service, lab_builder.build_lab(spec))
    return service.machines_stats_stream(lab_id(service, "testlab"))


def _names(sample) -> list[str]:
    return sorted(stats.name for stats in sample)


def test_a_lab_with_nothing_running_is_sampled_once_a_second_at_most(sleeps):
    samples = list(itertools.islice(_stream([[]]), 5))

    assert samples == [[]] * 5
    # The first sample doesn't wait (nothing to throttle against yet); every following one, taken
    # back to back from a listing that answers at once, does.
    assert len(sleeps) == 4
    assert all(s > 0 for s in sleeps)


def test_a_device_whose_container_is_gone_loses_only_its_own_row(sleeps):
    pc1, pc2 = _FakeContainer("pc1"), _FakeContainer("pc2", gone=True)
    samples = list(itertools.islice(_stream([[pc1, pc2]]), 2))

    assert [_names(sample) for sample in samples] == [["pc1"], ["pc1"]]


def test_a_device_no_longer_listed_has_its_stats_stream_closed(sleeps):
    pc1, pc2 = _FakeContainer("pc1"), _FakeContainer("pc2")
    stream = _stream([[pc1, pc2], [pc1]])

    assert _names(next(stream)) == ["pc1", "pc2"]
    assert _names(next(stream)) == ["pc1"]
    assert pc2.closed and not pc1.closed


def test_closing_the_stream_closes_every_docker_stats_stream_it_opened(sleeps):
    pc1, pc2 = _FakeContainer("pc1"), _FakeContainer("pc2")
    stream = _stream([[pc1, pc2]])
    next(stream)
    next(stream)

    stream.close()

    assert pc1.closed and pc2.closed
