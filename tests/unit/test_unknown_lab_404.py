"""Regression tests for I2 (docs/audit_2.md): undeploy_lab, delete_lab, and the three stats
methods must 404 (LabNotFoundError) for a lab that was never created, exactly like every other
per-lab method already does via get_lab_or_reconstruct (see test_docker_offline.py's own
test_unknown_lab_is_still_a_404). Before this fix, undeploy_lab and delete_lab silently
succeeded, the stats snapshots returned an empty result, and machine_stats_snapshot raised the
wrong exception (409 MachineNotRunningError instead of 404).
"""

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase

UNKNOWN = "never-existed"


def _service(store: LabStore) -> KatharaService:
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()  # bypass Kathara.get_instance() (needs Docker)
    return service


def test_undeploy_lab_404s_for_an_unknown_name(tmp_path):
    service = _service(LabStore(tmp_path / "labs"))
    with pytest.raises(LabNotFoundError):
        service.undeploy_lab(UNKNOWN)


def test_delete_lab_404s_for_an_unknown_name(tmp_path):
    service = _service(LabStore(tmp_path / "labs"))
    with pytest.raises(LabNotFoundError):
        service.delete_lab(UNKNOWN)


def test_machines_stats_snapshot_404s_for_an_unknown_name(tmp_path):
    service = _service(LabStore(tmp_path / "labs"))
    with pytest.raises(LabNotFoundError):
        service.machines_stats_snapshot(UNKNOWN)


def test_machine_stats_snapshot_404s_for_an_unknown_lab_not_409(tmp_path):
    """An unknown *lab* must be a 404, not the 409 (MachineNotRunningError) a missing device
    sample would otherwise produce regardless of whether the lab itself exists."""
    service = _service(LabStore(tmp_path / "labs"))
    with pytest.raises(LabNotFoundError):
        service.machine_stats_snapshot(UNKNOWN, "pc1")


def test_machines_stats_stream_404s_eagerly_not_on_first_iteration(tmp_path):
    """machines_stats_stream must raise on the call itself, not lazily on first iteration: the
    router hands the returned generator straight to an already-started EventSourceResponse, so a
    LabNotFoundError raised only once iterated could no longer become an HTTP 404."""
    service = _service(LabStore(tmp_path / "labs"))
    with pytest.raises(LabNotFoundError):
        service.machines_stats_stream(UNKNOWN)  # must raise right here, not on next()


# -- HTTP level: confirm the 404 actually reaches the response, not just the service ------------


def test_http_undeploy_404s_for_an_unknown_lab(client):
    resp = client.post(f"/api/labs/{UNKNOWN}/undeploy")
    assert resp.status_code == 404


def test_http_delete_404s_for_an_unknown_lab(client):
    resp = client.delete(f"/api/labs/{UNKNOWN}")
    assert resp.status_code == 404


def test_http_stats_stream_404s_for_an_unknown_lab_instead_of_opening_an_empty_stream(client):
    resp = client.get(f"/api/labs/{UNKNOWN}/stats/stream")
    assert resp.status_code == 404
