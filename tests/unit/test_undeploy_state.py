"""Regression tests: undeploy-family calls must clear stale ``api_object`` state (no Docker
required). Kathara's Docker manager never resets ``api_object`` on the in-memory model when a
container/network actually goes down, so without ``KatharaService._clear_undeployed_state`` the
API would keep reporting `deployed`/`running` as True forever after an undeploy.
"""

import pytest

from kathara_api.errors import LinkInUseError
from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from tests.helpers import FakeFacadeBase, make_service


class _NoopFacade(FakeFacadeBase):
    """Never clears ``api_object`` on undeploy, matching the real Kathara manager's behavior —
    the bug ``_clear_undeployed_state`` guards against."""


def _service_with_lab():
    service = make_service(facade=_NoopFacade())  # bypass Kathara.get_instance() (needs Docker)

    spec = LabCreate.model_validate(
        {
            "name": "testlab",
            "machines": [
                {"name": "pc1", "interfaces": [{"link": "shared", "number": 0}, {"link": "priv1", "number": 1}]},
                {"name": "pc2", "interfaces": [{"link": "shared", "number": 0}]},
            ],
        }
    )
    lab = lab_builder.build_lab(spec)
    service.registry.add(lab)
    return service, lab


def _mark_deployed(lab):
    for machine in lab.machines.values():
        machine.api_object = object()
    for link in lab.links.values():
        link.api_object = object()


def test_undeploy_lab_clears_all_machines_and_links():
    service, lab = _service_with_lab()
    _mark_deployed(lab)

    service.undeploy_lab("testlab")

    assert all(m.api_object is None for m in lab.machines.values())
    assert all(lk.api_object is None for lk in lab.links.values())


def test_undeploy_lab_partial_keeps_shared_link_up_for_remaining_machine():
    service, lab = _service_with_lab()
    _mark_deployed(lab)

    # Undeploy only pc1: "shared" still has pc2 running -> must stay up.
    # "priv1" has no other machine attached -> must go down.
    service.undeploy_lab("testlab", selected_machines={"pc1"})

    assert lab.machines["pc1"].api_object is None
    assert lab.machines["pc2"].api_object is not None
    assert lab.links["shared"].api_object is not None
    assert lab.links["priv1"].api_object is None


def test_remove_machine_keep_links_true_leaves_links_alone():
    service, lab = _service_with_lab()
    _mark_deployed(lab)

    service.remove_machine("testlab", "pc1", keep_links=True)

    assert "pc1" not in lab.machines  # actually removed from the model, not just undeployed
    assert lab.links["shared"].api_object is not None
    assert lab.links["priv1"].api_object is not None  # kept per keep_links=True


def test_remove_machine_without_keep_links_tears_down_orphaned_link():
    service, lab = _service_with_lab()
    _mark_deployed(lab)

    service.remove_machine("testlab", "pc1", keep_links=False)

    assert "pc1" not in lab.machines  # actually removed from the model
    assert "pc1" not in lab.links["shared"].machines  # detached from the shared collision domain
    assert lab.machines["pc2"].api_object is not None
    assert lab.links["shared"].api_object is not None  # pc2 still attached and running
    assert lab.links["priv1"].api_object is None  # no machine left running on it


def test_remove_link_refuses_when_a_running_machine_is_attached():
    # remove_link's own undeploy_link call would otherwise be a silent no-op for a domain that
    # still has a running machine attached (Docker refuses to remove a network with containers on
    # it) — fail fast instead of the API claiming success while the Docker network/veth survive.
    service, lab = _service_with_lab()
    _mark_deployed(lab)

    with pytest.raises(LinkInUseError):
        service.remove_link("testlab", "shared")

    # Nothing mutated: fail-fast, not a partial removal.
    assert "shared" in lab.links
    assert lab.machines["pc1"].interfaces[0] is not None
    assert lab.machines["pc2"].interfaces[0] is not None


def test_remove_link_detaches_interfaces_and_disappears_from_lab_when_stopped():
    service, lab = _service_with_lab()
    # Deliberately not _mark_deployed: every machine attached to "shared" is stopped.

    service.remove_link("testlab", "shared")

    assert "shared" not in lab.links
    # pc1's other interface (priv1) survives, renumbered down to fill the gap "shared" left.
    assert not any(iface is not None and iface.link.name == "shared" for iface in lab.machines["pc1"].interfaces.values())
    assert any(iface is not None and iface.link.name == "priv1" for iface in lab.machines["pc1"].interfaces.values())
    # pc2 had only "shared" attached: no interfaces left at all.
    assert lab.machines["pc2"].interfaces == {}
