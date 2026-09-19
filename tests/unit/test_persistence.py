"""Unit tests for lab on-disk persistence wired into KatharaService (no Docker required).

Verifies create/import write a lab directory, a fresh service reloads them from disk (restart
survival), and delete removes the directory.
"""

from kathara_api.schemas.lab import LabCreate, LabMetadata
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate
from kathara_api.services.lab_store import LabStore
from tests.helpers import make_lab, make_service



def test_create_lab_writes_directory(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    service.create_lab(
        LabCreate(
            name="jsonlab",
            metadata=LabMetadata(description="from json"),
            machines=[MachineCreate(name="pc1", image="kathara/base", interfaces=[InterfaceAttach(link="A", number=0)])],
        )
    )
    assert (store.lab_dir("jsonlab") / "lab.conf").exists()


def test_create_lab_registers_under_the_sanitized_name(tmp_path):
    """A name `sanitize_lab_name` trims (e.g. surrounding whitespace) must register the Lab under
    the *same* trimmed name the directory is created under — every import path already gets this
    right by passing a pre-cleaned name through to the LabCreate it builds; this JSON path used to
    keep the raw, untrimmed name on the model while creating the directory under the trimmed one,
    so the lab was unreachable by its own (trimmed) name until a restart re-read it from disk."""
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    service.create_lab(
        LabCreate(name=" demo ", machines=[MachineCreate(name="pc1", image="kathara/base")])
    )

    assert (store.lab_dir("demo") / "lab.conf").exists()
    lab = service.registry.get("demo")
    assert lab is not None
    assert lab.name == "demo"
    assert service.registry.get(" demo ") is None

    # Survives a restart too: a fresh service reloading the same on-disk store must find the lab
    # under the same "demo" name, not rename it out from under a caller who registered it earlier.
    restarted = make_service(store)
    assert restarted.registry.get("demo") is not None


def test_import_lab_materializes_onto_native_fs(tmp_path):
    """A machine's own files land under its own directory, and its `<name>.startup` is written
    verbatim. `shared/` lands verbatim too, but is never merged into a device's own tree (see
    lab_import.translate_lab_files): it is not a per-machine concept, and Kathara's own deploy()
    applies it natively from where it sits.
    """
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    files = {
        "lab.conf": 'r1[image]="kathara/base"\nr1[0]="A"\n',
        "r1.startup": "ip a\n",
        "r1/etc/frr/frr.conf": "hostname r1\n",
        "shared/etc/motd": "hi\n",
    }
    lab, warnings = make_lab(service, "imported", files, [])
    lab_dir = store.lab_dir("imported")
    assert (lab_dir / "lab.conf").exists()
    assert 'r1[image]="kathara/base"' in (lab_dir / "lab.conf").read_text()
    assert (lab_dir / "r1.startup").read_text().strip() == "ip a"
    assert (lab_dir / "r1" / "etc" / "frr" / "frr.conf").read_text() == "hostname r1\n"
    assert not (lab_dir / "r1" / "etc" / "motd").exists()
    assert (lab_dir / "shared" / "etc" / "motd").read_text() == "hi\n"
    assert warnings == []


def test_labs_reload_from_disk_on_fresh_service(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    make_lab(service, "imported", {"lab.conf": 'r1[image]="kathara/base"\nr1[0]="A"\n', "r1.startup": "ip a\n"}, [])
    service.create_lab(
        LabCreate(name="jsonlab", machines=[MachineCreate(name="pc1", image="kathara/base")])
    )

    # A brand-new service (simulating a restart) sees the same labs, rebuilt from disk.
    fresh = make_service(LabStore(tmp_path / "labs"))
    assert set(fresh.registry.names()) == {"imported", "jsonlab"}
    # The startup script is a real file on disk — nothing needs reconstructing to see it.
    assert fresh.get_startup_scripts("imported")["r1"].strip() == "ip a"


def test_delete_lab_removes_directory(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    service.create_lab(LabCreate(name="jsonlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))
    assert store.lab_dir("jsonlab").exists()

    service.delete_lab("jsonlab")
    assert not store.lab_dir("jsonlab").exists()


def test_offline_fs_edit_writes_through_to_disk_before_any_deploy(tmp_path):
    """A queued files/dirs edit must survive a restart even for a lab that has never been
    deployed — not just at deploy time."""
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    service.create_lab(LabCreate(name="jsonlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))

    service.fs_write_text_offline("jsonlab", "/pc1/etc/motd", "edited\n")
    service.fs_mkdir_offline("jsonlab", "/pc1/var/log")

    lab_dir = store.lab_dir("jsonlab")
    assert (lab_dir / "pc1" / "etc" / "motd").read_text() == "edited\n"
    assert (lab_dir / "pc1" / "var" / "log").is_dir()

    # Simulated restart: a fresh service still sees the edit — it's a real file, not a cache.
    fresh = make_service(LabStore(tmp_path / "labs"))
    assert fresh.fs_read_text_offline("jsonlab", "/pc1/etc/motd") == "edited\n"
