"""Unit tests for verbatim persistence of imported/uploaded labs (no Docker required).

These are the regression tests for the original bug report: importing a lab from a zip must not
modify lab.conf (or any other file) — every byte of the source archive must land on disk exactly
as it was, and stay that way after a fresh deploy.
"""

import zipfile

import pytest

from kathara_api.errors import LabAlreadyRegisteredError
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase, zip_bytes


def _service(tmp_path):
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    return service


class _RecordingFacade(FakeFacadeBase):
    """Records copy_files calls (decoded back to text) so a live-pushed boot script can be
    inspected — everything else is FakeFacadeBase's no-op/deploy-marking behavior."""

    def __init__(self):
        self.copied = []

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        for machine in lab.machines.values():
            if selected_machines is None or machine.name in selected_machines:
                machine.api_object = object()

    def copy_files(self, machine, guest_to_host):
        decoded = {path: buf.getvalue().decode("utf-8") for path, buf in guest_to_host.items()}
        self.copied.append((machine.name, decoded))


# A deliberately hostile lab.conf: comments, unusual ordering, single quotes, [volume],
# [num_terms], an unknown meta, a trailing comment, LAB_NAME different from the target lab name,
# and CRLF line endings.
NASTY_LAB_CONF = (
    "# a leading comment\r\n"
    'LAB_NAME="original-name"\r\n'
    "LAB_DESCRIPTION='single quoted description'\r\n"
    'MY_CUSTOM_META="keep me"\r\n'
    "\r\n"
    "pc1[num_terms]=2\r\n"
    "pc1[image]='kathara/base'\r\n"
    'pc1[volume]=/host/data|/mnt/data|rw\r\n'
    'pc1[0]="A"   # trailing comment\r\n'
)


def test_upload_lab_keeps_lab_conf_byte_for_byte(tmp_path):
    service = _service(tmp_path)
    archive = zip_bytes(
        {
            "lab.conf": NASTY_LAB_CONF.encode("utf-8"),
            "pc1.startup": b"ip a\n",
            "shared.startup": b"echo shared\n",
            "shared.shutdown": b"echo bye\n",
        }
    )

    lab, warnings = service.upload_lab("uploaded", archive)

    lab_dir = service.store.lab_dir("uploaded")
    assert (lab_dir / "lab.conf").read_bytes() == NASTY_LAB_CONF.encode("utf-8")
    # Warnings mention what wasn't applied, without erroring the whole import.
    assert any("volume" in w for w in warnings)
    assert any("MY_CUSTOM_META" in w or "not interpreted" in w for w in warnings)
    assert lab.machines["pc1"] is not None


def test_upload_lab_preserves_every_archive_member_byte_for_byte(tmp_path):
    service = _service(tmp_path)
    entries = {
        "lab.conf": NASTY_LAB_CONF.encode("utf-8"),
        "pc1.startup": b"ip a\r\n",
        "shared.startup": b"echo shared\n",
        "shared.shutdown": b"echo bye\n",
        "pc1/blob.bin": bytes(range(256)),
    }
    archive = zip_bytes(entries)

    service.upload_lab("uploaded", archive)

    lab_dir = service.store.lab_dir("uploaded")
    for rel, content in entries.items():
        assert (lab_dir / rel).read_bytes() == content


def test_upload_lab_keeps_shared_startup_and_shutdown(tmp_path):
    # Regression guard for the deleted `for stray in ("shared.startup", "shared.shutdown"):
    # stray_path.unlink()` block — those files must survive an upload untouched.
    service = _service(tmp_path)
    archive = zip_bytes(
        {
            "lab.conf": b"pc1[image]=kathara/base\npc1[0]=A\n",
            "shared.startup": b"echo shared\n",
            "shared.shutdown": b"echo bye\n",
        }
    )
    service.upload_lab("uploaded", archive)
    lab_dir = service.store.lab_dir("uploaded")
    assert (lab_dir / "shared.startup").read_bytes() == b"echo shared\n"
    assert (lab_dir / "shared.shutdown").read_bytes() == b"echo bye\n"


def test_download_after_upload_round_trips(tmp_path):
    service = _service(tmp_path)
    entries = {
        "lab.conf": NASTY_LAB_CONF.encode("utf-8"),
        "pc1.startup": b"ip a\n",
        "shared.startup": b"echo shared\n",
        "pc1/blob.bin": bytes(range(256)),
    }
    service.upload_lab("uploaded", zip_bytes(entries))

    buf = service.export_lab_zip("uploaded")
    with zipfile.ZipFile(buf) as archive:
        for rel, content in entries.items():
            assert archive.read(rel) == content


def test_import_lab_writes_files_verbatim(tmp_path):
    service = _service(tmp_path)
    files = {
        "lab.conf": NASTY_LAB_CONF,
        "pc1.startup": "ip a\r\n",
    }

    lab, warnings = service.import_lab("imported", files, [])

    lab_dir = service.store.lab_dir("imported")
    assert (lab_dir / "lab.conf").read_bytes().decode("utf-8") == NASTY_LAB_CONF
    assert (lab_dir / "pc1.startup").read_bytes() == b"ip a\r\n"
    assert lab.machines["pc1"] is not None


def test_import_lab_refuses_to_clobber_an_existing_lab_directory(tmp_path):
    service = _service(tmp_path)
    service.import_lab("dup", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    with pytest.raises(LabAlreadyRegisteredError):
        service.import_lab("dup", {"lab.conf": "pc1[image]=kathara/base\n"}, [])


def test_upload_lab_refuses_to_clobber_an_existing_lab_directory(tmp_path):
    service = _service(tmp_path)
    service.import_lab("dup", {"lab.conf": "pc1[image]=kathara/base\n"}, [])

    with pytest.raises(LabAlreadyRegisteredError):
        service.upload_lab("dup", zip_bytes({"lab.conf": b"pc1[image]=kathara/base\n"}))
    # The pre-existing directory must survive the rejected upload untouched.
    assert (service.store.lab_dir("dup") / "lab.conf").exists()


def test_update_lab_conf_stores_the_submitted_text_verbatim(tmp_path):
    service = _service(tmp_path)
    service.import_lab("lab1", {"lab.conf": "pc1[image]=kathara/base\npc1[0]=A\n"}, [])

    edited = (
        "# hand-edited\r\n"
        "pc1[image]='kathara/base'\r\n"
        "pc1[0]=A\r\n"
        "pc1[num_terms]=3\r\n"
        "MY_META=\"kept\"\r\n"
    )
    service.update_lab_conf("lab1", edited)

    lab_dir = service.store.lab_dir("lab1")
    assert (lab_dir / "lab.conf").read_bytes().decode("utf-8") == edited



def test_live_push_boot_script_composes_shared_own_and_exec_commands(tmp_path):
    # A machine already running when a redeploy is requested gets its queued startup pushed live
    # (KatharaService._apply_pending / _boot_script) — it must run in the same order Kathara's own
    # native deploy would: shared.startup, then the device's own startup, then exec_commands.
    service = _service(tmp_path)
    service._instance = _RecordingFacade()
    service.import_lab(
        "lab1",
        {
            "lab.conf": "pc1[image]=kathara/base\npc1[0]=A\npc1[exec]=echo three\n",
            "pc1.startup": "echo two\n",
            "shared.startup": "echo one\n",
        },
        [],
    )

    service.deploy_lab("lab1")  # fresh: native, no live push yet
    service.deploy_lab("lab1")  # now "running": live push exercises _boot_script

    facade = service._instance
    boot_scripts = [files["/tmp/.kathara_boot.sh"] for name, files in facade.copied if name == "pc1"]
    assert boot_scripts == ["echo one\n\necho two\n\necho three"]


def test_pending_startup_is_the_verbatim_machine_startup(tmp_path):
    # PendingMachineFiles.startup must be exactly <machine>.startup's own content — no
    # shared.startup prefix, no exec_commands suffix (those are native-deploy's job; composing
    # them here would run them twice and would silently diverge from the file on disk).
    service = _service(tmp_path)
    service.import_lab(
        "lab1",
        {
            "lab.conf": "pc1[image]=kathara/base\npc1[0]=A\npc1[exec]=echo three\n",
            "pc1.startup": "echo two\n",
            "shared.startup": "echo one\n",
        },
        [],
    )
    pending = service.get_pending("lab1")
    assert pending["pc1"].startup == "echo two\n"
