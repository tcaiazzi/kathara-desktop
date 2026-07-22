"""Unit tests for on-disk lab persistence (no Docker required).

Covers the LabStore serialization/round-trip, zip extraction (including zip-slip rejection),
directory read-back, and deletion.
"""

import zipfile

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.errors import ApiError
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
