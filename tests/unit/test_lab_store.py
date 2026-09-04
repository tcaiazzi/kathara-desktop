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
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate, PortMapping, Ulimit
from kathara_api.services import lab_builder, lab_import
from kathara_api.services.lab_store import LabStore, gen_lab_conf, sanitize_lab_name
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
    assert parsed.metadata == {"name": "static_routing", "description": "Two routers", "author": "Kathara"}

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
    store.delete_lab("demo")
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

    buf = store.zip_lab("demo")
    store.delete_lab("demo")
    store.extract_zip("demo", buf)

    assert (tmp_path / "labs" / "demo" / "pc1.startup").stat().st_mode & stat.S_IXUSR


@pytest.mark.parametrize("populate", ["write_lab", "extract_zip", "copy_lab_dir"])
def test_publishing_over_an_existing_lab_directory_is_refused(tmp_path, populate):
    """All three populate-a-lab-directory paths are *creation* paths, and each used to
    `rmtree(final)` before its swap — which is how a completed import lost every one of its files
    to a concurrent create that then failed with a 409 anyway. Refused loudly instead.
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
    buf = store.zip_lab("demo")
    with zipfile.ZipFile(buf) as archive:
        names = set(archive.namelist())
        assert "lab.conf" in names  # stored at the archive root, no wrapper folder
        assert "pc1/etc/motd" in names
        assert archive.read("pc1/etc/motd") == b"hi\n"


def test_zip_lab_missing_lab_raises_not_found(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.zip_lab("nope")


def test_read_write_lab_conf_text_round_trips_crlf(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.write_lab("crlflab", {"lab.conf": "pc1[image]=kathara/base\r\npc1[0]=A\r\n"})

    assert store.read_lab_conf_text("crlflab") == "pc1[image]=kathara/base\r\npc1[0]=A\r\n"

    store.write_lab_conf_text("crlflab", "pc1[image]=kathara/base\r\npc1[0]=A\r\npc1[1]=B\r\n")
    assert store.read_lab_conf_text("crlflab") == "pc1[image]=kathara/base\r\npc1[0]=A\r\npc1[1]=B\r\n"


def test_read_lab_conf_text_absent_or_missing_dir(tmp_path):
    store = LabStore(tmp_path / "labs")
    store.ensure_lab_dir("nolabconf")
    assert store.read_lab_conf_text("nolabconf") is None
    assert store.read_lab_conf_text("does-not-exist") is None


def test_write_lab_conf_text_is_atomic_and_requires_existing_dir(tmp_path):
    store = LabStore(tmp_path / "labs")
    with pytest.raises(LabNotFoundError):
        store.write_lab_conf_text("nosuchlab", "pc1[image]=kathara/base\n")

    store.ensure_lab_dir("atomiclab")
    store.write_lab_conf_text("atomiclab", "pc1[image]=kathara/base\n")
    lab_dir = store.lab_dir("atomiclab")
    assert (lab_dir / "lab.conf").read_text() == "pc1[image]=kathara/base\n"
    assert not (lab_dir / ".lab.conf.tmp").exists()
