"""The shared lab.conf vocabulary, and the two contracts it exists to enforce.

`lab_conf_options` is the one place the option names are spelled; the parser, the renderer, the
in-place editor, the request schema and the frontend editor all derive from it. Hand-maintained
copies drift — an option interpreted by the parser but not reserved by the request schema is
accepted as a pass-through meta and comes back as the real option on the next load, which is what
`cpu` reaching `cpus` does. These tests check the two properties that derivation is supposed to
buy, so an edit to the module cannot quietly give them up.
"""

import pathlib
import re

import pytest

from kathara_api.lab_conf_options import (
    GROUP_OPTIONS,
    IMAGE_KEY,
    INTERPRETED_OPTIONS,
    MODELED_META_KEYS,
    OPTION_ALIASES,
    SCALAR_OPTIONS,
)
from kathara_api.services.lab_import import parse_lab_conf

# A syntactically valid value per option, so each can be fed through the real parser.
_VALID_VALUES = {
    "image": "kathara/base",
    "mem": "256m",
    "cpus": "1.5",
    "cpu": "2",
    "shell": "/bin/sh",
    "ipv6": "true",
    "privileged": "true",
    "bridged": "true",
    "num_terms": "2",
    "entrypoint": "/sbin/init",
    "args": "foo",
    "port": "8080:80",
    "env": "A=1",
    "sysctl": "net.ipv4.ip_forward=1",
    "ulimit": "nofile=1024:2048",
    "volume": "/srv|/mnt|ro",
    "exec": "echo hi",
}


def test_every_interpreted_option_has_a_valid_value_in_this_test():
    """Guards the table above: a new option added to the module must be given a value here, or the
    parametrized test below would silently skip it."""
    assert set(_VALID_VALUES) == set(INTERPRETED_OPTIONS)


@pytest.mark.parametrize("option", sorted(INTERPRETED_OPTIONS))
def test_every_interpreted_option_is_actually_applied(option):
    """`_apply_conf_option` now *gates* on INTERPRETED_OPTIONS instead of merely agreeing with it,
    so a name listed there but with no branch in the chain would fall through and do nothing at
    all — no error, no warning, no effect. This is the test for that failure mode."""
    parsed = parse_lab_conf(f"pc1[{option}]={_VALID_VALUES[option]}")

    machine = parsed.machines["pc1"]
    assert parsed.errors == [], f"`{option}` is listed as interpreted but the parser rejected it"
    assert machine.metas == {}, f"`{option}` is listed as interpreted but fell through to metas"
    assert machine.unsupported == [], f"`{option}` is listed as interpreted but was warned about"


@pytest.mark.parametrize("alias,canonical", sorted(OPTION_ALIASES.items()))
def test_an_alias_reaches_the_same_field_as_its_canonical_name(alias, canonical):
    """Why aliases have to be reserved as tightly as the name they resolve to."""
    via_alias = parse_lab_conf(f"pc1[{alias}]={_VALID_VALUES[alias]}").machines["pc1"]
    via_canonical = parse_lab_conf(f"pc1[{canonical}]={_VALID_VALUES[alias]}").machines["pc1"]

    assert getattr(via_alias, canonical) == getattr(via_canonical, canonical)
    assert via_alias.metas == {}


def test_interpreted_options_are_all_reserved():
    """Structural rather than hoped for: anything the parser will consume on the next load
    cannot be accepted as a pass-through `metas` entry today."""
    assert INTERPRETED_OPTIONS <= MODELED_META_KEYS


# --- the frontend mirror --------------------------------------------------------------------------

_EDITOR_LANGUAGE_TS = (
    pathlib.Path(__file__).resolve().parents[2] / "services" / "frontend" / "src" / "services" / "editorLanguage.ts"
)


def _ts_option_keywords(source: str) -> set[str]:
    """Pull `OPTION_KEYWORDS`' effective contents out of the TypeScript source.

    It is spelled `[...MAPPED_OPTIONS, "num_terms", ...PASSTHROUGH_OPTIONS]`, so the two spread
    arrays are resolved and any inline literal is added.
    """
    arrays = {
        name: re.search(rf"export const {name} = \[(.*?)\]", source, re.S).group(1)
        for name in ("MAPPED_OPTIONS", "PASSTHROUGH_OPTIONS", "OPTION_KEYWORDS")
    }
    keywords = set(re.findall(r'"([^"]+)"', arrays["OPTION_KEYWORDS"]))
    for spread in re.findall(r"\.\.\.(\w+)", arrays["OPTION_KEYWORDS"]):
        keywords |= set(re.findall(r'"([^"]+)"', arrays[spread]))
    return keywords


@pytest.mark.skipif(not _EDITOR_LANGUAGE_TS.exists(), reason="frontend sources not present")
def test_the_frontend_editor_vocabulary_matches_the_backend():
    """`editorLanguage.ts:4-9` declares that it mirrors this parser, and the lab.conf linter and
    autocomplete are built on it — but nothing checked it until now. An option added to one side
    only means the editor either flags a valid line or waves through an invalid one.

    Kept as a source-reading test rather than a generated file: one source of truth stays in
    Python, and the TypeScript stays readable on its own.
    """
    assert _ts_option_keywords(_EDITOR_LANGUAGE_TS.read_text()) == set(INTERPRETED_OPTIONS)


def test_the_render_order_constants_have_not_been_turned_into_sets():
    """`SCALAR_OPTIONS` and `GROUP_OPTIONS` decide the order options are written to disk. A `set`
    or `frozenset` would still satisfy every membership use in the codebase while silently making
    the output order arbitrary between runs."""
    assert isinstance(SCALAR_OPTIONS, tuple)
    assert isinstance(GROUP_OPTIONS, dict)
    assert IMAGE_KEY not in SCALAR_OPTIONS, "image is rendered separately, always and always quoted"
