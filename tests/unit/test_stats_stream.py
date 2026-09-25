"""Regression test: ``machines_stats_stream`` must throttle its own consumption of Kathara's
stats generator. Upstream's ``DockerMachine.get_machines_stats`` has no delay for an *empty*
container list (a bare ``while True: yield dict()``), so without a floor here, streaming stats
for a lab with no running machines would spin a CPU core and hammer the Docker daemon for as
long as the client keeps the connection open.
"""

import itertools

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import kathara_service as kathara_service_module
from kathara_api.services import lab_builder
from tests.helpers import FakeFacadeBase, lab_id, make_service, register_lab


class _EmptyStatsFacade(FakeFacadeBase):
    """Mimics the real upstream generator's shape for an undeployed lab: an unthrottled stream
    of empty samples, one per ``next()`` call."""

    def get_machines_stats(self, lab_hash=None, machine_name=None, user=None):
        while True:
            yield {}


def test_machines_stats_stream_throttles_consecutive_empty_samples(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(kathara_service_module.time, "sleep", lambda s: sleeps.append(s))

    service = make_service(facade=_EmptyStatsFacade())  # bypass Kathara.get_instance() (needs Docker)
    spec = LabCreate.model_validate({"name": "testlab", "machines": [{"name": "pc1"}]})
    register_lab(service, lab_builder.build_lab(spec))

    samples = list(itertools.islice(service.machines_stats_stream(lab_id(service, "testlab")), 5))

    assert samples == [[]] * 5
    # The first sample must not wait (nothing to throttle against yet); every following one,
    # taken back-to-back with a fake facade that never sleeps on its own, must be throttled.
    assert len(sleeps) == 4
    assert all(s > 0 for s in sleeps)
