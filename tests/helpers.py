"""Shared test utilities: a zip-archive builder and a minimal no-op Kathara facade fake.

Not a conftest module — these are plain helpers imported directly by the tests that need them,
not fixtures/hooks.
"""

import io
import stat
import zipfile
from typing import Optional

from Kathara.exceptions import LabNotFoundError


def zip_bytes(entries: dict[str, bytes], modes: Optional[dict[str, int]] = None) -> io.BytesIO:
    """Build an in-memory .zip archive from a path->content map.

    ``modes`` maps an entry name to the Unix mode the archive should *record* for it. Needed
    because plain ``writestr`` with a str arcname always records 0o600 and cannot express an
    executable — let alone a setuid — member, so without it no test could reach the mode-restore
    branch of ``LabStore.extract_zip`` with a value that matters. The bits are stored the way a
    real Unix-authored archive stores them: ``external_attr = mode << 16``, with the regular-file
    type bits included, exactly as ``ZipInfo.from_file`` (and so ``LabStore.zip_lab``) writes them.
    """
    buf = io.BytesIO()
    modes = modes or {}
    with zipfile.ZipFile(buf, "w") as zf:
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

    def get_lab_from_api(self, lab_name):
        raise LabNotFoundError(f"Lab `{lab_name}` not found.")

    def connect_machine_to_link(self, machine, link, mac_address=None):
        pass

    def disconnect_machine_from_link(self, machine, link, keep_link=False):
        pass

    def copy_files(self, machine, guest_to_host):
        pass

    def exec(self, machine_name, command, lab_name=None, wait=False, stream=False):
        return (b"", b"", 0)
