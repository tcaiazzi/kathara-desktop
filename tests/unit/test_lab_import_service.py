"""Unit tests for KatharaService's backend-authoritative lab import + pending-apply-on-deploy
(no Docker required): parsing and file/startup application happen server-side and survive a
restart because they're kept in the on-disk store and the process-scoped registry.
"""

import pytest

from kathara_api.errors import ApiError, LabAlreadyRegisteredError, LabConfLockedError
from kathara_api.schemas.lab import LabCreate
from kathara_api.schemas.machine import MachineCreate, MachineUpdate
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


def test_import_lab_creates_lab_with_files_on_disk(tmp_path):
    service = _service(tmp_path)
    files = {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}

    lab, warnings = service.import_lab("lab1", files, [])

    assert warnings == []
    assert set(lab.machines.keys()) == {"r1", "pc1"}
    assert service.get_startup_scripts("lab1")["r1"].strip() == "ip a"


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


def test_deploy_materializes_offline_edits_to_native_fs(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\n"}, [])
    service.fs_write_text_offline("lab1", "/pc1/etc/motd", "hi\n")
    service.fs_mkdir_offline("lab1", "/pc1/etc/empty")

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
    MachineAlreadyExistsError on a real redeploy). A redeploy with *no* offline edit since the
    last (re)deploy must not push/re-exec anything — native first-deploy boot already ran the
    startup script once. An explicit edit in between must be pushed live exactly once (via the
    dirty-machine set, not a redeploy-always-pushes rule)."""
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])

    service.deploy_lab("lab1")  # fresh: native materialization, no copy_files/exec
    service.deploy_lab("lab1")  # both already running, nothing changed since: no push

    facade = service._instance
    assert facade.exec_calls == []
    assert facade.copied == []

    service.fs_write_text_offline("lab1", "/r1.startup", "ip a\necho again\n")
    service.deploy_lab("lab1")

    assert facade.exec_calls == [("r1", "sh /tmp/.kathara_boot.sh", False)]
    assert ("r1", {"/tmp/.kathara_boot.sh": "ip a\necho again\n"}) in facade.copied

    # A further redeploy with no new edit doesn't push again.
    service.deploy_lab("lab1")
    assert facade.exec_calls == [("r1", "sh /tmp/.kathara_boot.sh", False)]


def test_offline_fs_writes_accumulate_without_clobbering(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    service.fs_write_text_offline("lab1", "/pc1/a", "1")
    service.fs_write_text_offline("lab1", "/pc1/b", "2")

    lab_dir = service.store.lab_dir("lab1")
    assert (lab_dir / "pc1" / "a").read_text() == "1"
    assert (lab_dir / "pc1" / "b").read_text() == "2"


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

    assert any("shared/" in w for w in warnings)
    assert set(lab.machines.keys()) == {"r1", "pc1"}
    lab_dir = service.store.lab_dir("uploaded")
    assert (lab_dir / "r1.startup").read_text().strip() == "ip a"
    # extract_zip writes the archive verbatim regardless of what the parser does with it: the
    # shared/ folder stays exactly where the archive put it...
    assert (lab_dir / "shared" / "etc" / "motd").read_text() == "hi\n"
    # ...and is deliberately not applied to (merged into) any device — see
    # lab_import.translate_lab_files (shared/ is out of scope for now, warned about instead).
    assert not (lab_dir / "r1" / "etc" / "motd").exists()
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

    assert service.get_startup_scripts("lab1")["r1"].strip() == "ip a"


def test_update_lab_conf_rejects_when_deployed(tmp_path):
    service = _service(tmp_path)
    service.create_lab(LabCreate(name="lab1"))
    service.update_lab_conf("lab1", LAB_CONF)
    service.deploy_lab("lab1")  # fake facade sets api_object on machines

    with pytest.raises(LabConfLockedError):
        service.update_lab_conf("lab1", "pc1[image]=kathara/base\n")


def test_remove_machine_removes_from_model_and_lab_conf(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": LAB_CONF, "r1.startup": "ip a\n"}, [])
    service.fs_write_text_offline("lab1", "/r1/etc/motd", "hi\n")

    service.remove_machine("lab1", "r1")

    lab = service.registry.get("lab1")
    assert "r1" not in lab.machines  # gone from the model, not just undeployed
    assert "r1" not in lab.links["A"].machines  # detached from the shared collision domain
    # Regenerated lab.conf no longer references the device, and its on-disk files are gone.
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "r1[" not in conf
    assert "pc1[" in conf
    assert not (service.store.lab_dir("lab1") / "r1.startup").exists()
    assert not (service.store.lab_dir("lab1") / "r1").exists()


def test_connect_disconnect_stopped_persists_lab_conf(tmp_path):
    from kathara_api.services import lab_import

    service = _service(tmp_path)
    original = "pc1[image]=kathara/base\n"
    service.import_lab("lab1", {"lab.conf": original}, [])

    # Static (stopped) interface add → persisted to lab.conf, surgically. The new interface line
    # is inserted *before* the device's existing option lines (interfaces-before-options, matching
    # gen_lab_conf's own device-block convention), copying their unquoted style.
    service.connect_machine("lab1", "pc1", "A", interface_number=0)
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert conf == "pc1[0]=A\npc1[image]=kathara/base\n"
    parsed = lab_import.parse_lab_conf(conf)
    assert {(i.link, i.number) for i in parsed.machines["pc1"].interfaces} == {("A", 0)}

    # Static (stopped) interface remove → gone from lab.conf, original line untouched.
    service.disconnect_machine("lab1", "pc1", "A")
    conf2 = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert conf2 == original


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


def test_update_machine_persists_to_lab_conf_when_stopped(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}, [])

    spec = MachineUpdate(mem="256m", bridged=True, envs={"FOO": "bar"})
    machine = service.update_machine("lab1", "pc1", spec)

    assert machine.meta["mem"] == "256m"
    assert machine.meta["bridged"] is True
    assert machine.meta["envs"] == {"FOO": "bar"}
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "pc1[mem]=256m" in conf
    assert 'pc1[env]="FOO=bar"' in conf
    # ...and it survives a reload from disk (truly persisted, not just live).
    service._reload_lab_from_disk("lab1")
    reloaded = service.registry.get("lab1").machines["pc1"]
    assert reloaded.meta["mem"] == "256m"


def test_update_machine_rejects_when_deployed(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}, [])
    service.deploy_lab("lab1")  # fake facade sets api_object on machines

    with pytest.raises(LabConfLockedError):
        service.update_machine("lab1", "pc1", MachineUpdate(mem="256m"))

    # Rejected before touching anything — lab.conf and the live model are both untouched.
    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "pc1[mem]" not in conf
    assert "mem" not in service.registry.get("lab1").machines["pc1"].meta


def test_update_machine_clears_options_not_resubmitted(tmp_path):
    service = _service(tmp_path)
    service.import_lab(
        "lab1", {"lab.conf": 'pc1[image]=kathara/base\npc1[0]=A\npc1[mem]="128m"\npc1[env]="A=1"\n'}, []
    )

    service.update_machine("lab1", "pc1", MachineUpdate())

    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "pc1[mem]" not in conf
    assert "pc1[env]" not in conf
    assert "mem" not in service.registry.get("lab1").machines["pc1"].meta


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
    assert "pc2[1]=C" in conf  # offline edit persisted (unquoted, matching the source file's style)
    assert "pc1[1]" not in conf  # runtime interface never leaked
    assert "pc1[0]=A" in conf and "pc2[0]=A" in conf  # original config intact, byte-identical


def test_disconnect_stopped_device_renumbers_and_lab_still_reloads(tmp_path):
    """Regression: disconnecting a device's *middle* interface must renumber the survivors, or
    the resulting gap (e.g. eth0, eth2) is rejected by lab_import.parse_lab_conf and the lab
    silently disappears from the registry on the next restart (_translate_lab_dir -> None)."""
    from kathara_api.services import lab_import

    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\npc1[1]=B\npc1[2]=C\n"}, [])

    service.disconnect_machine("lab1", "pc1", "B")  # remove the middle interface (eth1)

    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    parsed = lab_import.parse_lab_conf(conf)
    assert parsed.errors == []
    assert {(i.link, i.number) for i in parsed.machines["pc1"].interfaces} == {("A", 0), ("C", 1)}
    # The live model must agree with the file (no gap there either).
    pc1 = service.registry.get("lab1").machines["pc1"]
    assert {(iface.link.name, num) for num, iface in pc1.interfaces.items() if iface is not None} == {
        ("A", 0), ("C", 1),
    }

    # A brand-new service instance (simulating a restart) must still be able to load the lab.
    fresh = KatharaService(store=service.store)
    fresh._instance = _FakeFacade()
    fresh._reload_from_disk()
    assert "lab1" in fresh.registry.names()


def test_edit_on_folder_based_lab_generates_lab_conf_first(tmp_path):
    """A lab imported from folders only (no lab.conf) has nothing to preserve verbatim, so its
    first structural edit legitimately bootstraps one via gen_lab_conf, then applies the edit."""
    service = _service(tmp_path)
    service.import_lab("lab1", {"pc1/etc/motd": "hi\n"}, [])
    assert not (service.store.lab_dir("lab1") / "lab.conf").exists()

    spec = MachineCreate.model_validate({"name": "pc2", "image": "kathara/base"})
    service.add_machine("lab1", spec)

    conf = (service.store.lab_dir("lab1") / "lab.conf").read_text()
    assert "pc1[image]" in conf or "pc1" in conf  # pc1 present (folder-derived)
    assert "pc2[image]" in conf


def test_edit_on_lab_without_directory_is_skipped(tmp_path):
    """An offline structural edit on a lab that has no on-disk directory at all (reconstruct-only)
    must not create one as a side effect — it's simply not persisted."""
    service = _service(tmp_path)
    lab = LabCreate(name="live", machines=[{"name": "pc1", "image": "kathara/base"}])
    from kathara_api.services import lab_builder

    built = lab_builder.build_lab(lab)
    service.registry.add_if_absent(built)

    service.add_machine("live", MachineCreate.model_validate({"name": "pc2", "image": "kathara/base"}))

    assert not service.store.lab_dir("live").exists()


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
