"""Shared test utilities: a zip-archive builder and a minimal no-op Kathara facade fake.

Not a conftest module — these are plain helpers imported directly by the tests that need them,
not fixtures/hooks.
"""

import io
import stat
import zipfile
from typing import Optional

from Kathara.exceptions import LabNotFoundError

from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import lab_id_for


def zip_bytes(
    entries: dict[str, bytes], modes: Optional[dict[str, int]] = None, compression: int = zipfile.ZIP_STORED
) -> io.BytesIO:
    """Build an in-memory .zip archive from a path->content map.

    ``modes`` maps an entry name to the Unix mode the archive should *record* for it. Needed
    because plain ``writestr`` with a str arcname always records 0o600 and cannot express an
    executable — let alone a setuid — member, so without it no test could reach the mode-restore
    branch of ``LabStore.extract_zip`` with a value that matters. The bits are stored the way a
    real Unix-authored archive stores them: ``external_attr = mode << 16``, with the regular-file
    type bits included, exactly as ``ZipInfo.from_file`` (and so ``LabStore.zip_lab``) writes them.

    ``compression=zipfile.ZIP_DEFLATED`` makes the archive smaller than its content, which is what a
    test of the *decompressed*-size caps needs: stored, an archive is always larger than what it
    holds, so the cap on the raw upload would reject it first.
    """
    buf = io.BytesIO()
    modes = modes or {}
    with zipfile.ZipFile(buf, "w", compression=compression) as zf:
        for name, content in entries.items():
            if name in modes:
                info = zipfile.ZipInfo(name)
                info.create_system = 3  # Unix; what makes the mode bits meaningful at all
                info.external_attr = (stat.S_IFREG | modes[name]) << 16
                zf.writestr(info, content)
            else:
                zf.writestr(name, content)
    buf.seek(0)
    return buf


def lab_id(service, name: str) -> str:
    """The id of the lab ``name`` under ``service``'s labs root — what every per-lab method takes.

    Tests create labs by name (``make_lab``, ``create_lab``) and then address them by id, so this
    derives it exactly as the service does (``lab_store.lab_id_for``). It does not need the lab to
    exist: the id of a name that was never created is how a test asks for an unknown lab.
    """
    return lab_id_for(service.store.lab_dir(name))


def register_lab(service, lab):
    """Register a hand-built ``lab`` with ``service`` as if it lived under the labs root.

    For tests that build a ``Lab`` in memory (no directory, often with a device marked as running)
    rather than creating one on disk. It gets the id and directory of ``lab.name`` under the root —
    which need not exist — so ``lab_id(service, lab.name)`` addresses it like any other lab.
    """
    lab.hash = lab_id(service, lab.name)
    service.registry.add(lab, service.store.lab_dir(lab.name))
    return lab


def make_lab(service, name: str, files: dict[str, str], dirs=None, deploy: bool = False):
    """Create a lab on disk from a ``{path: text}`` mapping, through the .zip upload path.

    Most tests only need *a lab that exists* before exercising deploy, lab.conf edits or device
    changes, and ``upload_lab`` is the only creation path that takes a whole directory — but it
    takes it as an archive, so the archive is built here rather than at every call site.
    Returns ``(lab, warnings)``, the same shape ``upload_lab`` does.
    """
    entries: dict[str, bytes] = {path: text.encode() for path, text in files.items()}
    for d in dirs or []:
        entries[d.rstrip("/") + "/"] = b""
    return service.upload_lab(name, zip_bytes(entries), deploy=deploy)


def make_service(store=None, facade=None):
    """A ``KatharaService`` with its Kathara facade replaced, so no Docker is needed.

    ``_instance`` is assigned directly rather than through any public path: ``Kathara.get_instance()``
    is a true singleton that reaches for a Docker daemon when it is first constructed, so every test
    touching a lab has to bypass it.

    ``store=None`` keeps ``KatharaService``'s own default, which is the *configured* labs directory —
    tests that must not write there pass a ``tmp_path``-backed ``LabStore`` explicitly, and the
    difference is deliberate at each call site rather than hidden here.
    """
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase() if facade is None else facade
    return service


class FakeFacadeBase:
    """No-op stand-in for ``Kathara.get_instance()``; subclass and override only what a given
    test needs (e.g. to record calls or inject a specific failure)."""

    def deploy_lab(self, lab, selected_machines=None, excluded_machines=None):
        pass

    def deploy_machine(self, machine):
        machine.api_object = object()

    def undeploy_lab(self, **kwargs):
        pass

    def undeploy_machine(self, machine, keep_links=False):
        pass

    def undeploy_link(self, link):
        pass

    def update_lab_from_api(self, lab):
        return lab

    def get_lab_from_api(self, lab_hash=None, lab_name=None):
        raise LabNotFoundError(f"Lab `{lab_hash or lab_name}` not found.")

    def connect_machine_to_link(self, machine, link, mac_address=None):
        pass

    def disconnect_machine_from_link(self, machine, link, keep_link=False):
        pass

    def copy_files(self, machine, guest_to_host):
        pass

    def exec(self, machine_name, command, lab_hash=None, lab_name=None, wait=False, stream=False):
        return (b"", b"", 0)


