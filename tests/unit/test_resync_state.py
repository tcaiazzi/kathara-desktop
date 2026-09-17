"""Regression test: ``KatharaService.wipe()`` must clear every registered lab's stale
``api_object`` state, exactly like ``undeploy_lab``/``delete_lab`` already do for their target lab.
``update_lab_from_api`` only ever *sets* ``api_object`` for what's still running; it never clears a
stopped one, so without this, a lab wiped via `kathara wipe` would keep reporting
`deployed`/`running` as True forever on subsequent ``list_labs``/``get_lab_or_reconstruct`` reads.
"""

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from kathara_api.services.kathara_service import KatharaService
from tests.helpers import FakeFacadeBase


class _WipeFacade(FakeFacadeBase):
    """Wipes containers/networks in Docker but — like the real manager — never touches any
    registered Lab object's cached api_object; only ``update_lab_from_api``/the service's own
    bookkeeping can react to that."""

    def wipe(self, all_users=False):
        pass


def _service_with_lab():
    service = KatharaService()
    service._instance = _WipeFacade()  # bypass Kathara.get_instance() (needs Docker)

    spec = LabCreate.model_validate(
        {
            "name": "testlab",
            "machines": [
                {"name": "pc1", "interfaces": [{"link": "shared", "number": 0}]},
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


def test_wipe_clears_every_registered_lab():
    service, lab = _service_with_lab()
    _mark_deployed(lab)

    service.wipe()

    assert all(m.api_object is None for m in lab.machines.values())
    assert all(lk.api_object is None for lk in lab.links.values())


def test_wipe_clears_multiple_registered_labs():
    service, lab1 = _service_with_lab()
    _mark_deployed(lab1)

    spec2 = LabCreate.model_validate({"name": "otherlab", "machines": [{"name": "pc1"}]})
    lab2 = lab_builder.build_lab(spec2)
    _mark_deployed(lab2)
    service.registry.add(lab2)

    service.wipe()

    assert all(m.api_object is None for m in lab1.machines.values())
    assert all(m.api_object is None for m in lab2.machines.values())


class _FlakyWipeFacade(_WipeFacade):
    """Fails to undeploy one specific lab, exactly like a stuck container would — every other
    lab must still get cleaned up."""

    def __init__(self, failing_lab_name):
        self._failing_lab_name = failing_lab_name

    def undeploy_lab(self, **kwargs):
        if kwargs.get("lab_name") == self._failing_lab_name:
            raise RuntimeError("container refused to stop")


def test_wipe_continues_past_a_failing_lab_and_reports_it():
    service, lab1 = _service_with_lab()
    _mark_deployed(lab1)

    spec2 = LabCreate.model_validate({"name": "otherlab", "machines": [{"name": "pc1"}]})
    lab2 = lab_builder.build_lab(spec2)
    _mark_deployed(lab2)
    service.registry.add(lab2)

    service._instance = _FlakyWipeFacade(failing_lab_name="testlab")

    failed = service.wipe()

    assert failed == ["testlab"]
    # The lab whose undeploy failed is still deployed as far as the model is concerned...
    assert all(m.api_object is not None for m in lab1.machines.values())
    # ...but the other one was not left stuck behind it.
    assert all(m.api_object is None for m in lab2.machines.values())
