"""Unit tests for on-disk lab persistence (no Docker required).

Covers the LabStore serialization/round-trip, zip extraction (including zip-slip rejection and
the permission bits it does and does not restore), directory read-back, deletion, and the
refusal to overwrite an already-published lab directory.
"""

import os
import stat
import zipfile

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.errors import ApiError, LabAlreadyRegisteredError
from kathara_api.schemas.lab import LabCreate, LabMetadata
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate, PortMapping, Ulimit, VolumeMount
from kathara_api.services import lab_builder, lab_import
from kathara_api.services.lab_store import (
    LabStore,
    conf_value,
    gen_device_lines,
    gen_lab_conf,
    sanitize_lab_name,
)
from tests.helpers import zip_bytes


def _make_lab() -> "LabCreate":
    return LabCreate(
        name="static_routing",
        metadata=LabMetadata(description="Two routers", author="Kathara"),
        machines=[
            MachineCreate(
                name="r1",
                image="kathara/base",
                sysctls={"net.ipv4.ip_forward": 1},
                envs={"FOO": "bar"},
                ports=[PortMapping(host_port=8080, guest_port=80, protocol="tcp")],
                ulimits=[Ulimit(name="nofile", soft=1024, hard=2048)],
                exec_commands=["echo hi"],
                interfaces=[InterfaceAttach(link="A", number=0), InterfaceAttach(link="B", number=1)],
            ),
            MachineCreate(name="pc1", image="kathara/base", interfaces=[InterfaceAttach(link="A", number=0)]),
        ],
    )


def test_sanitize_lab_name_accepts_and_rejects():
    assert sanitize_lab_name(" my-lab_1.2 ") == "my-lab_1.2"
    for bad in ("", ".", "..", "a/b", "a\\b", "x" * 65, "bad name"):
        with pytest.raises(ApiError):
            sanitize_lab_name(bad)


def test_gen_lab_conf_round_trips_through_parser():
    lab = lab_builder.build_lab(_make_lab())
    conf = gen_lab_conf(lab)

    parsed = lab_import.parse_lab_conf(conf)
    assert not parsed.errors
    assert set(parsed.machines.keys()) == {"r1", "pc1"}
    assert parsed.metadata == {"description": "Two routers", "author": "Kathara"}  # no name: see gen_lab_conf

    r1 = parsed.machines["r1"]
    assert r1.image == "kathara/base"
    assert r1.sysctls == {"net.ipv4.ip_forward": 1}
    assert r1.envs == {"FOO": "bar"}
    assert {(i.link, i.number) for i in r1.interfaces} == {("A", 0), ("B", 1)}
    assert [(p.host_port, p.guest_port, p.protocol) for p in r1.ports] == [(8080, 80, "tcp")]
    assert [(u.name, u.soft, u.hard) for u in r1.ulimits] == [("nofile", 1024, 2048)]
    assert r1.execs == ["echo hi"]


def test_write_lab_and_read_lab_round_trip(tmp_path):
    store = LabStore(tmp_path / "labs")
    files = {
        "lab.conf": 'pc1[image]="kathara/base"\npc1[0]="A"\n',
        "pc1.startup": "echo hi\n",
        "pc1/etc/motd": "hello\n",
    }
    store.write_lab("demo", files, dirs=["pc1/var/empty"])

    assert (tmp_path / "labs" / "demo" / "lab.conf").exists()
    assert store.lab_names() == ["demo"]

    read_files, read_dirs = store.read_lab(store.lab_dir("demo"))
    assert read_files == files
    assert "pc1/var/empty" in read_dirs


def test_write_lab_supports_binary_content(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("demo", {"pc1/bin/blob": b"\x00\x01\x02\xff"})
    assert (tmp_path / "labs" / "demo" / "pc1" / "bin" / "blob").read_bytes() == b"\x00\x01\x02\xff"
    # Binary files are skipped on text read-back.
    read_files, _ = store.read_lab(store.lab_dir("demo"))
    assert "pc1/bin/blob" not in read_files


def test_delete_lab_removes_directory(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("demo", {"lab.conf": "pc1[0]=\"A\"\n"})
    assert store.lab_dir("demo").exists()
    store.delete_lab(store.lab_dir("demo"))
    assert not store.lab_dir("demo").exists()
    assert store.lab_names() == []


def test_extract_zip_flat_layout(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "pc1.startup": b"echo hi\n"}))
    assert (tmp_path / "labs" / "demo" / "lab.conf").exists()
    assert (tmp_path / "labs" / "demo" / "pc1.startup").exists()


def test_extract_zip_strips_wrapper_folder(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"mylab/lab.conf": b'pc1[0]="A"\n', "mylab/pc1/etc/motd": b"hi\n"}))
    assert (tmp_path / "labs" / "demo" / "lab.conf").exists()
    assert (tmp_path / "labs" / "demo" / "pc1" / "etc" / "motd").read_bytes() == b"hi\n"


def test_extract_zip_preserves_binary(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "pc1/bin/blob": b"\x00\xff\x00"}))
    assert (tmp_path / "labs" / "demo" / "pc1" / "bin" / "blob").read_bytes() == b"\x00\xff\x00"


def test_extract_zip_rejects_zip_slip(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(ApiError):
        store.extract_zip("demo", zip_bytes({"../evil.txt": b"pwned\n"}))


def test_extract_zip_strips_setuid_setgid_and_sticky_bits(tmp_path):
    """An uploaded archive must not be able to deposit a setuid file in the lab directory.

    `external_attr >> 16` is the archive's full st_mode, and S_ISUID/S_ISGID/S_ISVTX all fall
    inside the range chmod(2) honours — so before the mask, a member recorded as 0o104755 landed
    as a genuinely setuid file, which Kathara then carries into the container at deploy along
    with the rest of `machine.fs`.
    """
    store = LabStore(tmp_path / "labs")
    store.extract_zip(
        "demo",
        zip_bytes(
            {"lab.conf": b'pc1[0]="A"\n', "pc1/bin/evil": b"#!/bin/sh\n"},
            modes={"pc1/bin/evil": 0o4755 | stat.S_ISGID | stat.S_ISVTX},
        ),
    )

    mode = (tmp_path / "labs" / "demo" / "pc1" / "bin" / "evil").stat().st_mode
    assert not mode & stat.S_ISUID
    assert not mode & stat.S_ISGID
    assert not mode & stat.S_ISVTX
    # The permission bits themselves still survive — the mask must not throw away exec (below).
    assert stat.S_IMODE(mode) == 0o755


def test_extract_zip_still_restores_the_execute_bit(tmp_path):
    """The reason modes are preserved at all: an executable startup script stays executable."""
    store = LabStore(tmp_path / "labs")
    store.extract_zip(
        "demo",
        zip_bytes({"lab.conf": b'pc1[0]="A"\n', "pc1.startup": b"echo hi\n"},
                  modes={"pc1.startup": 0o755}),
    )

    assert (tmp_path / "labs" / "demo" / "pc1.startup").stat().st_mode & stat.S_IXUSR


def test_download_upload_round_trip_keeps_the_execute_bit(tmp_path):
    """zip_lab records st_mode (via ZipInfo.from_file), so the round-trip must be mode-preserving
    for the execute bit — this is what stops the setuid mask from being a fixed-mode normalization."""
    store = LabStore(tmp_path / "labs")
    store.write_lab("demo", {"lab.conf": 'pc1[0]="A"\n', "pc1.startup": "echo hi\n"})
    os.chmod(tmp_path / "labs" / "demo" / "pc1.startup", 0o755)

    buf = store.zip_lab(store.lab_dir("demo"))
    store.delete_lab(store.lab_dir("demo"))
    store.extract_zip("demo", buf)

    assert (tmp_path / "labs" / "demo" / "pc1.startup").stat().st_mode & stat.S_IXUSR


@pytest.mark.parametrize("populate", ["write_lab", "extract_zip", "copy_lab_dir"])
def test_publishing_over_an_existing_lab_directory_is_refused(tmp_path, populate):
    """All three populate-a-lab-directory paths are *creation* paths, so a `final` that already
    exists means a concurrent create won this name. Clobbering it — `rmtree(final)` before the
    swap — costs a completed import every one of its files to a racer that goes on to fail with a
    409 anyway, so each path must refuse loudly instead.
    """
    store = LabStore(tmp_path / "labs")
    store.write_lab("demo", {"lab.conf": 'pc1[0]="A"\n', "keepme": "precious\n"})
    source = tmp_path / "example"
    (source / "sub").mkdir(parents=True)
    (source / "lab.conf").write_text('pc9[0]="Z"\n')

    with pytest.raises(LabAlreadyRegisteredError):
        if populate == "write_lab":
            store.write_lab("demo", {"lab.conf": 'pc9[0]="Z"\n'})
        elif populate == "extract_zip":
            store.extract_zip("demo", zip_bytes({"lab.conf": b'pc9[0]="Z"\n'}))
        else:
            store.copy_lab_dir("demo", source)

    # Untouched, and no scratch directory left behind.
    assert (tmp_path / "labs" / "demo" / "keepme").read_text() == "precious\n"
    assert (tmp_path / "labs" / "demo" / "lab.conf").read_text() == 'pc1[0]="A"\n'
    assert [p.name for p in (tmp_path / "labs").iterdir() if p.name.startswith(".")] == []


def test_scratch_directories_are_unique_per_write(tmp_path):
    """Two in-flight writes of the same lab must not share a scratch path: the old
    `.<name>.tmp` spelling had each one `rmtree` the other's tree and then collide on mkdir."""
    store = LabStore(tmp_path / "labs")
    store.ensure_root()
    first = store._new_scratch_dir("demo")
    second = store._new_scratch_dir("demo")

    assert first != second
    assert first.is_dir() and second.is_dir()
    # Hidden, so an in-flight write is never mistaken for an existing lab.
    assert store.lab_names() == []


def test_zip_lab_archives_directory_at_root(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("demo", {"lab.conf": 'pc1[0]="A"\n', "pc1/etc/motd": "hi\n"})
    buf = store.zip_lab(store.lab_dir("demo"))
    with zipfile.ZipFile(buf) as archive:
        names = set(archive.namelist())
        assert "lab.conf" in names  # stored at the archive root, no wrapper folder
        assert "pc1/etc/motd" in names
        assert archive.read("pc1/etc/motd") == b"hi\n"


def test_zip_lab_missing_lab_raises_not_found(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.zip_lab(store.lab_dir("nope"))


def test_read_write_lab_conf_text_round_trips_crlf(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("crlflab", {"lab.conf": "pc1[image]=kathara/base\r\npc1[0]=A\r\n"})

    assert store.read_lab_conf_text(store.lab_dir("crlflab")) == "pc1[image]=kathara/base\r\npc1[0]=A\r\n"

    store.write_lab_conf_text(store.lab_dir("crlflab"), "pc1[image]=kathara/base\r\npc1[0]=A\r\npc1[1]=B\r\n")
    assert store.read_lab_conf_text(store.lab_dir("crlflab")) == "pc1[image]=kathara/base\r\npc1[0]=A\r\npc1[1]=B\r\n"


def test_read_lab_conf_text_absent_or_missing_dir(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("nolabconf")
    assert store.read_lab_conf_text(store.lab_dir("nolabconf")) is None
    assert store.read_lab_conf_text(store.lab_dir("does-not-exist")) is None


def test_write_lab_conf_text_is_atomic_and_requires_existing_dir(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.write_lab_conf_text(store.lab_dir("nosuchlab"), "pc1[image]=kathara/base\n")

    store.ensure_lab_dir("atomiclab")
    store.write_lab_conf_text(store.lab_dir("atomiclab"), "pc1[image]=kathara/base\n")
    lab_dir = store.lab_dir("atomiclab")
    assert (lab_dir / "lab.conf").read_text() == "pc1[image]=kathara/base\n"
    assert not (lab_dir / ".lab.conf.tmp").exists()

# --- generated lab.conf byte-for-byte ------------------------------------------------------------

# Every option this API models, on one device, so the *order* `gen_device_lines` emits them in is
# pinned. That order is not cosmetic: `lab_conf_options.SCALAR_OPTIONS` drives a loop, and the
# container block below it is a hand-written sequence — both decide the bytes that land in a
# user's lab.conf.
#
# No other test asserts more than one scalar at a time, so this is the only thing standing
# between an edit to `SCALAR_OPTIONS` — reordering it, or turning it into a set — and a silent
# rewrite of every JSON-created lab.conf.
_GOLDEN_DEVICE = MachineCreate(
    name="r1",
    image="kathara/frr",
    mem="512m",
    cpus=1.5,
    shell="/bin/bash",
    ipv6=True,
    privileged=True,
    bridged=True,
    num_terms=2,
    entrypoint="/sbin/init",
    args="--foo bar",
    ports=[PortMapping(host_port=8080, guest_port=80, protocol="tcp")],
    envs={"FOO": "bar"},
    sysctls={"net.ipv4.ip_forward": 1},
    ulimits=[Ulimit(name="nofile", soft=1024, hard=2048)],
    volumes=[VolumeMount(host_path="/srv/data", guest_path="/mnt/data", mode="ro")],
    exec_commands=["echo hi"],
    metas={"zz_last": "1", "aa_first": "2"},
    interfaces=[InterfaceAttach(link="A", number=0), InterfaceAttach(link="B", number=1)],
)

_GOLDEN_LINES = [
    # interfaces first, sorted by number
    'r1[0]="A"',
    'r1[1]="B"',
    # image always, always double-quoted
    'r1[image]="kathara/frr"',
    # then SCALAR_OPTIONS, in exactly this order
    "r1[mem]=512m",
    "r1[cpus]=1.5",
    "r1[shell]=/bin/bash",
    "r1[ipv6]=True",
    "r1[privileged]=True",
    "r1[bridged]=True",
    "r1[num_terms]=2",
    "r1[entrypoint]=/sbin/init",
    'r1[args]="--foo bar"',  # quoted only because it contains a space (conf_value)
    # then the container loops, in exactly this order
    'r1[port]="8080:80/tcp"',
    'r1[env]="FOO=bar"',
    'r1[sysctl]="net.ipv4.ip_forward=1"',
    'r1[ulimit]="nofile=1024:2048"',
    'r1[volume]="/srv/data|/mnt/data|ro"',
    'r1[exec]="echo hi"',
    # finally pass-through metas, sorted alphabetically for stable output
    "r1[aa_first]=2",
    "r1[zz_last]=1",
]


def test_gen_device_lines_is_byte_for_byte_stable():
    """Pins the exact rendered block for a device using every modeled option.

    A round-trip test (see `test_gen_lab_conf_round_trips_through_parser`) cannot catch a reordering
    — the parser is order-agnostic — yet a reordering rewrites files the user never edited.
    """
    lab = lab_builder.build_lab(LabCreate(name="golden", machines=[_GOLDEN_DEVICE]))

    assert gen_device_lines(lab.machines["r1"]) == _GOLDEN_LINES


def test_gen_device_lines_omits_unset_scalars_without_disturbing_the_order():
    """The scalar loop skips None/""/False, so a sparsely-configured device must still come out in
    the same relative order — this is what a naive `for key in sorted(...)` would break."""
    lab = lab_builder.build_lab(
        LabCreate(
            name="sparse",
            machines=[MachineCreate(name="pc1", image="kathara/base", shell="/bin/sh", num_terms=3)],
        )
    )

    assert gen_device_lines(lab.machines["pc1"]) == [
        'pc1[image]="kathara/base"',
        "pc1[shell]=/bin/sh",
        "pc1[num_terms]=3",
    ]


# -- extract_zip: archive structure -------------------------------------------------------------


def test_extract_zip_writes_an_absolute_member_inside_the_lab(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"/": b"", "/lab.conf": b'pc1[0]="A"\n', "/pc1/etc/motd": b"hi"}))

    lab = tmp_path / "labs" / "demo"
    assert (lab / "lab.conf").read_bytes() == b'pc1[0]="A"\n'
    assert (lab / "pc1" / "etc" / "motd").read_bytes() == b"hi"


def test_extract_zip_keeps_extracting_after_a_directory_entry(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"pc1/": b"", "lab.conf": b'pc1[0]="A"\n', "pc1/a.txt": b"a"}))

    lab = tmp_path / "labs" / "demo"
    assert (lab / "lab.conf").is_file()
    assert (lab / "pc1" / "a.txt").read_bytes() == b"a"


def test_extract_zip_creates_a_nested_empty_directory_without_its_parents_listed(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"lab.conf": b'pc1[0]="A"\n', "pc1/etc/frr/": b""}))

    assert (tmp_path / "labs" / "demo" / "pc1" / "etc" / "frr").is_dir()


def test_store_root_is_created_with_its_missing_parents(tmp_path):
    store = LabStore(tmp_path / "not" / "yet" / "labs")

    store.ensure_root()
    lab_dir = store.ensure_lab_dir("demo")

    assert lab_dir == tmp_path / "not" / "yet" / "labs" / "demo" and lab_dir.is_dir()


def test_nested_lab_dir_is_created_with_its_missing_parents(tmp_path):
    assert LabStore(tmp_path / "missing" / "labs").ensure_lab_dir("demo").is_dir()


def test_write_lab_accepts_a_directory_its_files_already_created(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("demo", {"lab.conf": 'pc1[0]="A"\n', "pc1/etc/motd": "hi"}, dirs=["pc1/etc", "pc1"])

    assert (tmp_path / "labs" / "demo" / "pc1" / "etc" / "motd").read_text() == "hi"


def test_read_lab_conf_text_accepts_a_file_of_exactly_the_size_ceiling(tmp_path, monkeypatch):
    from kathara_api.services import lab_store as lab_store_module

    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("demo")
    (tmp_path / "labs" / "demo" / "lab.conf").write_text("x" * 64)

    monkeypatch.setattr(lab_store_module, "MAX_LAB_CONF_BYTES", 64)
    assert store.read_lab_conf_text(store.lab_dir("demo")) == "x" * 64
    monkeypatch.setattr(lab_store_module, "MAX_LAB_CONF_BYTES", 63)
    assert store.read_lab_conf_text(store.lab_dir("demo")) is None


# -- conf_value and generated lab.conf text ------------------------------------------------------


@pytest.mark.parametrize("value", ['say "hi"', "it's", "two\nlines", "carriage\rreturn"])
def test_conf_value_refuses_any_character_lab_conf_cannot_hold(value):
    """lab.conf has no escaping: a quote would end the value early and a newline would start a new
    directive, so each of them, on its own, must be refused rather than written."""
    with pytest.raises(ApiError, match="contains a quote or newline"):
        conf_value(value)


@pytest.mark.parametrize(
    "value, rendered",
    [
        ("kathara/base", "kathara/base"),
        (2, "2"),
        (True, "True"),
        ("with space", '"with space"'),
        ("tab\there", '"tab\there"'),
        ("a#b", '"a#b"'),  # unquoted, `#` would start a comment
        ("", '""'),
    ],
)
def test_conf_value_quotes_only_when_the_bare_form_would_be_ambiguous(value, rendered):
    assert conf_value(value) == rendered


def test_gen_device_lines_renders_a_mac_address_and_the_default_image():
    lab = lab_builder.build_lab(
        LabCreate(
            name="macs",
            machines=[MachineCreate(name="pc1", image="", interfaces=[
                InterfaceAttach(link="A", mac_address="02:42:ac:11:00:02"), InterfaceAttach(link="B"),
            ])],
        )
    )

    assert gen_device_lines(lab.machines["pc1"])[:3] == [
        'pc1[0]="A/02:42:ac:11:00:02"',
        'pc1[1]="B"',
        'pc1[image]="kathara/base"',
    ]


def test_gen_device_lines_writes_ipv6_false_but_omits_other_false_flags():
    """ipv6 is three-state: False means "off", which differs from following the global setting."""
    lab = lab_builder.build_lab(
        LabCreate(name="flags", machines=[MachineCreate(name="pc1", image="kathara/base", ipv6=False, privileged=False)])
    )

    assert gen_device_lines(lab.machines["pc1"]) == ['pc1[image]="kathara/base"', "pc1[ipv6]=False"]


def test_gen_device_lines_skips_an_empty_interface_slot_and_keeps_the_rest():
    from types import SimpleNamespace

    def iface(link):
        return SimpleNamespace(link=SimpleNamespace(name=link), mac_address=None)

    device = SimpleNamespace(
        name="pc1",
        interfaces={0: iface("A"), 1: None, 2: iface("C")},
        meta={"image": "kathara/base", "ports": {}, "envs": {}, "sysctls": {}, "ulimits": {}, "volumes": {},
              "exec_commands": []},
    )

    assert gen_device_lines(device)[:2] == ['pc1[0]="A"', 'pc1[2]="C"']


def test_gen_lab_conf_writes_every_metadata_key_but_the_name_then_a_blank_line():
    """LAB_NAME is left out: Kathara's LabParser would re-derive the lab's hash from it, so
    `kathara lstart` in the directory would deploy under a different identity (see lab_id_for)."""
    lab = lab_builder.build_lab(
        LabCreate(
            name="meta",
            metadata=LabMetadata(description="A demo", version="1.0", author="Ann", email="ann@example.org",
                                 web="https://example.org"),
            machines=[MachineCreate(name="pc1", image="kathara/base")],
        )
    )

    assert gen_lab_conf(lab).splitlines()[:7] == [
        'LAB_DESCRIPTION="A demo"',
        "LAB_VERSION=1.0",
        "LAB_AUTHOR=Ann",
        "LAB_EMAIL=ann@example.org",
        "LAB_WEB=https://example.org",
        "",
        'pc1[image]="kathara/base"',
    ]


def test_extract_zip_keeps_a_single_folder_that_has_a_file_beside_it(tmp_path):
    """Only a lone wrapper folder is stripped: a folder with a loose file next to it (a folder-based
    lab's device plus its README) is the lab itself."""
    store = LabStore(tmp_path / "labs")
    store.extract_zip("demo", zip_bytes({"README.md": b"notes", "pc1/etc/motd": b"hi"}))

    lab = tmp_path / "labs" / "demo"
    assert (lab / "README.md").read_bytes() == b"notes"
    assert (lab / "pc1" / "etc" / "motd").read_bytes() == b"hi"


def test_scratch_directory_is_a_hidden_sibling_inside_the_labs_root(tmp_path):
    """Inside the root, so publishing is an atomic rename on one filesystem; dot-prefixed, so a
    scratch directory left behind by a crash is never listed as a lab."""
    store = LabStore(tmp_path / "labs")
    store.ensure_root()

    scratch = store._new_scratch_dir("demo")

    assert scratch.parent == tmp_path / "labs"
    assert scratch.name.startswith(".demo.") and scratch.name.endswith(".tmp")
    assert store.lab_names() == []


def test_read_lab_skips_a_binary_file_without_losing_the_files_after_it(tmp_path, monkeypatch):
    from kathara_api.services import lab_store as lab_store_module

    lab = tmp_path / "lab"
    (lab / "pc1").mkdir(parents=True)
    (lab / "pc1" / "a.bin").write_bytes(b"\xff\xfe\x00")
    (lab / "pc1" / "b.txt").write_text("after")
    real_walk = lab_store_module.os.walk

    def sorted_walk(top):  # directory listing order is arbitrary; make the binary come first
        for root, dirnames, filenames in real_walk(top):
            yield root, dirnames, sorted(filenames)

    monkeypatch.setattr(lab_store_module.os, "walk", sorted_walk)

    files, _ = LabStore(tmp_path / "labs").read_lab(lab)

    assert files == {"pc1/b.txt": "after"}


def test_read_lab_lists_only_empty_directories(tmp_path):
    lab = tmp_path / "lab"
    (lab / "pc1" / "etc").mkdir(parents=True)
    (lab / "pc1" / "etc" / "motd").write_text("hi")
    (lab / "pc2" / "empty").mkdir(parents=True)
    (lab / "shared").mkdir()

    _, dirs = LabStore(tmp_path / "labs").read_lab(lab)

    assert sorted(dirs) == ["pc2/empty", "shared"]


def test_gen_device_lines_omits_every_false_flag_except_ipv6():
    from types import SimpleNamespace

    device = SimpleNamespace(
        name="pc1",
        interfaces={},
        meta={"image": "kathara/base", "ipv6": False, "privileged": False, "bridged": False, "shell": "",
              "ports": {}, "envs": {}, "sysctls": {}, "ulimits": {}, "volumes": {}, "exec_commands": []},
    )

    assert gen_device_lines(device) == ['pc1[image]="kathara/base"', "pc1[ipv6]=False"]


def test_sanitize_lab_name_explains_what_a_name_may_contain():
    with pytest.raises(ApiError, match=r"^Invalid lab name `a/b`\. Use letters, digits, dot, dash or underscore"):
        sanitize_lab_name("a/b")

