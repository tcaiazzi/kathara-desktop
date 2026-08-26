"""Unit tests for lab on-disk persistence wired into KatharaService (no Docker required).

Verifies create/import write a lab directory, a fresh service reloads them from disk (restart
survival), and delete removes the directory.
"""

from kathara_api.schemas.lab import LabCreate, LabMetadata
from kathara_api.schemas.machine import InterfaceAttach, MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


def _service(store: LabStore) -> KatharaService:
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()
    return service


def test_create_lab_writes_directory(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    service.create_lab(
        LabCreate(
            name="jsonlab",
            metadata=LabMetadata(description="from json"),
            machines=[MachineCreate(name="pc1", image="kathara/base", interfaces=[InterfaceAttach(link="A", number=0)])],
        )
    )
    assert (store.lab_dir("jsonlab") / "lab.conf").exists()


def test_import_lab_materializes_onto_native_fs(tmp_path):
    """A machine's own files land under its own directory, and its `<name>.startup` is written
    verbatim. `shared/` is out of scope for now (see lab_import.translate_lab_files): it is
    neither merged into any device's tree nor otherwise applied, and is reported as a warning.
    """
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    files = {
        "lab.conf": 'r1[image]="kathara/base"\nr1[0]="A"\n',
        "r1.startup": "ip a\n",
        "r1/etc/frr/frr.conf": "hostname r1\n",
        "shared/etc/motd": "hi\n",
    }
    lab, warnings = service.import_lab("imported", files, [])
    lab_dir = store.lab_dir("imported")
    assert (lab_dir / "lab.conf").exists()
    assert 'r1[image]="kathara/base"' in (lab_dir / "lab.conf").read_text()
    assert (lab_dir / "r1.startup").read_text().strip() == "ip a"
    assert (lab_dir / "r1" / "etc" / "frr" / "frr.conf").read_text() == "hostname r1\n"
    assert not (lab_dir / "r1" / "etc" / "motd").exists()
    assert any("shared/" in w for w in warnings)


def test_labs_reload_from_disk_on_fresh_service(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    service.import_lab("imported", {"lab.conf": 'r1[image]="kathara/base"\nr1[0]="A"\n', "r1.startup": "ip a\n"}, [])
    service.create_lab(
        LabCreate(name="jsonlab", machines=[MachineCreate(name="pc1", image="kathara/base")])
    )

    # A brand-new service (simulating a restart) sees the same labs, rebuilt from disk.
    fresh = _service(LabStore(tmp_path / "labs"))
    assert set(fresh.registry.names()) == {"imported", "jsonlab"}
    # Pending state (startup) is reconstructed too.
    assert fresh.get_pending("imported")["r1"].startup.strip() == "ip a"


def test_delete_lab_removes_directory(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    service.create_lab(LabCreate(name="jsonlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))
    assert store.lab_dir("jsonlab").exists()

    service.delete_lab("jsonlab")
    assert not store.lab_dir("jsonlab").exists()


def test_pending_file_edit_writes_through_to_disk_before_any_deploy(tmp_path):
    """A queued files/dirs edit must survive a restart even for a lab that has never been
    deployed — not just at deploy time."""
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    service.create_lab(LabCreate(name="jsonlab", machines=[MachineCreate(name="pc1", image="kathara/base")]))

    service.update_pending_files("jsonlab", "pc1", files={"/etc/motd": "edited\n"}, dirs=["/var/log"])

    lab_dir = store.lab_dir("jsonlab")
    assert (lab_dir / "pc1" / "etc" / "motd").read_text() == "edited\n"
    assert (lab_dir / "pc1" / "var" / "log").is_dir()

    # Simulated restart: a fresh service sees the edit without ever having deployed.
    fresh = _service(LabStore(tmp_path / "labs"))
    assert fresh.get_pending("jsonlab")["pc1"].files == {"/etc/motd": "edited\n"}


def test_shared_pending_edit_writes_through_to_every_machine_on_disk(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    service.import_lab("lab1", {"lab.conf": "r1[image]=kathara/base\npc1[image]=kathara/base\n"}, [])

    service.update_shared_pending_files("lab1", files={"/etc/motd": "shared edit\n"})

    lab_dir = store.lab_dir("lab1")
    assert (lab_dir / "r1" / "etc" / "motd").read_text() == "shared edit\n"
    assert (lab_dir / "pc1" / "etc" / "motd").read_text() == "shared edit\n"
