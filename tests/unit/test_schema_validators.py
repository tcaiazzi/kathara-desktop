"""Unit tests for the lab.conf-fidelity schema validators (no Docker required).

`lab.conf`'s own grammar has no escape mechanism for quote characters (see
`schemas/common.reject_lab_conf_quotes`): a value containing one either gets silently mangled on
write or makes the line — and on reload, the whole lab — unparseable. These validators reject such
values at the API boundary instead, with a clear 422 rather than a lab that evaporates later.
"""

import pytest
from pydantic import ValidationError

from kathara_api.schemas.lab import LabMetadata
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate, MachineUpdate


def test_machine_create_rejects_a_quote_in_a_scalar_field():
    for field in ("image", "mem", "shell", "entrypoint", "args"):
        with pytest.raises(ValidationError):
            MachineCreate.model_validate({"name": "pc1", field: 'has "a quote'})


def test_machine_create_rejects_a_quote_in_env_sysctl_and_meta_values():
    with pytest.raises(ValidationError):
        MachineCreate.model_validate({"name": "pc1", "envs": {"FOO": 'has "a quote'}})
    with pytest.raises(ValidationError):
        MachineCreate.model_validate({"name": "pc1", "sysctls": {"net.ipv4.ip_forward": "ha'x"}})
    with pytest.raises(ValidationError):
        MachineCreate.model_validate({"name": "pc1", "metas": {"frobnicate": "ha'x"}})


def test_machine_create_accepts_ordinary_values():
    spec = MachineCreate.model_validate(
        {"name": "pc1", "image": "kathara/base", "shell": "/bin/bash", "metas": {"frobnicate": "yes"}}
    )
    assert spec.image == "kathara/base"


def test_lab_metadata_rejects_a_quote():
    with pytest.raises(ValidationError):
        LabMetadata.model_validate({"description": 'a "quoted" description'})


def test_lab_metadata_accepts_ordinary_values():
    meta = LabMetadata.model_validate({"description": "plain description", "author": "Kathara"})
    assert meta.description == "plain description"


@pytest.mark.parametrize("mem", ["abc", "1.5g", "256mb", ""])
def test_a_mem_kathara_cannot_read_is_rejected_on_create_and_update(mem):
    """Kathara reads `mem` only when the device starts, and by then the lab's other containers are
    already running: the API refuses the value when it is written instead."""
    with pytest.raises(ValidationError):
        MachineCreate.model_validate({"name": "pc1", "mem": mem})
    with pytest.raises(ValidationError):
        MachineUpdate.model_validate({"mem": mem})


@pytest.mark.parametrize("mem", ["256m", "1G", "512", None])
def test_a_mem_kathara_reads_is_accepted(mem):
    assert MachineCreate.model_validate({"name": "pc1", "mem": mem}).mem == mem


@pytest.mark.parametrize("mac", ["zz", "02:00:00:00:00", "02-00-00-00-00-01", "02:00:00:00:00:0g"])
def test_an_interface_mac_address_must_be_six_hex_pairs(mac):
    with pytest.raises(ValidationError):
        InterfaceAttach.model_validate({"link": "A", "mac_address": mac})


def test_an_interface_accepts_a_well_formed_mac_address_or_none():
    assert InterfaceAttach.model_validate({"link": "A", "mac_address": "02:AB:cd:00:00:01"}).mac_address
    assert InterfaceAttach.model_validate({"link": "A"}).mac_address is None
