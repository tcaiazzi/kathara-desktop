"""Unit tests for KatharaService.update_settings's manager_type-scoped lock."""

import pytest
from Kathara.setting.Setting import Setting

from kathara_api.config import get_settings
from kathara_api.errors import SettingsLockedError
from kathara_api.services.kathara_service import KatharaService


@pytest.fixture(autouse=True)
def _restore_manager_type():
    original = Setting.get_instance().manager_type
    api_settings = get_settings()
    original_max_files = api_settings.max_files_per_lab
    yield
    Setting.get_instance().load_from_dict({"manager_type": original})
    api_settings.max_files_per_lab = original_max_files


def test_import_limit_keys_are_not_forwarded_to_kathara_setting():
    # max_files_per_lab isn't a Kathara Setting/DockerSettingsAddon field — Setting.load_from_dict
    # would silently `setattr` it anyway (no validation there), which would work by accident today
    # but leave a ghost attribute nothing reads. It must land on ApiSettings instead.
    service = KatharaService()
    service._instance = object()

    service.update_settings({"max_files_per_lab": 3})

    assert get_settings().max_files_per_lab == 3
    assert not hasattr(Setting.get_instance(), "max_files_per_lab")


def test_non_manager_type_settings_update_freely_after_facade_init():
    service = KatharaService()
    service._instance = object()

    service.update_settings({"device_shell": "/bin/zsh"})

    assert Setting.get_instance().device_shell == "/bin/zsh"


def test_manager_type_change_rejected_after_facade_init():
    service = KatharaService()
    service._instance = object()
    current = Setting.get_instance().manager_type
    other = next(k for k in ("docker", "kubernetes") if k != current)

    with pytest.raises(SettingsLockedError):
        service.update_settings({"manager_type": other})

    assert Setting.get_instance().manager_type == current


def test_manager_type_resubmitted_unchanged_is_not_rejected():
    service = KatharaService()
    service._instance = object()
    current = Setting.get_instance().manager_type

    service.update_settings({"manager_type": current, "device_shell": "/bin/sh"})

    assert Setting.get_instance().device_shell == "/bin/sh"


def test_manager_type_change_allowed_before_facade_init():
    service = KatharaService()
    assert service._instance is None
    other = next(k for k in ("docker", "kubernetes") if k != Setting.get_instance().manager_type)

    service.update_settings({"manager_type": other})

    assert Setting.get_instance().manager_type == other
