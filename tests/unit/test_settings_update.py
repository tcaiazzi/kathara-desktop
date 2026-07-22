"""Unit tests for KatharaService.update_settings's manager_type-scoped lock."""

import pytest
from Kathara.setting.Setting import Setting

from kathara_api.errors import SettingsLockedError
from kathara_api.services.kathara_service import KatharaService


@pytest.fixture(autouse=True)
def _restore_manager_type():
    original = Setting.get_instance().manager_type
    yield
    Setting.get_instance().load_from_dict({"manager_type": original})


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
