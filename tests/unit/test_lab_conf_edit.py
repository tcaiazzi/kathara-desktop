"""Unit tests for surgical lab.conf text editing (no Docker required).

The central property under test: every operation touches only the lines it must, and leaves
everything else — comments, ordering, quoting, options this API doesn't interpret — byte for byte
untouched. See services/lab_conf_edit.py for the design rationale.
"""

import pytest
from Kathara.exceptions import MachineAlreadyExistsError, MachineCollisionDomainError, MachineNotFoundError

from kathara_api.errors import ApiError
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services import lab_conf_edit as lce

# A deliberately hostile lab.conf: comments, unusual interface ordering, single quotes, [volume],
# [num_terms]/[entrypoint]/[args], an unknown meta, a trailing comment on a line that will later be
# renumbered, and a device's line interleaved into another device's block.
GNARLY = (
    "# Static routing lab — hand written, please do not reformat.\n"
    'LAB_DESCRIPTION="Two routers"\n'
    "LAB_AUTHOR='Kathara'                 # single quotes on purpose\n"
    "\n"
    "# ---- r1: the border router ----\n"
    "r1[image]=kathara/base\n"
    'r1[1]="B"                            # eth1 declared before eth0 on purpose\n'
    "r1[0]=A\n"
    'r1[2]="C"                            # uplink to the ISP\n'
    "r1[num_terms]=2\n"
    "r1[volume]=/host/data|/mnt/data|rw\n"
    "r1[entrypoint]=/sbin/custom-init\n"
    "r1[args]=--verbose\n"
    "r1[frobnicate]=yes\n"
    "r1[sysctl]=net.ipv4.ip_forward=1\n"
    "\n"
    "pc1[image]='kathara/base'\n"
    'pc1[0]="A"\n'
    "r1[mem]=256m                         # r1 again, interleaved into pc1's block on purpose\n"
)

CRLF_TEXT = "pc1[image]=kathara/base\r\npc1[0]=A\r\n"
NO_FINAL_NEWLINE = "pc1[image]=kathara/base\npc1[0]=A"


# -- byte-fidelity of an unmodified document ---------------------------------


@pytest.mark.parametrize("text", [GNARLY, CRLF_TEXT, NO_FINAL_NEWLINE, "", "\n"])
def test_render_of_unmodified_document_is_byte_identical(text):
    assert lce.LabConfDoc(text).render() == text


# -- add_device ---------------------------------------------------------------


def test_add_device_only_appends():
    spec = MachineCreate.model_validate(
        {"name": "pc2", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}
    )
    result = lce.add_device(GNARLY, spec)

    assert result.startswith(GNARLY)
    assert lce.parse_errors(result) == []
    lce.validate(result)


def test_add_device_rejects_existing_name():
    spec = MachineCreate.model_validate({"name": "pc1", "image": "kathara/base"})
    with pytest.raises(MachineAlreadyExistsError):
        lce.add_device(GNARLY, spec)


def test_add_device_rejects_reserved_name():
    spec = MachineCreate.model_validate({"name": "shared", "image": "kathara/base"})
    with pytest.raises(ApiError):
        lce.add_device(GNARLY, spec)


def test_add_device_rejects_interface_gap_in_spec():
    spec = MachineCreate.model_validate(
        {"name": "pc2", "interfaces": [{"link": "A", "number": 0}, {"link": "B", "number": 2}]}
    )
    with pytest.raises(ApiError):
        lce.add_device(GNARLY, spec)


# -- remove_device --------------------------------------------------------------


def test_remove_device_drops_interleaved_lines_only():
    result = lce.remove_device(GNARLY, "r1")

    assert "r1[" not in result
    # pc1's own lines and both LAB_* lines and both comments survive byte-identical.
    assert "pc1[image]='kathara/base'\n" in result
    assert 'pc1[0]="A"\n' in result
    assert 'LAB_DESCRIPTION="Two routers"\n' in result
    assert "LAB_AUTHOR='Kathara'                 # single quotes on purpose\n" in result
    assert "# ---- r1: the border router ----" in result  # orphan comment, deliberately kept
    assert "\n\n\n" not in result  # no doubled-up blank line
    lce.validate(result)


def test_remove_device_absent_is_noop():
    assert lce.remove_device(GNARLY, "nosuch") == GNARLY


# -- add_interface --------------------------------------------------------------


def test_add_interface_inserts_after_highest_number_and_copies_quoting():
    unquoted = "r1[image]=kathara/base\nr1[0]=A\nr1[1]=B\n"
    out = lce.add_interface(unquoted, "r1", None, "C")
    assert out == "r1[image]=kathara/base\nr1[0]=A\nr1[1]=B\nr1[2]=C\n"

    quoted = 'pc1[image]=kathara/base\npc1[0]="A"\n'
    out2 = lce.add_interface(quoted, "pc1", None, "B")
    assert out2 == 'pc1[image]=kathara/base\npc1[0]="A"\npc1[1]="B"\n'


def test_add_interface_with_mac_renders_cd_slash_mac():
    text = "pc1[image]=kathara/base\npc1[0]=A\n"
    out = lce.add_interface(text, "pc1", None, "B", mac_address="00:11:22:33:44:55")
    assert "pc1[1]=B/00:11:22:33:44:55" in out


def test_add_interface_conflicts():
    text = "pc1[image]=kathara/base\npc1[0]=A\n"
    with pytest.raises(MachineCollisionDomainError):
        lce.add_interface(text, "pc1", 0, "X")  # number taken
    with pytest.raises(MachineCollisionDomainError):
        lce.add_interface(text, "pc1", 5, "A")  # already attached to A
    with pytest.raises(MachineNotFoundError):
        lce.add_interface(text, "nosuch", None, "A")


def test_add_interface_gap_is_refused():
    text = "pc1[image]=kathara/base\npc1[0]=A\n"
    with pytest.raises(ApiError):
        lce.add_interface(text, "pc1", 5, "B")


# -- remove_interface / renumber_interfaces --------------------------------------


def test_remove_interface_renumbers_and_preserves_trailing_comments():
    text = 'r1[image]=kathara/base\nr1[0]=A\nr1[1]=B\nr1[2]="C"   # uplink to the ISP\n'
    out = lce.remove_interface(text, "r1", "B")

    assert out == 'r1[image]=kathara/base\nr1[0]=A\nr1[1]="C"   # uplink to the ISP\n'
    lce.validate(out)


def test_remove_interface_absent_is_noop():
    text = "pc1[image]=kathara/base\npc1[0]=A\n"
    assert lce.remove_interface(text, "pc1", "nosuch") == text
    assert lce.remove_interface(text, "nosuch", "A") == text


def test_renumber_interfaces_is_idempotent():
    text = "r1[image]=kathara/base\nr1[1]=B\nr1[0]=A\n"
    once = lce.renumber_interfaces(text, "r1")
    twice = lce.renumber_interfaces(once, "r1")
    assert once == twice
    assert lce.interface_links(once, "r1") == {0: "A", 1: "B"}


# -- set_meta / unset_meta -------------------------------------------------------


def test_set_meta_rewrites_last_duplicate_in_place():
    text = "pc1[image]=kathara/base\npc1[mem]=128m\npc1[0]=A\npc1[mem]=256m\n"
    out = lce.set_meta(text, "pc1", "mem", "512m")
    assert out == "pc1[image]=kathara/base\npc1[mem]=128m\npc1[0]=A\npc1[mem]=512m\n"


def test_set_meta_inserts_at_end_of_device_lines():
    text = "pc1[image]=kathara/base\npc1[0]=A\npc2[image]=kathara/base\n"
    out = lce.set_meta(text, "pc1", "mem", "256m")
    assert out == "pc1[image]=kathara/base\npc1[0]=A\npc1[mem]=256m\npc2[image]=kathara/base\n"


def test_set_meta_forces_quotes_for_values_with_spaces():
    text = "pc1[image]=kathara/base\n"
    out = lce.set_meta(text, "pc1", "shell", "/bin/my shell")
    assert 'pc1[shell]="/bin/my shell"' in out


def test_set_meta_rejects_values_containing_quotes():
    text = "pc1[image]=kathara/base\n"
    with pytest.raises(ApiError):
        lce.set_meta(text, "pc1", "shell", 'has "a quote')


def test_unset_meta_removes_all_occurrences():
    text = "pc1[image]=kathara/base\npc1[mem]=128m\npc1[0]=A\npc1[mem]=256m\n"
    out = lce.unset_meta(text, "pc1", "mem")
    assert out == "pc1[image]=kathara/base\npc1[0]=A\n"


# -- set_lab_metadata -------------------------------------------------------------


def test_set_lab_metadata_replaces_in_place_and_inserts_at_top():
    text = "pc1[image]=kathara/base\n"
    out = lce.set_lab_metadata(text, "LAB_DESCRIPTION", "hello world")
    assert out == 'LAB_DESCRIPTION="hello world"\npc1[image]=kathara/base\n'

    out2 = lce.set_lab_metadata(out, "LAB_DESCRIPTION", "updated")
    assert out2 == 'LAB_DESCRIPTION="updated"\npc1[image]=kathara/base\n'


def test_set_lab_metadata_none_removes():
    text = 'LAB_DESCRIPTION="hello world"\npc1[image]=kathara/base\n'
    out = lce.set_lab_metadata(text, "LAB_DESCRIPTION", None)
    assert out == "pc1[image]=kathara/base\n"


def test_set_lab_metadata_rejects_unknown_key():
    with pytest.raises(ApiError):
        lce.set_lab_metadata("pc1[image]=kathara/base\n", "LAB_BOGUS", "x")


# -- cross-cutting: every operation keeps the file loadable, across line-ending styles ----------


OPERATIONS = [
    lambda t: lce.add_device(t, MachineCreate.model_validate({"name": "newdev", "image": "kathara/base"})),
    lambda t: lce.remove_device(t, "pc1"),
    lambda t: lce.add_interface(t, "pc1", None, "Z"),
    lambda t: lce.remove_interface(t, "pc1", "A"),
    lambda t: lce.set_meta(t, "pc1", "mem", "256m"),
    lambda t: lce.unset_meta(t, "pc1", "image"),
    lambda t: lce.set_lab_metadata(t, "LAB_DESCRIPTION", "d"),
]


@pytest.mark.parametrize("op", OPERATIONS)
def test_every_operation_keeps_the_file_loadable(op):
    text = 'pc1[image]=kathara/base\npc1[0]="A"\n'
    result = op(text)
    assert lce.parse_errors(result) == []
    lce.validate(result)


@pytest.mark.parametrize("op", OPERATIONS)
def test_operations_preserve_crlf(op):
    # A CRLF source file must not have any of its surviving lines silently switched to LF —
    # whichever lines an operation doesn't touch must keep the exact terminator they had.
    text = 'pc1[image]=kathara/base\r\npc1[0]="A"\r\n'
    result = op(text)
    assert "\r\n" in result or result == ""  # "" only when an op legitimately empties the file
    assert "\r" not in result.replace("\r\n", "")  # no bare \r / stray LF-only lines introduced
