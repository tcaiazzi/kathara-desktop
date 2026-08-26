"""Unit tests for the lab.conf-fidelity schema validators (no Docker required).

`lab.conf`'s own grammar has no escape mechanism for quote characters (see
`schemas/common.reject_lab_conf_quotes`): a value containing one either gets silently mangled on
write or makes the line — and on reload, the whole lab — unparseable. These validators reject such
values at the API boundary instead, with a clear 422 rather than a lab that evaporates later.
"""

import pytest
from pydantic import ValidationError

from kathara_api.schemas.lab import LabMetadata
from kathara_api.schemas.machine import MachineCreate


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
