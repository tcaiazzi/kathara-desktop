"""Unit tests for KatharaService's backend-authoritative lab import + pending-apply-on-deploy
(no Docker required): parsing and file/startup application happen server-side and survive a
restart because they're kept in the on-disk store and the process-scoped registry.
"""

import pytest

from kathara_api.errors import ApiError, LabAlreadyRegisteredError, LabConfLockedError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, zip_bytes


class _FakeFacade(FakeFacadeBase):
    """Records the calls this test suite cares about instead of touching Docker."""

    def __init__(self):
        self.deployed = []
        self.exec_calls = []
        self.copied = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        self.deployed.append((lab.name, selected_machines, excluded_machines))
        for machine in lab.machines.values():
            if selected_machines is not None and machine.name not in selected_machines:
                continue
            if excluded_machines is not None and machine.name in excluded_machines:
                continue
            machine.api_object = object()

    def connect_machine_to_link(self, machine, link, mac_address=None):
        # Mirror DockerManager.connect_machine_to_link: a runtime connect adds the interface to the
        # (shared) model too, so a naive lab.conf-from-model persist would capture it.
        machine.add_interface(link, mac_address=mac_address)

    def exec(self, machine_name, command, lab_name=None, wait=False, stream=False):
        self.exec_calls.append((machine_name, command, wait))
        return (b"", b"", 0)

    def copy_files(self, machine, guest_to_host):
        # KatharaService.copy_files wraps content as BytesIO; unwrap back to text for assertions.
        decoded = {path: buf.getvalue().decode("utf-8") for path, buf in guest_to_host.items()}
        self.copied.append((machine.name, decoded))


def _service(tmp_path):
    # Inject a temp-dir store so persistence writes stay out of the repo.
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = _FakeFacade()
    return service


LAB_CONF = "r1[image]=kathara/base\nr1[0]=A\npc1[image]=kathara/base\npc1[0]=A\n"


def test_import_lab_creates_lab_and_stores_pending(tmp_path):
    service = _service(tmp_path)
    files = {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}

    lab, warnings = service.import_lab("lab1", files, [])

    assert warnings == []
    assert set(lab.machines.keys()) == {"r1", "pc1"}
    pending = service.get_pending("lab1")
    assert pending["r1"].startup.strip() == "ip a"


def test_import_lab_raises_api_error_on_parse_errors(tmp_path):
    service = _service(tmp_path)
    with pytest.raises(ApiError):
        service.import_lab("lab1", {}, [])


def test_fresh_deploy_materializes_pending_to_native_fs_not_exec(tmp_path):
    """A machine's *first* deploy is native (Machine.pack_data reads real files off disk) —
    no copy_files/exec push happens for it (that would double-run a non-idempotent startup
    script, once via pack_data and once via the old live-push mechanism)."""
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])

    service.deploy_lab("lab1")

    facade = service._instance
    # Only the freshly-created machines are passed to the facade (never the already-running
    # subset, which would raise MachineAlreadyExistsError against real Kathara).
    assert facade.deployed == [("lab1", {"r1", "pc1"}, None)]
    assert facade.copied == []
    assert facade.exec_calls == []
    # The startup script and lab.conf are real files Kathara's native pack_data will pack.
    lab_dir = service.store.lab_dir("lab1")
    assert (lab_dir / "r1.startup").read_text().strip() == "ip a"
    assert (lab_dir / "lab.conf").exists()


def test_deploy_materializes_pending_dirs_and_files_to_native_fs(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\n"}, [])
    service.update_pending_files("lab1", "pc1", files={"/etc/motd": "hi\n"}, dirs=["/etc/empty"])

    service.deploy_lab("lab1")

    facade = service._instance
    assert facade.copied == []
    assert facade.exec_calls == []
    lab_dir = service.store.lab_dir("lab1")
    assert (lab_dir / "pc1" / "etc" / "motd").read_text() == "hi\n"
    assert (lab_dir / "pc1" / "etc" / "empty").is_dir()


def test_redeploy_never_repasses_already_running_machines_to_facade(tmp_path):
    """The facade's own deploy_lab raises MachineAlreadyExistsError for a machine that's already
    running, so a redeploy call must never pass an already-running machine to it again."""
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])

    service.deploy_lab("lab1")
    service.deploy_lab("lab1")

    facade = service._instance
    # First call: both freshly created. Second call: both already running, so the facade's
    # deploy_lab must not be invoked again at all (nothing left to freshly create).
    assert facade.deployed == [("lab1", {"r1", "pc1"}, None)]


def test_deploy_is_scoped_to_selected_machines(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])

    service.deploy_lab("lab1", selected_machines={"pc1"})

    facade = service._instance
    assert facade.copied == []  # only pc1 deployed, and pc1 has no pending state


def test_redeploy_of_already_running_machine_pushes_live_update_once(tmp_path):
    """A machine that's already running can't be recreated (Kathara raises
    MachineAlreadyExistsError on a real redeploy), so a second deploy call must still push its
    queued state live via copy_files+exec — but only once, and only for the already-running
    subset (the first call's machines are handled natively, not through this path)."""
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])

    service.deploy_lab("lab1")  # fresh: native materialization, no copy_files/exec
    service.deploy_lab("lab1")  # both machines now already "running": live push

    facade = service._instance
    assert facade.exec_calls == [("r1", "sh /tmp/.kathara_boot.sh", False)]
    assert ("r1", {"/tmp/.kathara_boot.sh": "ip a\n"}) in facade.copied


def test_update_pending_files_merges_without_clobbering(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    service.update_pending_files("lab1", "pc1", files={"/a": "1"})
    service.update_pending_files("lab1", "pc1", files={"/b": "2"})

    pending = service.get_pending("lab1")
    assert pending["pc1"].files == {"/a": "1", "/b": "2"}


def test_update_shared_pending_files_targets_every_machine(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF}, [])

    service.update_shared_pending_files("lab1", files={"/etc/motd": "hi\n"})

    pending = service.get_pending("lab1")
    assert pending["r1"].files == {"/etc/motd": "hi\n"}
    assert pending["pc1"].files == {"/etc/motd": "hi\n"}


def test_delete_lab_clears_pending_state(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    service.delete_lab("lab1")

    assert service.get_pending("lab1") == {}


def test_upload_lab_extracts_and_materializes_binary_and_text(tmp_path):
    service = _service(tmp_path)
    archive = zip_bytes(
        {
            "lab.conf": LAB_CONF.encode(),
            "r1.startup": b"ip a\n",
            "shared/etc/motd": b"hi\n",
            "r1/bin/tool": b"\x00\x01\xff",  # binary — can't round-trip through pending.files
        }
    )

    lab, warnings = service.upload_lab("uploaded", archive)

    assert warnings == []
    assert set(lab.machines.keys()) == {"r1", "pc1"}
    lab_dir = service.store.lab_dir("uploaded")
    assert (lab_dir / "r1.startup").read_text().strip() == "ip a"
    assert (lab_dir / "r1" / "etc" / "motd").read_text() == "hi\n"
    # Binary content isn't representable in the text pending model, but extract_zip preserves it
    # on disk verbatim, and Machine.__init__ auto-discovers the existing r1/ subfolder as
    # machine.fs, so native pack_data still picks it up correctly at deploy time.
    assert (lab_dir / "r1" / "bin" / "tool").read_bytes() == b"\x00\x01\xff"


def test_upload_lab_rejects_duplicate_name(tmp_path):
    service = _service(tmp_path)
    service.import_lab("dup", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    with pytest.raises(LabAlreadyRegisteredError):
        service.upload_lab("dup", zip_bytes({"lab.conf": b"pc1[image]=kathara/base\n"}))


def test_upload_lab_rolls_back_directory_on_parse_error(tmp_path):
    service = _service(tmp_path)
    with pytest.raises(ApiError):
        service.upload_lab("bad", zip_bytes({"notalabconf.txt": b"nothing useful\n"}))

    assert not service.store.lab_dir("bad").exists()


def test_update_lab_conf_rebuilds_empty_lab(tmp_path):
    service = _service(tmp_path)
    service.create_lab(LabCreate(name="lab1"))  # empty

    lab = service.update_lab_conf("lab1", LAB_CONF)

    assert set(lab.machines.keys()) == {"r1", "pc1"}
    assert "A" in lab.links
    # Regenerated lab.conf is persisted, and a follow-up GET reflects the new topology.
    assert (service.store.lab_dir("lab1") / "lab.conf").exists()
    assert set(service.get_lab_or_reconstruct("lab1").machines.keys()) == {"r1", "pc1"}


def test_update_lab_conf_preserves_existing_device_startup(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])

    # Edit lab.conf (drop pc1); r1's existing startup must survive the rebuild.
    service.update_lab_conf("lab1", "r1[image]=kathara/base\nr1[0]=A\n")

    assert service.get_pending("lab1")["r1"].startup.strip() == "ip a"


def test_update_lab_conf_rejects_when_deployed(tmp_path):
    service = _service(tmp_path)
    service.create_lab(LabCreate(name="lab1"))
    service.update_lab_conf("lab1", LAB_CONF)
    service.deploy_lab("lab1")  # fake facade sets api_object on machines

    with pytest.raises(LabConfLockedError):
        service.update_lab_conf("lab1", "pc1[image]=kathara/base\n")


def test_remove_machine_removes_from_model_pending_and_lab_conf(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])
    service.update_pending_files("lab1", "r1", files={"/etc/motd": "hi\n"})

    service.remove_machine("lab1", "r1")

    lab = service.registry.get("lab1")
    assert "r1" not in lab.machines  # gone from the model, not just undeployed
    assert "r1" not in lab.links["A"].machines  # detached from the shared collision domain
    assert "r1" not in service.get_pending("lab1")  # queued state dropped
    # Regenerated lab.conf no longer references the device, and its on-disk files are gone.
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "r1[" not in conf
    assert "pc1[" in conf
    assert not (service.store.lab_dir("lab1") / "r1.startup").exists()


def test_connect_disconnect_stopped_persists_lab_conf(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    # Static (stopped) interface add → persisted to lab.conf.
    service.connect_machine("lab1", "pc1", "A", interface_number=0)
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert 'pc1[0]="A"' in conf

    # Static (stopped) interface remove → gone from lab.conf.
    service.disconnect_machine("lab1", "pc1", "A")
    conf2 = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "pc1[0]" not in conf2


def test_add_machine_persists_to_lab_conf_and_defers_deploy_when_stopped(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}, [])

    spec = MachineCreate.model_validate(
        {"name": "pc2", "image": "kathara/base", "interfaces": [{"link": "A", "number": 0}]}
    )
    machine = service.add_machine("lab1", spec)

    # Lab is stopped → the device is a config edit: written to lab.conf, not deployed.
    assert machine.api_object is None
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert 'pc2[0]="A"' in conf
    assert "pc2[image]" in conf
    # ...and it survives a reload from disk (truly persisted, not just live).
    service._reload_lab_from_disk("lab1")
    assert "pc2" in service.registry.get("lab1").machines


def test_add_machine_deploys_live_when_lab_running(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}, [])
    service.deploy_lab("lab1")  # pc1 running

    spec = MachineCreate.model_validate({"name": "pc2", "image": "kathara/base"})
    machine = service.add_machine("lab1", spec)

    # Lab is running → the new device is deployed live *and* persisted to lab.conf.
    assert machine.api_object is not None
    assert "pc2[image]" in (service.store.lab_dir("lab1") / "lab.conf").read_text()


def test_runtime_interface_change_never_leaks_into_lab_conf(tmp_path):
    """A runtime (running-device) interface add mutates the shared model, but must never reach
    lab.conf — not from the runtime op itself, nor from a later offline edit on another device."""
    service = _service(tmp_path)
    service.import_lab(
        "lab1",
        {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\npc2[image]=kathara/base\npc2[0]=A\n"},
        [],
    )
    # Deploy only pc1; pc2 stays stopped.
    service.deploy_lab("lab1", selected_machines={"pc1"})

    # Runtime add on the running pc1 → mutates the live model but must not touch lab.conf.
    service.connect_machine("lab1", "pc1", "B")
    conf_after_runtime = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "pc1[1]" not in conf_after_runtime

    # Offline add on the stopped pc2 → persisted, but must NOT capture pc1's runtime interface.
    service.connect_machine("lab1", "pc2", "C", interface_number=1)
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert 'pc2[1]="C"' in conf  # offline edit persisted
    assert "pc1[1]" not in conf  # runtime interface never leaked
    assert 'pc1[0]="A"' in conf and 'pc2[0]="A"' in conf  # original config intact


def test_full_undeploy_restores_configuration_topology(tmp_path):
    """A full undeploy discards runtime-only model changes and restores the saved (lab.conf)
    topology."""
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}, [])
    service.deploy_lab("lab1")  # fake facade sets api_object on pc1

    # Runtime add on the running pc1 → live model gains eth1→B (not persisted to lab.conf).
    service.connect_machine("lab1", "pc1", "B")
    live = service.registry.get("lab1").machines["pc1"]
    assert {(n, i.link.name) for n, i in live.interfaces.items() if i is not None} == {(0, "A"), (1, "B")}

    # Full undeploy → topology returns to the saved config (runtime eth1 gone), nothing running.
    service.undeploy_lab("lab1")
    pc1 = service.get_machine("lab1", "pc1")
    assert {i.link.name for i in pc1.interfaces.values() if i is not None} == {"A"}
    assert pc1.api_object is None


def test_bridged_is_parsed_built_serialized_and_persisted(tmp_path):
    from kathara_api.services import serializers

    service = _service(tmp_path)
    conf = 'ws[image]="lscr.io/linuxserver/wireshark"\nws[bridged]=true\n'
    lab, _ = service.import_lab("brlab", {"lab.conf": conf}, [])

    assert lab.machines["ws"].is_bridged() is True
    assert serializers.machine_to_detail(lab.machines["ws"]).bridged is True
    # Regenerated on-disk lab.conf keeps the flag (round-trips through gen_lab_conf + the parser).
    assert "ws[bridged]" in (service.store.lab_dir("brlab") / "lab.conf").read_text()


def test_upload_lab_can_deploy_immediately(tmp_path):
    service = _service(tmp_path)
    archive = zip_bytes({"lab.conf": b'pc1[image]="kathara/base"\npc1[0]="A"\n'})

    lab, _ = service.upload_lab("uploaded2", archive, deploy=True)

    facade = service._instance
    assert facade.deployed == [("uploaded2", {"pc1"}, None)]
