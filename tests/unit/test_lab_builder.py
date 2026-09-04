"""Unit tests for the JSON -> Kathara model builder (no Docker required)."""

import pytest

from kathara_api.errors import ApiError
from kathara_api.schemas.lab import LabCreate
from kathara_api.services import lab_builder


def _lab_spec():
    return LabCreate.model_validate(
        {
            "name": "testlab",
            "metadata": {"description": "d", "author": "a"},
            "machines": [
                {
                    "name": "pc1",
                    "image": "kathara/base",
                    "mem": "128m",
                    "cpus": 0.5,
                    "ports": [{"host_port": 8080, "guest_port": 80, "protocol": "tcp"}],
                    "envs": {"FOO": "bar"},
                    "sysctls": {"net.ipv4.ip_forward": 1},
                    "exec_commands": ["echo hi"],
                    "ulimits": [{"name": "nofile", "soft": 1024, "hard": 2048}],
                    "interfaces": [{"link": "a", "number": 0}],
                },
                {"name": "pc2", "interfaces": [{"link": "a", "number": 0}]},
            ],
            "links": [{"name": "b"}],
        }
    )


def test_build_lab_creates_machines_and_links():
    lab = lab_builder.build_lab(_lab_spec())

    assert lab.name == "testlab"
    assert lab.description == "d"
    assert set(lab.machines.keys()) == {"pc1", "pc2"}
    # link "a" implied by interfaces + explicit link "b"
    assert "a" in lab.links
    assert "b" in lab.links


def test_build_lab_formats_machine_meta():
    lab = lab_builder.build_lab(_lab_spec())
    pc1 = lab.machines["pc1"]

    assert pc1.get_image() == "kathara/base"
    assert pc1.meta["mem"] == "128m"
    assert pc1.get_envs()["FOO"] == "bar"
    assert pc1.get_sysctls()["net.ipv4.ip_forward"] == 1
    assert pc1.get_exec_commands() == ["echo hi"]
    # ports meta keyed by (host_port, protocol) -> guest_port
    assert pc1.get_ports()[(8080, "tcp")] == 80
    assert pc1.meta["ulimits"]["nofile"] == {"soft": 1024, "hard": 2048}


def test_interfaces_connected():
    lab = lab_builder.build_lab(_lab_spec())
    pc1 = lab.machines["pc1"]
    assert 0 in pc1.interfaces
    assert pc1.interfaces[0].link.name == "a"


def test_invalid_machine_name_rejected_by_schema():
    with pytest.raises(Exception):
        LabCreate.model_validate({"name": "x", "machines": [{"name": "BAD NAME"}]})


def test_build_external_link_splits_vlan_tag():
    # "eth0.100" must become ExternalLink(interface="eth0", vlan=100), not a literal iface name —
    # otherwise the VLAN sub-interface is never created at deploy.
    ext = lab_builder.build_external_link("eth0.100")
    assert ext.interface == "eth0"
    assert ext.vlan == 100

    plain = lab_builder.build_external_link("eth0")
    assert plain.interface == "eth0"
    assert plain.vlan is None


def test_build_external_link_rejects_out_of_range_vlan():
    # ApiError (400), not a bare ValueError: ValueError isn't in errors.KATHARA_STATUS_MAP, so it
    # would surface to the client as a 500 for what is plainly a bad request.
    with pytest.raises(ApiError) as excinfo:
        lab_builder.build_external_link("eth0.5000")
    assert excinfo.value.status_code == 400


def test_build_lab_wires_external_link_vlan():
    spec = LabCreate.model_validate(
        {
            "name": "extlab",
            "machines": [{"name": "pc1", "interfaces": [{"link": "a", "number": 0}]}],
            "links": [{"name": "a", "external": ["eth0.100"]}],
        }
    )
    lab = lab_builder.build_lab(spec)
    externals = lab.links["a"].external
    assert len(externals) == 1
    assert externals[0].interface == "eth0"
    assert externals[0].vlan == 100


def test_build_machine_routes_num_terms_entrypoint_args():
    spec = LabCreate.model_validate(
        {
            "name": "metalab",
            "machines": [
                {"name": "pc1", "num_terms": 2, "entrypoint": "/sbin/init", "args": "--verbose"}
            ],
        }
    )
    lab = lab_builder.build_lab(spec)
    pc1 = lab.machines["pc1"]
    assert pc1.meta["num_terms"] == 2
    assert pc1.meta["entrypoint"] == "/sbin/init"
    assert pc1.meta["args"] == "--verbose"


def test_build_machine_applies_unknown_pass_through_meta():
    spec = LabCreate.model_validate(
        {"name": "metalab", "machines": [{"name": "pc1", "metas": {"frobnicate": "yes"}}]}
    )
    lab = lab_builder.build_lab(spec)
    assert lab.machines["pc1"].meta["frobnicate"] == "yes"


def test_build_machine_pass_through_meta_cannot_smuggle_a_volume():
    # A pass-through meta named "volume" must never reach Machine.add_meta, whose special-case
    # for "volume" turns a value into a host bind mount. This is a different hole than lab.conf's
    # typed `[volume]`/JSON's `volumes` (both applied, both validated by VolumeMount) — this one
    # is the generic `metas` passthrough trying to sneak a mount in under a key it isn't.
    spec = LabCreate.model_validate(
        {"name": "metalab", "machines": [{"name": "pc1", "metas": {"volume": "/etc|/etc|rw"}}]}
    )
    lab = lab_builder.build_lab(spec)
    assert lab.machines["pc1"].get_volumes() == {}


def test_build_machine_pass_through_meta_cannot_override_reserved_keys():
    # "image" is handled by _machine_kwargs already; a pass-through entry for it must be ignored,
    # not silently clobber the value that was set through the normal path.
    spec = LabCreate.model_validate(
        {"name": "metalab", "machines": [{"name": "pc1", "image": "kathara/base", "metas": {"image": "evil"}}]}
    )
    lab = lab_builder.build_lab(spec)
    assert lab.machines["pc1"].get_image() == "kathara/base"
