"""Unit tests for model -> schema serialization (no Docker required)."""

from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder, serializers


def _lab():
    return lab_builder.build_lab(
        LabCreate.model_validate(
            {
                "name": "serlab",
                "machines": [
                    {
                        "name": "r1",
                        "image": "kathara/base",
                        "ports": [{"host_port": 3000, "guest_port": 3000}],
                        "interfaces": [{"link": "a", "number": 0}],
                    }
                ],
            }
        )
    )


def test_machine_to_detail():
    lab = _lab()
    detail = serializers.machine_to_detail(lab.machines["r1"])

    assert detail.name == "r1"
    assert detail.image == "kathara/base"
    assert detail.running is False
    assert detail.ports[0].host_port == 3000
    assert detail.interfaces[0].link == "a"
    assert detail.interfaces[0].num == 0


def test_lab_to_detail_and_summary():
    lab = _lab()
    detail = serializers.lab_to_detail(lab)
    summary = serializers.lab_to_summary(lab)

    assert detail.name == "serlab"
    assert detail.n_machines == 1
    assert detail.n_links == 1
    assert detail.deployed is False
    assert summary.hash == lab.hash
    assert len(detail.machines) == 1
    assert len(detail.links) == 1


def test_link_to_detail():
    lab = _lab()
    link_detail = serializers.link_to_detail(lab.links["a"])
    assert link_detail.name == "a"
    assert "r1" in link_detail.machines
    assert link_detail.running is False


def test_machine_to_detail_ignores_none_interfaces_after_disconnect():
    lab = _lab()
    machine = lab.machines["r1"]
    link = lab.links["a"]

    machine.remove_interface(link)
    detail = serializers.machine_to_detail(machine)

    assert detail.interfaces == []


def test_machine_to_detail_ignores_interfaces_without_link_object():
    lab = _lab()
    machine = lab.machines["r1"]

    machine.interfaces[0].link = None
    detail = serializers.machine_to_detail(machine)

    assert detail.interfaces == []
