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

from kathara_api.schemas.machine import MachineCreate


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


@pytest.mark.parametrize(
    "key",
    [
        "image", "mem", "cpus", "shell", "ipv6", "privileged", "bridged", "bridged_iface",
        "num_terms", "entrypoint", "args",
        "exec", "exec_commands", "port", "ports", "env", "envs", "sysctl", "sysctls",
        "ulimit", "ulimits", "volume", "volumes",
    ],
)
def test_meta_keys_shadowing_a_modeled_option_are_refused(key):
    """These used to be silently dropped (`lab_builder.apply_options`'s old `continue`) rather
    than rejected — ambiguous, and inconsistent with `lab_conf_edit.replace_device_options`, which
    had no equivalent check at all."""
    with pytest.raises(ValidationError):
        MachineCreate(name="pc1", metas={key: "x"})
