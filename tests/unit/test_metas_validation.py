"""Validation of `metas` keys (E12b).

Only `metas` *values* used to be validated (`MachineOptionsBase._no_quotes_in_values`) — the keys
were rendered raw into a `name[key]=...` lab.conf line by both `lab_store.gen_device_lines` and
`lab_conf_edit.replace_device_options`. A key with an embedded newline split one rendered line
into two, and the second half — when it happened to match the lab.conf line grammar — became an
independent, unrelated device directive (a ghost device). A purely numeric key was indistinguishable
from a real interface number on the next parse. `_valid_meta_keys` closes both by requiring a bare
identifier shape, and separately rejects any key that shadows an already-modeled option (`volume`,
`image`, ...), which used to be silently dropped instead of rejected.
"""

import pytest
from pydantic import ValidationError

from kathara_api.schemas.machine import MachineCreate, _RESERVED_META_KEYS
from kathara_api.services.lab_import import parse_lab_conf


def test_a_plain_identifier_key_is_accepted():
    machine = MachineCreate(name="pc1", metas={"frobnicate": "yes"})
    assert machine.metas == {"frobnicate": "yes"}


@pytest.mark.parametrize(
    "key",
    [
        'X]=1\npc3[image]="ghost" #',  # embedded newline — used to inject an independent device
        "1",  # purely numeric — collided with a real interface number on reparse
        "0",
        "pc[image]",
        'key"quoted',
        "key with space",
        "",
    ],
)
def test_malformed_meta_keys_are_refused(key):
    with pytest.raises(ValidationError):
        MachineCreate(name="pc1", metas={key: "value"})


# Parametrized over the constant itself, not a copy of it: the previous hand-written list could
# only ever assert that its own names were refused, so a name missing from `_RESERVED_META_KEYS`
# (as `cpu` was) left no trace here.
@pytest.mark.parametrize("key", sorted(_RESERVED_META_KEYS))
def test_meta_keys_shadowing_a_modeled_option_are_refused(key):
    """These used to be silently dropped (`lab_builder.apply_options`'s old `continue`) rather
    than rejected — ambiguous, and inconsistent with `lab_conf_edit.replace_device_options`, which
    had no equivalent check at all."""
    with pytest.raises(ValidationError):
        MachineCreate(name="pc1", metas={key: "x"})


# Reserved names that are *not* lab.conf option keys: `bridged_iface` is derived by the manager at
# deploy time rather than authored, and the plurals are this API's own JSON field names
# (`exec_commands`, `ports`, …) whose lab.conf spelling is the singular. They are reserved anyway so
# a request can't smuggle one in under a name that reads like the modeled field.
_JSON_ONLY_ALIASES = frozenset(
    {"bridged_iface", "exec_commands", "ports", "envs", "sysctls", "ulimits", "volumes"}
)


@pytest.mark.parametrize("key", sorted(_RESERVED_META_KEYS - _JSON_ONLY_ALIASES))
def test_every_reserved_key_is_one_the_parser_actually_interprets(key):
    """Anti-drift, reserved -> interpreted: a name is worth reserving only because
    `_apply_conf_option` would consume it on the next load. If one stops being interpreted (or was
    reserved by mistake), it lands in `metas` here and this fails.

    The converse direction — *interpreted* -> reserved, which is how `cpu` slipped through for as
    long as it did — can't be asserted generally while `_apply_conf_option` is an if/elif chain with
    no enumerable key set. `test_cpu_is_normalized_to_cpus_on_reparse` pins the one known alias;
    the structural check arrives when that chain is driven by an exported set (audit_3 Q8).
    """
    parsed = parse_lab_conf(f"pc1[{key}]=1")
    assert parsed.machines["pc1"].metas == {}, f"`{key}` is reserved but reaches metas unparsed"


def test_cpu_alias_is_refused_as_a_meta():
    """`cpu` is an alias `_apply_conf_option` normalizes to `cpus`, so a pass-through meta using it
    is not pass-through at all — see the round-trip below."""
    with pytest.raises(ValidationError):
        MachineCreate(name="pc1", metas={"cpu": "2"})


def test_cpu_is_normalized_to_cpus_on_reparse():
    """Why `cpu` must be reserved: accepted as a meta it would be written to lab.conf verbatim and
    come back as the real `cpus` option on the next load, bypassing `MachineOptionsBase.cpus`'
    validation entirely. This is the behaviour that makes the rejection above load-bearing.
    """
    machine = parse_lab_conf('pc1[cpu]="2"').machines["pc1"]
    assert machine.cpus == 2.0
    assert machine.metas == {}
