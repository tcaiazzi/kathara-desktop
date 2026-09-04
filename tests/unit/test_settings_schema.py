"""Unit tests for the `SettingsUpdate`/`SettingsView` schemas (E8).

Distinct from `test_settings_update.py`, which exercises `KatharaService.update_settings`'s own
manager_type lock by calling it directly with a plain dict (bypassing the schema entirely — that
test predates this one and still describes the service layer correctly). These tests are about the
schema boundary itself: what `PUT /api/settings` accepts before anything reaches the service.
"""

import pytest
from fastapi.testclient import TestClient
from Kathara.setting.Setting import Setting
from pydantic import ValidationError

from kathara_api.dependencies import get_service
from kathara_api.main import create_app
from kathara_api.schemas.settings import SettingsUpdate, SettingsView
from kathara_api.services.kathara_service import KatharaService
from kathara_api.services.lab_store import LabStore
from tests.helpers import FakeFacadeBase


@pytest.fixture(autouse=True)
def _restore_device_shell():
    # update_settings applies to the real, process-global Setting singleton (see
    # test_settings_update.py's identical concern for manager_type) — restore what this file's one
    # mutating test (test_put_settings_with_a_known_field_still_works) changes.
    original = Setting.get_instance().device_shell
    yield
    Setting.get_instance().load_from_dict({"device_shell": original})


def test_settings_update_accepts_every_known_field():
    SettingsUpdate(
        manager_type="docker",
        image="kathara/base",
        terminal="xterm",
        open_terminals=True,
        device_shell="/bin/bash",
        net_prefix="kathara",
        device_prefix="kathara",
        debug_level="INFO",
        print_startup_log=True,
        enable_ipv6=False,
        volume_mount_policy="Always",
        hosthome_mount=False,
        shared_mount=True,
        image_update_policy="Prompt",
        shared_cds=1,
        network_plugin="kathara/katharanp_vde",
    )


@pytest.mark.parametrize("key,value", [("remote_url", "tcp://evil:2375"), ("cert_path", "/tmp/x"), ("last_checked", 0)])
def test_settings_update_rejects_fields_removed_from_the_write_surface(key, value):
    # remote_url/cert_path: redirecting this backend's Docker client to an arbitrary daemon has no
    # legitimate runtime use case here. last_checked: this project's own bookkeeping, never meant
    # to be client-writable (the frontend already excludes it before submitting).
    with pytest.raises(ValidationError):
        SettingsUpdate(**{key: value})


def test_settings_update_rejects_an_unknown_key():
    # This is the E8 fix itself: extra="allow" used to forward any key Kathara's Setting/
    # DockerSettingsAddon happened to expose, unvalidated, straight to Setting.load_from_dict.
    with pytest.raises(ValidationError):
        SettingsUpdate(some_setting_this_schema_does_not_know="x")


def test_settings_view_still_reads_remote_url_and_cert_path():
    # Read-only: a value set outside this API (~/.kathara.conf) stays visible for diagnosis even
    # though PUT can no longer set it.
    view = SettingsView(manager_type="docker", image="kathara/base", remote_url="tcp://host:2375", cert_path="/certs")
    assert view.remote_url == "tcp://host:2375"
    assert view.cert_path == "/certs"


@pytest.fixture
def client_and_service(tmp_path):
    service = KatharaService(store=LabStore(tmp_path / "labs"))
    service._instance = FakeFacadeBase()
    app = create_app()
    app.dependency_overrides[get_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    app.dependency_overrides.clear()


def test_put_settings_with_remote_url_is_rejected_with_422(client_and_service):
    client, _service = client_and_service
    resp = client.put("/api/settings", json={"remote_url": "tcp://evil:2375"})
    assert resp.status_code == 422


def test_put_settings_with_unknown_key_is_rejected_with_422(client_and_service):
    client, _service = client_and_service
    resp = client.put("/api/settings", json={"totally_made_up_setting": True})
    assert resp.status_code == 422


def test_put_settings_with_a_known_field_still_works(client_and_service):
    client, _service = client_and_service
    resp = client.put("/api/settings", json={"device_shell": "/bin/zsh"})
    assert resp.status_code == 200
    assert resp.json()["device_shell"] == "/bin/zsh"
