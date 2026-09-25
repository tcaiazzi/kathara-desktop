"""Unit tests for KatharaService.lab_location (GET /labs/{lab}/location).

The endpoint exists for the Electron shell (services/desktop), which needs a real host path to
hand to the OS file manager and to a system terminal. It must return LabStore's own directory
(the shell does not know the storage root or the name rules), and 404 for an unknown lab — which
includes any path-like string, since an id is looked up, never joined into a path.
"""

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.services.lab_store import LabStore
from tests.helpers import lab_id, make_service


def test_returns_the_store_directory_for_an_existing_lab(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    store.write_lab("mylab", {"lab.conf": "LAB_NAME=mylab\n"})

    location = service.lab_location(lab_id(service, "mylab"))

    assert location == store.lab_dir("mylab")
    assert location.is_dir()


@pytest.mark.parametrize("bad", ["../etc", "My Lab/../weird", "..", "a/b"])
def test_a_path_like_id_is_unknown_not_resolved(tmp_path, bad):
    """A path handed to the OS file manager or a shell must never escape the storage root: an id
    only ever resolves to a directory the service already knows, so a path is not found at all."""
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    store.write_lab("etc", {"lab.conf": "LAB_NAME=etc\n"})

    with pytest.raises(LabNotFoundError):
        service.lab_location(bad)


def test_the_returned_path_stays_inside_the_storage_root(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = make_service(store)
    store.write_lab("mylab", {"lab.conf": "LAB_NAME=mylab\n"})

    assert service.lab_location(lab_id(service, "mylab")).resolve().is_relative_to(store.root.resolve())


def test_unknown_lab_raises_lab_not_found(tmp_path):
    service = make_service(LabStore(tmp_path / "labs"))

    with pytest.raises(LabNotFoundError):
        service.lab_location(lab_id(service, "no-such-lab"))
