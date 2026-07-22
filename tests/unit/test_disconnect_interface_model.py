"""Unit tests for disconnect semantics on stopped machines (no Docker required)."""

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder
from kathara_api.services.kathara_service import KatharaService
from tests.helpers import FakeFacadeBase


class _FacadeCaptureDisconnect(FakeFacadeBase):
    def __init__(self):
        self.called = False

    def disconnect_machine_from_link(self, machine, link, keep_link=False):
        self.called = True


def test_disconnect_machine_uses_model_remove_interface_when_stopped():
    service = KatharaService()
    facade = _FacadeCaptureDisconnect()
    service._instance = facade

    lab = lab_builder.build_lab(
        LabCreate.model_validate(
            {
                "name": "lab1",
                "machines": [
                    {"name": "pc1", "interfaces": [{"link": "A", "number": 0}]},
                ],
            }
        )
    )
    service.registry.add(lab)

    service.disconnect_machine("lab1", "pc1", "A")

    machine = lab.machines["pc1"]
    assert facade.called is False
    # The None slot Kathara leaves behind is compacted away (it would otherwise crash a later
    # update_lab_from_api), so the interface is gone entirely, not left as a None placeholder.
    assert 0 not in machine.interfaces
    assert "pc1" not in lab.links["A"].machines
