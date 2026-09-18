"""`lab.conf` line endings: the parser and the editor must split identically (audit_3 Q2).

`lab_import.parse_lab_conf` split on `\\r?\\n` while `lab_conf_edit._split_text` split on
`\\r\\n|\\r|\\n`. On LF and CRLF the two are indistinguishable, so the disagreement only ever showed
on a bare CR — and there it did not surface as a parse error. `CONF_LINE_RE`'s `[^"']+` simply
swallowed the following line into the value, so a device silently lost an interface with `errors`
and `warnings` both empty, and the mutilated topology was registered as a successful parse.

A CR-terminated lab.conf is not hypothetical: it is what a classic-Mac editor writes, and what a
botched conversion in transit leaves behind.
"""

import pytest

from kathara_api.services import lab_conf_edit
from kathara_api.services.lab_import import parse_lab_conf

# The same logical lab.conf, written with each of the three terminators.
_LINES = ['pc1[image]="kathara/base"', "pc1[0]=A", "pc2[0]=A"]
_TERMINATORS = ["\n", "\r\n", "\r"]


def _conf(terminator: str) -> str:
    return terminator.join(_LINES) + terminator


@pytest.mark.parametrize("terminator", _TERMINATORS, ids=["lf", "crlf", "cr"])
def test_parser_sees_the_same_topology_under_every_terminator(terminator):
    parsed = parse_lab_conf(_conf(terminator))
    assert parsed.errors == []
    assert sorted(parsed.machines) == ["pc1", "pc2"]
    assert parsed.machines["pc1"].image == "kathara/base"
    assert [i.link for i in parsed.machines["pc1"].interfaces] == ["A"]
    assert [i.link for i in parsed.machines["pc2"].interfaces] == ["A"]


@pytest.mark.parametrize("terminator", _TERMINATORS, ids=["lf", "crlf", "cr"])
def test_editor_and_parser_agree_on_the_devices(terminator):
    """The two modules read the same file: whatever the parser calls a device, the editor's own
    line index must call a device too. This is the assertion the reperto directly negates."""
    text = _conf(terminator)
    assert sorted(lab_conf_edit.LabConfDoc(text).device_names()) == sorted(parse_lab_conf(text).machines)


def test_a_cr_terminated_conf_does_not_swallow_the_next_line():
    """The defect itself: `image` used to come back as `'kathara/base\\rpc1[0]=A'` with no
    interfaces, no error and no warning."""
    parsed = parse_lab_conf("pc1[image]=kathara/base\rpc1[0]=A\r")
    machine = parsed.machines["pc1"]
    assert machine.image == "kathara/base"
    assert [(i.number, i.link) for i in machine.interfaces] == [(0, "A")]
    assert parsed.errors == []
    assert parsed.warnings == []


@pytest.mark.parametrize("terminator", _TERMINATORS, ids=["lf", "crlf", "cr"])
def test_an_untouched_document_round_trips_byte_identically(terminator):
    """`LabConfDoc`'s docstring promises this for a document that was never mutated. It held for LF
    and CRLF only: a CR-terminated file came back rewritten with LF, silently changing a file the
    user never edited."""
    text = _conf(terminator)
    assert lab_conf_edit.LabConfDoc(text).render() == text


@pytest.mark.parametrize("terminator", _TERMINATORS, ids=["lf", "crlf", "cr"])
def test_error_line_numbers_do_not_depend_on_the_terminator(terminator):
    """Guards the diagnostics while the splitting is being changed: `line 2` must be line 2 however
    the file is terminated."""
    text = terminator.join(['pc1[image]="kathara/base"', "!!! not a directive", "pc1[0]=A"]) + terminator
    errors = parse_lab_conf(text).errors
    assert len(errors) == 1
    assert errors[0].startswith('line 2: cannot parse')
