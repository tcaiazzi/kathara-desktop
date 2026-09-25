"""Unit tests for the backend lab.conf/folder import parser (no Docker required)."""

import pytest

from kathara_api.schemas.machine import VolumeMount
from kathara_api.services import lab_import

LAB_CONF = """LAB_DESCRIPTION="Two routers and two PCs (static routing)"
LAB_AUTHOR="Kathara"

r1[image]=kathara/base
r1[0]=A
r1[1]=B
r1[sysctl]=net.ipv4.ip_forward=1

r2[image]=kathara/base
r2[0]=C
r2[1]=B
r2[sysctl]=net.ipv4.ip_forward=1

pc1[image]=kathara/base
pc1[0]=A

pc2[image]=kathara/base
pc2[0]=C
"""

R1_STARTUP = "ip address add 195.11.14.1/24 dev eth0\nip route add 200.1.1.0/24 via 100.0.0.10 dev eth1\n"


def _example_files():
    return {
        "lab.conf": LAB_CONF,
        "r1.startup": R1_STARTUP,
        "pc1.startup": "ip address add 195.11.14.5/24 dev eth0\n",
    }


def test_parse_lab_conf_builds_machines_and_metadata():
    parsed = lab_import.parse_lab_conf(LAB_CONF)

    assert not parsed.errors
    assert set(parsed.machines.keys()) == {"r1", "r2", "pc1", "pc2"}
    assert parsed.metadata == {"description": "Two routers and two PCs (static routing)", "author": "Kathara"}
    r1 = parsed.machines["r1"]
    assert r1.image == "kathara/base"
    assert r1.sysctls == {"net.ipv4.ip_forward": 1}
    assert {(i.link, i.number) for i in r1.interfaces} == {("A", 0), ("B", 1)}


def test_parse_lab_conf_reports_non_sequential_interfaces():
    parsed = lab_import.parse_lab_conf("pc1[0]=a\npc1[2]=b\n")
    assert any("non-sequential" in e for e in parsed.errors)


def test_parse_lab_conf_reports_invalid_port_and_sysctl():
    parsed = lab_import.parse_lab_conf("pc1[port]=notaport\npc1[sysctl]=bogus\n")
    assert any("invalid port" in e for e in parsed.errors)
    assert any("invalid sysctl" in e for e in parsed.errors)


def test_parse_lab_conf_flags_unsupported_options():
    parsed = lab_import.parse_lab_conf("pc1[bridged]=true\npc1[volume]=/h|/g|rw\n")
    pc1 = parsed.machines["pc1"]
    # bridged is supported (parsed onto the model), so it must NOT be flagged unsupported.
    assert pc1.bridged is True
    assert not any("bridged" in w for w in pc1.unsupported)
    # volume is supported too (see _parse_volume) — applied to the model, not flagged.
    assert pc1.volumes == [VolumeMount(host_path="/h", guest_path="/g", mode="rw")]
    assert not any("volume" in w for w in pc1.unsupported)


def test_parse_lab_ext_groups_external_interfaces_by_link():
    links = lab_import.parse_lab_ext("A eth0\nA eth1.100\nB eth2\n")
    by_name = {link.name: link.external for link in links}
    assert by_name == {"A": ["eth0", "eth1.100"], "B": ["eth2"]}


def test_translate_lab_files_builds_payload():
    t = lab_import.translate_lab_files(_example_files(), "static_routing")

    assert not t.errors
    assert t.machine_count == 4
    assert set(t.domains) == {"A", "B", "C"}
    assert t.payload.name == "static_routing"
    assert t.payload.metadata.description == "Two routers and two PCs (static routing)"

    names = {m.name for m in t.payload.machines}
    assert names == {"r1", "r2", "pc1", "pc2"}


def test_translate_lab_files_never_makes_shared_a_machine():
    # `shared` is a RESERVED_NAME: neither a top-level `shared/` folder nor a `shared.startup`
    # may be mistaken for a device, which is exactly what the folder-fallback path below would
    # otherwise do with them. Nothing to translate and nothing to complain about either — the
    # files land on disk verbatim (KatharaService._adopt_populated_dir) and Kathara's own
    # deploy() picks the folder up natively, so this is silent rather than a warning.
    files = {
        **_example_files(),
        "shared/etc/motd": "hello\n",
        "shared.startup": "echo shared\n",
    }
    t = lab_import.translate_lab_files(files, "lab")

    assert "shared" not in {m.name for m in t.payload.machines}
    assert t.warnings == []


def test_translate_lab_files_folder_fallback_without_lab_conf():
    files = {"pc1.startup": "echo hi\n", "pc2/etc/motd": "hi\n"}
    t = lab_import.translate_lab_files(files, "lab")

    assert t.machine_count == 2
    assert set(m.name for m in t.payload.machines) == {"pc1", "pc2"}
    assert any("no lab.conf" in w for w in t.warnings)


def test_translate_lab_files_reports_errors_when_nothing_found():
    t = lab_import.translate_lab_files({}, "lab")
    assert t.machine_count == 0
    assert any("no lab.conf" in e for e in t.errors)


def test_folder_fallback_names_the_directory_it_cannot_use_as_a_device():
    """A subfolder that doesn't fit the device-name grammar is a parse error naming that folder,
    the way a malformed directive line is — not a schema violation raised later from
    `MachineCreate`, which reports a pattern mismatch without saying which directory caused it."""
    t = lab_import.translate_lab_files({"Router1/etc/motd": "hi\n", "pc2/etc/motd": "hi\n"}, "lab")

    assert any('"Router1"' in e for e in t.errors)
    assert {m.name for m in t.payload.machines} == {"pc2"}


def test_folder_fallback_refuses_rather_than_dropping_an_unusable_device_folder():
    """Every unusable folder is reported, and one alone is still an error: skipping would lose a
    device the lab meant to have, leaving a silently incomplete topology."""
    t = lab_import.translate_lab_files({"Router1/etc/motd": "hi\n", "SW-2/etc/motd": "hi\n"}, "lab")

    assert len(t.errors) == 2
    assert t.machine_count == 0


def test_folder_fallback_ignores_tooling_directories():
    """A dot-prefixed directory is tooling (a checked-out `.git`, an editor's state), not a device,
    and must neither become one nor block the import — the rule `LabStore.lab_names` applies when
    it lists labs."""
    files = {"pc1/etc/motd": "hi\n", ".git/config": "[core]\n", ".vscode/settings.json": "{}\n"}
    t = lab_import.translate_lab_files(files, "lab")

    assert t.errors == []
    assert {m.name for m in t.payload.machines} == {"pc1"}


def test_translate_lab_files_surfaces_skipped_binary_warning():
    t = lab_import.translate_lab_files(_example_files(), "lab", skipped=["pc1/bin/tool"])
    assert any("skipped 1 binary" in w for w in t.warnings)


def test_parse_lab_conf_maps_num_terms_entrypoint_args():
    parsed = lab_import.parse_lab_conf(
        'pc1[num_terms]=2\npc1[entrypoint]="/sbin/custom-init"\npc1[args]="--verbose"\n'
    )
    pc1 = parsed.machines["pc1"]
    assert pc1.num_terms == 2
    assert pc1.entrypoint == "/sbin/custom-init"
    assert pc1.args == "--verbose"
    assert not pc1.unsupported


def test_parse_lab_conf_keeps_unknown_option_as_pass_through_meta():
    parsed = lab_import.parse_lab_conf("pc1[frobnicate]=yes\n")
    pc1 = parsed.machines["pc1"]
    assert pc1.metas == {"frobnicate": "yes"}
    assert any("pc1[frobnicate]" in w and "not a recognized option" in w for w in pc1.unsupported)
    assert not parsed.errors  # unknown options are never fatal


def test_parse_lab_conf_unrecognized_top_level_line_is_a_warning_not_an_error():
    # A hard error here would make KatharaService._translate_lab_dir drop the whole lab from the
    # registry on the next restart (see translate_lab_files) — only an unrepresentable topology
    # should be fatal.
    parsed = lab_import.parse_lab_conf('LAB_DESCRIPTION="ok"\nLAB_LICENCE="x"\n')
    assert parsed.errors == []
    assert any('LAB_LICENCE' in w for w in parsed.warnings)
    assert parsed.metadata == {"description": "ok"}


def test_parse_lab_conf_still_rejects_genuinely_unparseable_lines():
    parsed = lab_import.parse_lab_conf("this is not a valid line at all\n")
    assert any("cannot parse" in e for e in parsed.errors)


def test_translate_lab_files_keeps_exec_commands_in_the_model():
    files = {**_example_files(), "lab.conf": LAB_CONF.replace('pc1[0]=A', 'pc1[0]=A\npc1[exec]="echo hi"')}
    t = lab_import.translate_lab_files(files, "lab")

    pc1 = next(m for m in t.payload.machines if m.name == "pc1")
    assert pc1.exec_commands == ["echo hi"]


def test_translate_lab_files_carries_num_terms_entrypoint_args_and_metas():
    files = {
        "lab.conf": (
            'pc1[image]=kathara/base\npc1[0]=A\npc1[num_terms]=2\n'
            'pc1[entrypoint]=/sbin/init\npc1[args]=--verbose\npc1[frobnicate]=yes\n'
        )
    }
    t = lab_import.translate_lab_files(files, "lab")
    pc1 = next(m for m in t.payload.machines if m.name == "pc1")
    assert pc1.num_terms == 2
    assert pc1.entrypoint == "/sbin/init"
    assert pc1.args == "--verbose"
    assert pc1.metas == {"frobnicate": "yes"}
    assert any("frobnicate" in w for w in t.warnings)


def test_translate_lab_files_volume_is_applied_to_the_model():
    files = {"lab.conf": 'pc1[image]=kathara/base\npc1[0]=A\npc1[volume]=/host|/mnt|rw\n'}
    t = lab_import.translate_lab_files(files, "lab")
    pc1 = next(m for m in t.payload.machines if m.name == "pc1")
    assert pc1.volumes == [VolumeMount(host_path="/host", guest_path="/mnt", mode="rw")]
    assert not any("volume" in w for w in t.warnings)


def test_parse_lab_conf_volume_two_field_form_defaults_to_ro():
    # Kathara's own Machine.add_meta defaults mode to "ro" for the 2-field form — matched here so
    # a lab.conf parsed by this API behaves like one parsed by the Kathara CLI itself.
    parsed = lab_import.parse_lab_conf("pc1[volume]=/host|/mnt\n")
    assert parsed.machines["pc1"].volumes == [VolumeMount(host_path="/host", guest_path="/mnt", mode="ro")]


def test_parse_lab_conf_malformed_volume_is_an_error():
    parsed = lab_import.parse_lab_conf("pc1[volume]=bad\n")
    assert any("invalid volume" in e for e in parsed.errors)
    assert parsed.machines["pc1"].volumes == []


def test_parse_lab_conf_volume_with_relative_host_path_is_an_error():
    # Same VolumeMount validation the JSON path already gets — a relative host_path is silently
    # relative to the API process's own cwd otherwise (see schemas/machine.py).
    parsed = lab_import.parse_lab_conf("pc1[volume]=data|/mnt|rw\n")
    assert any("invalid volume" in e for e in parsed.errors)
    assert parsed.machines["pc1"].volumes == []


# -- every parsed option reaches the payload -------------------------------------------------------

FULL_DEVICE_CONF = """r1[0]=A/02:42:ac:11:00:02
r1[1]=B
r1[image]=kathara/frr
r1[cpus]=1.5
r1[ipv6]=false
r1[shell]=/bin/sh
r1[privileged]=yes
r1[port]=8080:80/udp
r1[env]=MODE=a=b
r1[sysctl]=net.ipv4.ip_forward=1
r1[sysctl]=net.core.default_qdisc=fq
r1[ulimit]=nofile=1024
"""


def test_translate_lab_files_carries_every_parsed_option_into_the_payload():
    [machine] = lab_import.translate_lab_files({"lab.conf": FULL_DEVICE_CONF}, "demo").payload.machines

    assert machine.image == "kathara/frr"
    assert machine.cpus == 1.5
    assert machine.ipv6 is False
    assert machine.shell == "/bin/sh"
    assert machine.privileged is True
    assert [(p.host_port, p.guest_port, p.protocol) for p in machine.ports] == [(8080, 80, "udp")]
    assert machine.envs == {"MODE": "a=b"}  # split on the first '=' only
    assert machine.sysctls == {"net.ipv4.ip_forward": 1, "net.core.default_qdisc": "fq"}  # int when numeric
    assert [(u.name, u.soft, u.hard) for u in machine.ulimits] == [("nofile", 1024, 1024)]  # hard defaults to soft
    assert [(i.link, i.number, i.mac_address) for i in machine.interfaces] == [
        ("A", 0, "02:42:ac:11:00:02"),
        ("B", 1, None),
    ]


def test_translate_lab_files_turns_lab_ext_into_external_links_and_domains():
    t = lab_import.translate_lab_files(
        {"lab.conf": "pc1[0]=A\n", "lab.ext": "# uplinks\n\nA eth0\nWAN eth1.100\n"}, "demo"
    )

    assert [(link.name, link.external) for link in t.payload.links] == [("A", ["eth0"]), ("WAN", ["eth1.100"])]
    assert t.domains == ["A", "WAN"]


def test_translate_lab_files_without_lab_ext_declares_no_external_links():
    assert lab_import.translate_lab_files({"lab.conf": "pc1[0]=A\n"}, "demo").payload.links == []


def test_parse_lab_ext_skips_comments_blank_and_malformed_lines_and_reads_on():
    links = lab_import.parse_lab_ext("# header\n\nnot a valid line at all\nA eth0\n\n# more\nB eth1\n")

    assert [(link.name, link.external) for link in links] == [("A", ["eth0"]), ("B", ["eth1"])]


# -- value parsers ----------------------------------------------------------------------------------


@pytest.mark.parametrize("value", ["y", "yes", "t", "true", "on", "1", "YES", " True ", "On"])
def test_parse_bool_reads_every_true_spelling(value):
    assert lab_import._parse_bool(value) is True


@pytest.mark.parametrize("value", ["n", "no", "f", "false", "off", "0", "NO", " False ", "Off"])
def test_parse_bool_reads_every_false_spelling(value):
    assert lab_import._parse_bool(value) is False


@pytest.mark.parametrize("value", ["maybe", "", "2", "yess"])
def test_parse_bool_leaves_anything_else_undecided(value):
    assert lab_import._parse_bool(value) is None


def test_boolean_options_apply_only_a_clear_answer():
    parsed = lab_import.parse_lab_conf(
        "a[privileged]=yes\nb[privileged]=no\nc[privileged]=maybe\nd[ipv6]=maybe\ne[ipv6]=on\n"
    )
    m = parsed.machines

    assert (m["a"].privileged, m["b"].privileged, m["c"].privileged) == (True, False, False)
    assert (m["d"].ipv6, m["e"].ipv6) == (None, True)  # three-state: undecided stays unset
    assert parsed.errors == []


@pytest.mark.parametrize(
    "value, expected",
    [
        ("80", (3000, 80, "tcp")),
        ("8080:80", (8080, 80, "tcp")),
        ("8080:80/udp", (8080, 80, "udp")),
        ("8080:80/SCTP", (8080, 80, "sctp")),
        ("8080:80/", (8080, 80, "tcp")),
    ],
)
def test_parse_port_reads_every_shape(value, expected):
    port = lab_import._parse_port(value)
    assert (port.host_port, port.guest_port, port.protocol) == expected


@pytest.mark.parametrize("value", ["8080:80/icmp", "a:80", "8080:b", "1:2:3", "80/tcp/x", "0:80", "70000:80"])
def test_parse_port_rejects_malformed_or_out_of_range_ports(value):
    assert lab_import._parse_port(value) is None


# -- parse_lab_conf: messages, line numbers, and carrying on past a bad line -----------------------


def test_every_option_error_names_its_line_and_value():
    parsed = lab_import.parse_lab_conf(
        "pc1[image]=kathara/base\npc1[cpus]=two\npc1[env]==x\npc1[ulimit]=nofile\npc1[sysctl]=net.a.b=1=2\n"
    )

    assert parsed.errors == [
        'line 2: invalid cpus "two"',
        'line 3: invalid env "=x"',
        'line 4: invalid ulimit "nofile"',
    ]
    # `=` splits once: the key is net.a.b and "1=2" is its (string) value.
    assert parsed.machines["pc1"].sysctls == {"net.a.b": "1=2"}


def test_a_non_integer_num_terms_is_reported_as_unsupported_with_its_line():
    parsed = lab_import.parse_lab_conf("pc1[image]=kathara/base\npc1[num_terms]=many\n")

    assert parsed.errors == []
    assert parsed.machines["pc1"].unsupported == [
        "pc1[num_terms] (line 2) — not an integer, kept in lab.conf but not applied"
    ]


def test_an_unrecognized_option_is_reported_as_unsupported_with_its_line():
    parsed = lab_import.parse_lab_conf("pc1[colour]=blue\n")

    assert parsed.machines["pc1"].unsupported == [
        "pc1[colour] (line 1) — not a recognized option, kept in lab.conf but not applied"
    ]


@pytest.mark.parametrize(
    "bad_line, error",
    [
        ("shared[0]=A", 'line 1: "shared" is a reserved name'),
        ("pc1[0]=A/b/c", 'line 1: invalid interface "A/b/c"'),
        ("pc1[0]=A-B", 'line 1: invalid collision domain "A-B"'),
    ],
)
def test_parsing_carries_on_after_a_bad_line(bad_line, error):
    parsed = lab_import.parse_lab_conf(f"{bad_line}\npc2[image]=kathara/frr\npc2[0]=A\n")

    assert parsed.errors == [error]
    assert parsed.machines["pc2"].image == "kathara/frr"
    assert [i.link for i in parsed.machines["pc2"].interfaces] == ["A"]


def test_lab_metadata_value_may_contain_an_equals_sign():
    parsed = lab_import.parse_lab_conf('LAB_DESCRIPTION="a=b, c=d"\nLAB_WEB = https://example.org/?x=1\n')

    assert parsed.errors == []
    assert parsed.metadata == {"description": "a=b, c=d", "web": "https://example.org/?x=1"}


# -- translate_lab_files: folder fallback and skipped files ----------------------------------------


def test_folder_fallback_warns_exactly_once_that_it_derived_the_devices():
    t = lab_import.translate_lab_files({"pc1/etc/motd": "hi"}, "demo")

    assert t.errors == []
    assert t.warnings == ["no lab.conf — machines derived from folders (no interfaces defined)"]


def test_an_empty_lab_directory_says_what_it_looked_for():
    assert lab_import.translate_lab_files({}, "demo").errors == ["no lab.conf and no machine folders found"]


def test_folder_fallback_explains_the_device_name_grammar():
    t = lab_import.translate_lab_files({"PC-1/etc/motd": "hi"}, "demo")

    assert t.errors == [
        'directory "PC-1" is not a usable device name (lowercase letters, digits and underscores, up to 30 characters)'
    ]


@pytest.mark.parametrize(
    "skipped, warning",
    [
        (["a.bin", "b.bin", "c.bin", "d.bin"], "skipped 4 binary/non-UTF-8 file(s): a.bin, b.bin, c.bin, d.bin"),
        (["a", "b", "c", "d", "e"], "skipped 5 binary/non-UTF-8 file(s): a, b, c, d…"),
    ],
)
def test_skipped_files_warning_lists_at_most_four_names(skipped, warning):
    t = lab_import.translate_lab_files({"lab.conf": "pc1[0]=A\n"}, "demo", skipped=skipped)

    assert t.warnings == [warning]


@pytest.mark.parametrize("value", ["kernel.shmmax=1", "net.ip_forward=1", "=1", "net.ipv4.ip_forward"])
def test_a_sysctl_outside_net_or_malformed_is_an_error(value):
    parsed = lab_import.parse_lab_conf(f"pc1[sysctl]={value}\n")

    assert parsed.errors == [f'line 1: invalid sysctl "{value}" (must be net.*=value)']
    assert parsed.machines["pc1"].sysctls == {}


def test_a_single_letter_top_level_key_is_kept_with_a_warning():
    parsed = lab_import.parse_lab_conf("X=1\n")

    assert parsed.errors == []
    assert parsed.warnings == ['line 1: unknown key "X" — kept in lab.conf, not applied']
