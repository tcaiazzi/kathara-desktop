"""Validation of host volumes, shared by both sources they can come from.

A volume can arrive as JSON (the device options form and its host-path browser) or be parsed from
an imported lab.conf's `[volume]` (see lab_import._parse_volume) — both are applied, and both go
through the same `VolumeMount` schema these tests exercise directly. It matters because a volume
is also written back into lab.conf as `pc[volume]="host|guest|mode"`, which is what these
validators protect: neither lab_store.gen_device_lines nor lab_conf_edit.set_meta_group routes
them through lab_store.conf_value.
"""

import pytest
from pydantic import ValidationError

from kathara_api.schemas.machine import VolumeMount
from kathara_api.services import lab_builder, lab_import, lab_store
from kathara_api.schemas.lab import LabCreate


def test_plain_absolute_paths_are_accepted():
    volume = VolumeMount(host_path="/srv/data", guest_path="/mnt/data", mode="ro")
    assert volume.host_path == "/srv/data"


@pytest.mark.parametrize("host_path", ['/srv/"data"', "/srv/'data'", "/srv/data\nx", "/srv\rdata"])
def test_quotes_and_newlines_are_refused(host_path):
    """lab.conf has no escape mechanism: such a value makes the line — and on reload the whole
    lab — unparseable, which is how a lab silently disappears from the UI."""
    with pytest.raises(ValidationError):
        VolumeMount(host_path=host_path, guest_path="/mnt")


@pytest.mark.parametrize(
    ("host_path", "guest_path"),
    [("data", "/mnt"), ("./data", "/mnt"), ("/srv/data", "mnt"), ("/srv/data", "../mnt")],
)
def test_relative_paths_are_refused(host_path, guest_path):
    """Kathara resolves the host side with os.path.abspath, so a relative path silently means
    'relative to the API process's cwd' — different under the desktop app, Compose and dev."""
    with pytest.raises(ValidationError):
        VolumeMount(host_path=host_path, guest_path=guest_path)


def test_a_valid_volume_round_trips_through_lab_conf():
    """End to end: a volume accepted by the schema must produce a lab.conf line that parses back."""
    spec = LabCreate.model_validate(
        {
            "name": "voltest",
            "machines": [
                {
                    "name": "pc1",
                    "image": "kathara/base",
                    "volumes": [{"host_path": "/srv/data", "guest_path": "/mnt", "mode": "ro"}],
                }
            ],
        }
    )
    lab = lab_builder.build_lab(spec)
    text = lab_store.gen_lab_conf(lab)
    assert 'pc1[volume]="/srv/data|/mnt|ro"' in text

    # The real assertion: the text this produced is still parseable, so the lab survives a
    # restart rather than vanishing from the UI the way a malformed line would make it.
    parsed = lab_import.parse_lab_conf(text)
    assert parsed.errors == []
