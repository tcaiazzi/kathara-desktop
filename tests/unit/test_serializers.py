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


def test_machine_to_detail_exposes_num_terms_entrypoint_args():
    lab = lab_builder.build_lab(
        LabCreate.model_validate(
            {
                "name": "metalab",
                "machines": [
                    {"name": "pc1", "num_terms": 2, "entrypoint": "/sbin/init", "args": "--verbose"}
                ],
            }
        )
    )
    detail = serializers.machine_to_detail(lab.machines["pc1"])
    assert detail.num_terms == 2
    assert detail.entrypoint == "/sbin/init"
    assert detail.args == "--verbose"


def test_a_singular_option_spelling_never_escapes_into_metas():
    """`MachineDetail.metas` feeds straight back into a PUT, so it must not contain a key the
    request schema would then reject.

    Before audit_3 Q8 the filter here used a narrower set than the schema's: it knew the plural
    field names (`ports`) but not the lab.conf spellings (`port`) or the `cpu` alias, so a
    `machine.meta` carrying one of those escaped into `metas` and the round-trip 422'd. Both sides
    now derive from `lab_conf_options.MODELED_META_KEYS`. Unreachable through the normal paths —
    the meta is set directly here — but the point is that it stays unreachable.
    """
    lab = _lab()
    machine = lab.machines["r1"]
    machine.meta["port"] = "8080:80/tcp"
    machine.meta["cpu"] = "2"
    machine.meta["genuinely_unknown"] = "kept"

    detail = serializers.machine_to_detail(machine)

    assert detail.metas == {"genuinely_unknown": "kept"}
