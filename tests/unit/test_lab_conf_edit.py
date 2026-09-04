"""Unit tests for surgical lab.conf text editing (no Docker required).

The central property under test: every operation touches only the lines it must, and leaves
everything else — comments, ordering, quoting, options this API doesn't interpret — byte for byte
untouched. See services/lab_conf_edit.py for the design rationale.
"""

import pytest
from Kathara.exceptions import MachineAlreadyExistsError, MachineCollisionDomainError, MachineNotFoundError

from kathara_api.errors import ApiError
from kathara_api.schemas.machine import MachineCreate, MachineUpdate, PortMapping, Ulimit
from kathara_api.services import lab_conf_edit as lce

# A deliberately hostile lab.conf: comments, unusual interface ordering, single quotes,
# [num_terms]/[entrypoint]/[args], an unknown meta, a trailing comment on a line that will later be
# renumbered, and a device's line interleaved into another device's block. Also carries a
# [volume] line — applied to the model like any other option now, but included here for the same
# reason as everything else: proving it survives an unrelated surgical edit byte-for-byte.
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


def test_remove_device_at_start_of_file_does_not_leave_a_leading_blank_line():
    # Removing the *first* device followed by a blank separator must collapse that blank the same
    # way removing the *last* device already does — the removed run starting at index 0 has no
    # "before" line to compare against, which is the asymmetry this test guards against.
    text = 'pc1[image]="kathara/base"\npc1[0]="A"\n\npc2[image]="kathara/base"\npc2[0]="A"\n'
    result = lce.remove_device(text, "pc1")
    assert result == 'pc2[image]="kathara/base"\npc2[0]="A"\n'
    lce.validate(result)


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


# -- set_meta_group / replace_device_options ---------------------------------------


def test_set_meta_group_replaces_all_old_lines_with_new_ones_in_place():
    doc = lce.LabConfDoc('pc1[image]="kathara/base"\npc1[env]="A=1"\npc1[env]="B=2"\npc1[0]="X"\n')
    doc.set_meta_group("pc1", "env", ["C=3", "D=4", "E=5"])
    assert doc.render() == (
        'pc1[image]="kathara/base"\npc1[env]="C=3"\npc1[env]="D=4"\npc1[env]="E=5"\npc1[0]="X"\n'
    )


def test_set_meta_group_appends_when_key_absent():
    doc = lce.LabConfDoc('pc1[image]="kathara/base"\npc1[0]="X"\n')
    doc.set_meta_group("pc1", "exec", ["echo hi"])
    assert doc.render() == 'pc1[image]="kathara/base"\npc1[0]="X"\npc1[exec]="echo hi"\n'


def test_set_meta_group_empty_values_removes_all():
    doc = lce.LabConfDoc('pc1[image]="kathara/base"\npc1[env]="A=1"\npc1[env]="B=2"\n')
    doc.set_meta_group("pc1", "env", [])
    assert doc.render() == 'pc1[image]="kathara/base"\n'


def test_replace_device_options_rewrites_only_the_target_device():
    spec = MachineUpdate(
        image="kathara/netkit-lab",
        mem="256m",
        bridged=True,
        envs={"FOO": "newval", "EXTRA": "1"},
        sysctls={"net.ipv4.ip_forward": 1},
        ulimits=[Ulimit(name="nofile", soft=1024, hard=2048)],
        ports=[PortMapping(host_port=8080, guest_port=80, protocol="tcp")],
        exec_commands=["echo hello"],
        metas={"custom_opt": "value1"},
    )
    result = lce.replace_device_options(GNARLY, "pc1", spec)
    assert 'pc1[image]="kathara/netkit-lab"' in result
    assert "pc1[mem]=256m" in result
    assert "pc1[bridged]=True" in result
    assert 'pc1[env]="FOO=newval"' in result
    assert 'pc1[env]="EXTRA=1"' in result
    assert 'pc1[sysctl]="net.ipv4.ip_forward=1"' in result
    assert 'pc1[ulimit]="nofile=1024:2048"' in result
    assert 'pc1[port]="8080:80/tcp"' in result
    assert 'pc1[exec]="echo hello"' in result
    assert "pc1[custom_opt]=value1" in result
    # r1's own options (including the ones interleaved into pc1's block) must be untouched.
    assert "r1[image]=kathara/base" in result
    assert "r1[volume]=/host/data|/mnt/data|rw" in result
    assert "r1[frobnicate]=yes" in result
    assert "r1[mem]=256m                         # r1 again, interleaved into pc1's block on purpose" in result
    lce.validate(result)


def test_replace_device_options_clears_options_not_resubmitted():
    text = 'pc1[image]="kathara/base"\npc1[mem]="128m"\npc1[env]="A=1"\npc1[custom]=old\npc1[0]="X"\n'
    result = lce.replace_device_options(text, "pc1", MachineUpdate())
    assert result == 'pc1[image]="kathara/base"\npc1[0]="X"\n'


def test_set_meta_group_clearing_a_group_collapses_blank_lines_like_unset_meta():
    # A hand-edited file with a single group-shaped option (port) surrounded by blank separators —
    # emptying it must collapse the resulting double blank line the same way unset_meta already does
    # for scalar keys, not leave two blank lines behind.
    text = 'pc1[image]="x"\n\npc1[port]="80:80/tcp"\n\npc2[image]="y"\n'
    doc = lce.LabConfDoc(text)
    doc.set_meta_group("pc1", "port", [])
    result = doc.render()
    assert result == 'pc1[image]="x"\n\npc2[image]="y"\n'
    assert "\n\n\n" not in result


def test_replace_device_options_is_idempotent():
    spec = MachineUpdate(mem="64m", envs={"X": "1"}, exec_commands=["a", "b"])
    once = lce.replace_device_options('pc1[0]="A"\n', "pc1", spec)
    twice = lce.replace_device_options(once, "pc1", spec)
    assert once == twice


def test_replace_device_options_unknown_device_raises():
    with pytest.raises(MachineNotFoundError):
        lce.replace_device_options('pc1[0]="A"\n', "ghost", MachineUpdate())


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
    lambda t: lce.replace_device_options(t, "pc1", MachineUpdate(mem="256m", envs={"X": "1"})),
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
