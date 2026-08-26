"""Unit tests for the backend lab.conf/folder import parser (no Docker required)."""

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
    # bridged is now supported (parsed onto the model), so it must NOT be flagged unsupported.
    assert pc1.bridged is True
    assert not any("bridged" in w for w in pc1.unsupported)
    assert any("volume" in w for w in pc1.unsupported)


def test_parse_lab_ext_groups_external_interfaces_by_link():
    links = lab_import.parse_lab_ext("A eth0\nA eth1.100\nB eth2\n")
    by_name = {link.name: link.external for link in links}
    assert by_name == {"A": ["eth0", "eth1.100"], "B": ["eth2"]}


def test_translate_lab_files_builds_payload_and_pending():
    t = lab_import.translate_lab_files(_example_files(), "static_routing")

    assert not t.errors
    assert t.machine_count == 4
    assert set(t.domains) == {"A", "B", "C"}
    assert t.payload.name == "static_routing"
    assert t.payload.metadata.description == "Two routers and two PCs (static routing)"

    names = {m.name for m in t.payload.machines}
    assert names == {"r1", "r2", "pc1", "pc2"}

    assert t.pending["r1"].startup.strip() == R1_STARTUP.strip()
    assert t.pending["pc2"].startup == ""  # no pc2.startup and no shared.startup


def test_translate_lab_files_ignores_shared_folder_with_a_warning():
    # Verbatim import: a `shared/` folder isn't applied to any device (Kathara's own pack_data
    # doesn't pack it, and the /shared bind mount is disabled under Docker-outside-of-Docker) —
    # so it must not be merged into machine files, which would rewrite files that aren't part of
    # any single device's own tree. It stays untouched on disk and is only surfaced as a warning.
    files = {
        **_example_files(),
        "shared/etc/motd": "hello\n",
        "shared.startup": "echo shared\n",
    }
    t = lab_import.translate_lab_files(files, "lab")

    for machine_name in ("r1", "r2", "pc1", "pc2"):
        assert t.pending[machine_name].files == {}

    # r1's own startup is untouched — no shared.startup composed in front of it.
    assert t.pending["r1"].startup == R1_STARTUP

    assert any("shared/" in w for w in t.warnings)


def test_translate_lab_files_merges_machine_specific_files_and_dirs():
    files = {
        **_example_files(),
        "r1/etc/frr/frr.conf": "hostname r1\n",
    }
    t = lab_import.translate_lab_files(files, "lab", dirs=["r1/var/log"])

    assert t.pending["r1"].files == {"/etc/frr/frr.conf": "hostname r1\n"}
    assert t.pending["r1"].dirs == ["/etc", "/etc/frr", "/var", "/var/log"]
    # Only r1 gets its own machine-scoped files.
    assert t.pending["pc1"].files == {}


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
    assert any("frobnicate" in w and "not recognized" in w for w in pc1.unsupported)
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
    # Not folded into the startup script — Kathara's native deploy runs exec_commands on its own.
    assert "echo hi" not in t.pending["pc1"].startup


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


def test_translate_lab_files_volume_is_warned_but_not_applied_to_the_model():
    files = {"lab.conf": 'pc1[image]=kathara/base\npc1[0]=A\npc1[volume]=/host|/mnt|rw\n'}
    t = lab_import.translate_lab_files(files, "lab")
    pc1 = next(m for m in t.payload.machines if m.name == "pc1")
    assert pc1.volumes == []
    assert any("volume" in w and "aren't applied" in w for w in t.warnings)
