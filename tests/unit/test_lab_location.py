"""Unit tests for KatharaService.lab_location (GET /labs/{lab}/location).

The endpoint exists for the Electron shell (services/desktop), which needs a real host path to
hand to the OS file manager and to a system terminal. It must return LabStore's own directory
(the shell does not know the storage root or the name rules), 404 for an unknown lab, and reject
a name that is not a safe single path segment rather than resolving it.
"""

import pytest
from Kathara.exceptions import LabNotFoundError

from kathara_api.errors import ApiError
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


def _service(store: LabStore) -> KatharaService:
    service = KatharaService(store=store)
    service._instance = FakeFacadeBase()
    return service


def test_returns_the_store_directory_for_an_existing_lab(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    store.write_lab("mylab", {"lab.conf": "LAB_NAME=mylab\n"})

    location = service.lab_location("mylab")

    assert location == store.lab_dir("mylab")
    assert location.is_dir()


@pytest.mark.parametrize("bad", ["../etc", "My Lab/../weird", "..", "a/b"])
def test_an_unsafe_name_is_rejected_not_resolved(tmp_path, bad):
    """A path handed to the OS file manager or a shell must never escape the storage root."""
    service = _service(LabStore(tmp_path / "labs"))

    with pytest.raises(ApiError):
        service.lab_location(bad)


def test_the_returned_path_stays_inside_the_storage_root(tmp_path):
    store = LabStore(tmp_path / "labs")
    service = _service(store)
    store.write_lab("mylab", {"lab.conf": "LAB_NAME=mylab\n"})

    assert service.lab_location("mylab").resolve().is_relative_to(store.root.resolve())


def test_unknown_lab_raises_lab_not_found(tmp_path):
    service = _service(LabStore(tmp_path / "labs"))

    with pytest.raises(LabNotFoundError):
        service.lab_location("no-such-lab")
