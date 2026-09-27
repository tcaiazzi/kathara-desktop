"""Regression test: ``KatharaService.wipe()`` must clear every registered lab's stale
``api_object`` state, exactly like ``undeploy_lab``/``delete_lab`` already do for their target lab.
``update_lab_from_api`` only ever *sets* ``api_object`` for what's still running; it never clears a
stopped one, so without this, a lab wiped via `kathara wipe` would keep reporting
`deployed`/`running` as True forever on subsequent ``list_labs``/``get_lab_or_reconstruct`` reads.
"""

from docker.models.containers import Container

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder, serializers
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, make_lab, make_service, register_lab


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
    return Container(attrs={"Id": f"id-{name}", "Name": name, "State": {"Status": "running"}})


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


# -- collision domains detached at runtime ------------------------------------------------------


class _AttachmentsFacade(FakeFacadeBase):
    """Mimics the interface bookkeeping of Kathara's ``DockerManager.update_lab_from_api``: it
    reads ``.link`` off every interface slot, drops the collision domains a device's container is
    no longer attached to with ``Machine.remove_interface`` (which leaves the slot ``None``), and
    adds back under their number the ones attached that the model lacks."""

    def __init__(self, attached: dict[str, dict[str, int]]):
        self.attached = attached  # device name -> {collision domain: interface number}
        self.refreshes = 0

    def update_lab_from_api(self, lab):
        self.refreshes += 1
        for device in lab.machines.values():
            static = {iface.link for iface in device.interfaces.values()}
            current = self.attached[device.name]
            for link in static:
                if link.name not in current:
                    device.remove_interface(link)
            static_names = {link.name for link in static}
            for name, number in current.items():
                if name not in static_names:
                    device.add_interface(lab.get_or_new_link(name), number=number)
        return lab


def _two_domain_lab(service):
    spec = LabCreate.model_validate(
        {
            "name": "twodomains",
            "machines": [
                {"name": "pc1", "interfaces": [{"link": "A", "number": 0}, {"link": "B", "number": 1}]},
                {"name": "pc2", "interfaces": [{"link": "A", "number": 0}]},
            ],
        }
    )
    lab = lab_builder.build_lab(spec)
    register_lab(service, lab)
    return lab


def test_a_collision_domain_detached_at_runtime_keeps_its_slot_and_later_reads_still_work():
    """The empty slot keeps the number taken: the container never gets that ethN again."""
    facade = _AttachmentsFacade({"pc1": {"A": 0}, "pc2": {"A": 0}})
    service = make_service(facade=facade)
    lab = _two_domain_lab(service)

    service.get_lab_or_reconstruct(lab.hash)
    service.get_lab_or_reconstruct(lab.hash)

    interfaces = lab.machines["pc1"].interfaces
    assert list(interfaces) == [0, 1]
    assert interfaces[0].link.name == "A" and interfaces[1] is None


def test_a_collision_domain_attached_again_comes_back_under_its_own_number():
    facade = _AttachmentsFacade({"pc1": {"A": 0}, "pc2": {"A": 0}})
    service = make_service(facade=facade)
    lab = _two_domain_lab(service)
    service.get_lab_or_reconstruct(lab.hash)

    facade.attached["pc1"] = {"A": 0, "B": 1}
    service.get_lab_or_reconstruct(lab.hash)

    assert lab.machines["pc1"].interfaces[1].link.name == "B"


class _ReadDuringDeployFacade(_AttachmentsFacade):
    """A deploy that, half-way through, has only attached each device's first collision domain,
    and meanwhile serves a read of the same lab — a startup-log poll, say."""

    service = None

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.attached = {"pc1": {"A": 0}, "pc2": {"A": 0}}
        before = self.refreshes
        self.service.get_lab_or_reconstruct(lab.hash)
        self.refreshes_during_deploy = self.refreshes - before


def test_a_read_during_a_deploy_leaves_the_lab_model_to_the_deploy():
    facade = _ReadDuringDeployFacade({"pc1": {"A": 0, "B": 1}, "pc2": {"A": 0}})
    service = make_service(facade=facade)
    facade.service = service
    lab = _two_domain_lab(service)

    service.deploy_lab(lab.hash)

    assert facade.refreshes_during_deploy == 0
    assert sorted(lab.machines["pc1"].interfaces) == [0, 1]


def test_a_deploy_still_refreshes_the_lab_it_is_deploying():
    facade = _AttachmentsFacade({"pc1": {"A": 0, "B": 1}, "pc2": {"A": 0}})
    service = make_service(facade=facade)
    lab = _two_domain_lab(service)

    service.deploy_lab(lab.hash)

    assert facade.refreshes == 1


# -- interfaces changed at runtime ---------------------------------------------------------------


class _RuntimeFacade(FakeFacadeBase):
    """Kathara's runtime interface bookkeeping: a connect numbers the new interface by counting
    the device's slots (``Machine.add_interface`` with no number), a disconnect empties the slot
    (``Machine.remove_interface``), and a refresh reads ``.link`` off every slot and hands each
    running device a fresh container object."""

    def __init__(self, running: set[str]):
        self.running = running

    def update_lab_from_api(self, lab):
        for device in lab.machines.values():
            {iface.link for iface in device.interfaces.values()}
            if device.name in self.running:
                device.api_object = _container(device.name)
        return lab

    def connect_machine_to_link(self, machine, link, mac_address=None):
        machine.add_interface(link, mac_address=mac_address)

    def disconnect_machine_from_link(self, machine, link, keep_link=False):
        machine.remove_interface(link)

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        lab.check_integrity()
        lab.get_links_from_machines(selected_machines)
        for name in selected_machines:
            lab.machines[name].api_object = _container(name)
            self.running.add(name)


def _shown_interfaces(machine):
    return [(iface.num, iface.link) for iface in serializers.machine_to_detail(machine).interfaces]


def test_an_interface_attached_again_at_runtime_takes_the_next_number_as_its_container_does():
    service = make_service(facade=_RuntimeFacade(running={"pc1", "pc2"}))
    lab = _two_domain_lab(service)
    for machine in lab.machines.values():
        machine.api_object = _container(machine.name)

    service.connect_machine(lab.hash, "pc2", "X")
    service.disconnect_machine(lab.hash, "pc2", "X")
    service.connect_machine(lab.hash, "pc2", "X")

    assert _shown_interfaces(service.get_lab_or_reconstruct(lab.hash).machines["pc2"]) == [(0, "A"), (2, "X")]


def test_a_device_deploys_while_another_one_has_an_interface_removed_at_runtime():
    service = make_service(facade=_RuntimeFacade(running={"pc1"}))
    lab = _two_domain_lab(service)
    lab.machines["pc1"].api_object = _container("pc1")
    service.disconnect_machine(lab.hash, "pc1", "B")

    service.deploy_lab(lab.hash, selected_machines={"pc2"})

    assert lab.machines["pc2"].api_object is not None


_NET_CONF = """pc1[0]="A"
pc1[1]="B"
pc2[0]="A"
"""


def test_a_device_undeployed_alone_takes_back_the_interfaces_its_lab_conf_declares(tmp_path):
    service = make_service(store=LabStore(tmp_path / "labs"), facade=_RuntimeFacade(running={"pc1", "pc2"}))
    lab, _warnings = make_lab(service, "net", {"lab.conf": _NET_CONF})
    for machine in lab.machines.values():
        machine.api_object = _container(machine.name)
    service.disconnect_machine(lab.hash, "pc1", "B")
    service.connect_machine(lab.hash, "pc1", "X")
    service.connect_machine(lab.hash, "pc2", "Y")

    service._instance.running.discard("pc1")
    service.undeploy_lab(lab.hash, selected_machines={"pc1"})

    lab = service.get_lab_or_reconstruct(lab.hash)
    assert _shown_interfaces(lab.machines["pc1"]) == [(0, "A"), (1, "B")]
    assert "X" not in lab.links
    # The device left running keeps what changed at runtime.
    assert _shown_interfaces(lab.machines["pc2"]) == [(0, "A"), (1, "Y")]
