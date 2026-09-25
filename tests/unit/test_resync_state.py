"""Regression test: ``KatharaService.wipe()`` must clear every registered lab's stale
``api_object`` state, exactly like ``undeploy_lab``/``delete_lab`` already do for their target lab.
``update_lab_from_api`` only ever *sets* ``api_object`` for what's still running; it never clears a
stopped one, so without this, a lab wiped via `kathara wipe` would keep reporting
`deployed`/`running` as True forever on subsequent ``list_labs``/``get_lab_or_reconstruct`` reads.
"""

from docker.models.containers import Container

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from tests.helpers import FakeFacadeBase, make_service, register_lab


class _WipeFacade(FakeFacadeBase):
    """Wipes containers/networks in Docker but — like the real manager — never touches any
    registered Lab object's cached api_object; only ``update_lab_from_api``/the service's own
    bookkeeping can react to that."""

    def wipe(self, all_users=False):
        pass


def _service_with_lab():
    service = make_service(facade=_WipeFacade())  # bypass Kathara.get_instance() (needs Docker)

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
    register_lab(service, lab)
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
    register_lab(service, lab2)

    service.wipe()

    assert all(m.api_object is None for m in lab1.machines.values())
    assert all(m.api_object is None for m in lab2.machines.values())


class _FlakyWipeFacade(_WipeFacade):
    """Fails to undeploy one specific lab, exactly like a stuck container would — every other
    lab must still get cleaned up."""

    def __init__(self, failing_lab_hash):
        self._failing_lab_hash = failing_lab_hash

    def undeploy_lab(self, **kwargs):
        if kwargs.get("lab_hash") == self._failing_lab_hash:
            raise RuntimeError("container refused to stop")


def test_wipe_continues_past_a_failing_lab_and_reports_it():
    service, lab1 = _service_with_lab()
    _mark_deployed(lab1)

    spec2 = LabCreate.model_validate({"name": "otherlab", "machines": [{"name": "pc1"}]})
    lab2 = lab_builder.build_lab(spec2)
    _mark_deployed(lab2)
    register_lab(service, lab2)

    service._instance = _FlakyWipeFacade(failing_lab_hash=lab1.hash)

    failed = service.wipe()

    assert failed == ["testlab"]
    # The lab whose undeploy failed is still deployed as far as the model is concerned...
    assert all(m.api_object is not None for m in lab1.machines.values())
    # ...but the other one was not left stuck behind it.
    assert all(m.api_object is None for m in lab2.machines.values())


# -- containers that went away without this backend (e.g. `kathara lclean` in the lab directory) --


def _container(name: str) -> Container:
    return Container(attrs={"Id": f"id-{name}", "Name": name})


class _RunningFacade(FakeFacadeBase):
    """Mimics Kathara's Docker manager refresh: every device listed in `running` gets a *fresh*
    container object, and every other device is left untouched."""

    def __init__(self, lab_hash: str, running: set[str]):
        self.lab_hash = lab_hash
        self.running = running

    def update_lab_from_api(self, lab):
        if lab.hash == self.lab_hash:
            for name in self.running:
                lab.machines[name].api_object = _container(name)
        return lab


def test_a_refresh_clears_devices_whose_containers_are_gone():
    """The lab's id is the hash the CLI computes, so `kathara lclean` can stop a lab this app
    deployed; the next read must then report it stopped rather than keep the old container."""
    service, lab = _service_with_lab()
    for machine in lab.machines.values():
        machine.api_object = _container(machine.name)
    service._instance = _RunningFacade(lab.hash, running=set())

    refreshed = service.get_lab_or_reconstruct(lab.hash)

    assert all(m.api_object is None for m in refreshed.machines.values())
    assert all(link.api_object is None for link in refreshed.links.values())


def test_a_refresh_keeps_devices_whose_containers_still_run():
    service, lab = _service_with_lab()
    for machine in lab.machines.values():
        machine.api_object = _container(machine.name)
    service._instance = _RunningFacade(lab.hash, running={"pc1"})

    listed = next(listed for listed in service.list_labs() if listed.hash == lab.hash)

    assert listed.machines["pc1"].api_object is not None
    assert all(m.api_object is None for name, m in listed.machines.items() if name != "pc1")
