"""Unit tests for KatharaService.update_settings's manager_type-scoped lock."""

import threading

import pytest
from Kathara.setting.Setting import Setting

from kathara_api.config import get_settings
from kathara_api.errors import SettingsLockedError
from kathara_api.services.kathara_service import KatharaService

from tests.helpers import make_service


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
    service = make_service(facade=object())

    service.update_settings({"max_files_per_lab": 3})

    assert get_settings().max_files_per_lab == 3
    assert not hasattr(Setting.get_instance(), "max_files_per_lab")


def test_non_manager_type_settings_update_freely_after_facade_init():
    service = make_service(facade=object())

    service.update_settings({"device_shell": "/bin/zsh"})

    assert Setting.get_instance().device_shell == "/bin/zsh"


def test_manager_type_change_rejected_after_facade_init():
    service = make_service(facade=object())
    current = Setting.get_instance().manager_type
    other = next(k for k in ("docker", "kubernetes") if k != current)

    with pytest.raises(SettingsLockedError):
        service.update_settings({"manager_type": other})

    assert Setting.get_instance().manager_type == current


def test_manager_type_resubmitted_unchanged_is_not_rejected():
    service = make_service(facade=object())
    current = Setting.get_instance().manager_type

    service.update_settings({"manager_type": current, "device_shell": "/bin/sh"})

    assert Setting.get_instance().device_shell == "/bin/sh"


def test_manager_type_change_allowed_before_facade_init():
    service = KatharaService()
    assert service._instance is None
    other = next(k for k in ("docker", "kubernetes") if k != Setting.get_instance().manager_type)

    service.update_settings({"manager_type": other})

    assert Setting.get_instance().manager_type == other


def test_update_settings_waits_for_mutate_lock_held_elsewhere():
    """update_settings mutates the process-wide Setting/ApiSettings singletons, so it takes
    `_mutate_lock` like every other mutator on this service."""
    service = make_service(facade=object())

    holder_entered = threading.Event()
    release = threading.Event()

    def hold_lock():
        with service._mutate_lock:
            holder_entered.set()
            release.wait(timeout=2)

    holder = threading.Thread(target=hold_lock)
    holder.start()
    assert holder_entered.wait(timeout=2)

    done = threading.Event()

    def run_update():
        service.update_settings({"device_shell": "/bin/sh"})
        done.set()

    updater = threading.Thread(target=run_update)
    updater.start()

    assert not done.wait(timeout=0.3), (
        "update_settings returned while another thread held _mutate_lock — it is no longer "
        "serialized against other mutators"
    )

    release.set()
    holder.join(timeout=2)
    updater.join(timeout=2)
    assert done.is_set()
    assert Setting.get_instance().device_shell == "/bin/sh"
