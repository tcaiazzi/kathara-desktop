"""Unit tests for machine interface add/remove semantics (no Docker required)."""

import pytest
from Kathara.exceptions import NotSupportedError

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from kathara_api.services.kathara_service import KatharaService
from tests.helpers import FakeFacadeBase


class _FacadeCaptureConnect(FakeFacadeBase):
    def __init__(self):
        self.called = False

    def connect_machine_to_link(self, machine, link, mac_address=None):
        self.called = True


def _service_with_stopped_machine():
    service = KatharaService()
    facade = _FacadeCaptureConnect()
    service._instance = facade

    lab = lab_builder.build_lab(
        LabCreate.model_validate(
            {
                "name": "lab1",
                "machines": [{"name": "pc1"}],
            }
        )
    )
    service.registry.add(lab)
    return service, facade, lab


def test_connect_machine_adds_explicit_interface_on_stopped_machine():
    service, facade, lab = _service_with_stopped_machine()

    service.connect_machine("lab1", "pc1", "A", interface_number=3, mac_address="02:00:00:00:00:03")

    machine = lab.machines["pc1"]
    assert facade.called is False
    assert 3 in machine.interfaces
    assert machine.interfaces[3].link.name == "A"
    assert machine.interfaces[3].mac_address == "02:00:00:00:00:03"


def test_connect_machine_rejects_explicit_interface_on_running_machine():
    service, _, lab = _service_with_stopped_machine()
    lab.machines["pc1"].api_object = object()

    with pytest.raises(NotSupportedError):
        service.connect_machine("lab1", "pc1", "A", interface_number=3)


class _Container:
    def __init__(self, network_mode):
        self.attrs = {"HostConfig": {"NetworkMode": network_mode}}


def test_connect_machine_rejects_running_machine_started_without_network():
    service, facade, lab = _service_with_stopped_machine()
    machine = lab.machines["pc1"]
    machine.api_object = _Container("none")

    with pytest.raises(NotSupportedError, match="`pc1` was started without any network interface"):
        service.connect_machine("lab1", "pc1", "A")

    assert facade.called is False
    assert machine.interfaces == {}


def test_connect_machine_connects_running_machine_started_with_network():
    service, facade, lab = _service_with_stopped_machine()
    lab.machines["pc1"].api_object = _Container("bridge")

    service.connect_machine("lab1", "pc1", "A")

    assert facade.called is True
