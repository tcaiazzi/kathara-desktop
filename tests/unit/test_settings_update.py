"""Unit tests for KatharaService's settings: the manager_type-scoped lock, validation, and
kathara.conf — read at startup, written on every update."""

import json
import os
import threading

import pytest
from Kathara import utils
from Kathara.setting.Setting import Setting

from kathara_api.config import get_settings
from kathara_api.errors import (
    InvalidSettingsError,
    SettingsFileInvalidError,
    SettingsLockedError,
    SettingsPersistError,
)
from kathara_api.services import settings_store
from kathara_api.services.kathara_service import KatharaService
from tests.helpers import make_service


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """Every test gets its own kathara.conf directory and leaves the process-wide Setting and
    ApiSettings singletons as it found them."""
    setting = Setting.get_instance()
    original = setting.addons.merge(setting._to_dict())
    api_settings = get_settings()
    original_max_files = api_settings.max_files_per_lab
    monkeypatch.setattr(api_settings, "kathara_conf_dir", str(tmp_path))
    monkeypatch.setattr(utils, "get_current_user_uid_gid", lambda: (os.getuid(), os.getgid()))
    yield
    Setting.get_instance().load_from_dict(original)
    api_settings.max_files_per_lab = original_max_files


def _conf(tmp_path):
    return tmp_path / "kathara.conf"


def _write(tmp_path, values):
    _conf(tmp_path).write_text(json.dumps(values))


def _read(tmp_path):
    return json.loads(_conf(tmp_path).read_text())


def test_import_limit_keys_are_not_forwarded_to_kathara_setting():
    # max_files_per_lab isn't a Kathara Setting/DockerSettingsAddon field — Setting.load_from_dict
    # would silently `setattr` it anyway (no validation there), which works by accident but leaves
    # a ghost attribute nothing reads. It must land on ApiSettings instead.
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


# -- kathara.conf -------------------------------------------------------------


def test_an_update_saves_the_kathara_settings_in_the_clis_own_format(tmp_path):
    service = make_service(facade=object())

    service.update_settings({"debug_level": "DEBUG", "max_files_per_lab": 7})

    saved = _read(tmp_path)
    assert saved["debug_level"] == "DEBUG"
    assert saved["manager_type"] == "docker"
    assert "max_files_per_lab" not in saved
    assert _conf(tmp_path).stat().st_mode & 0o777 == 0o600
    # The CLI's own loader reads it back.
    Setting.get_instance().load_from_dict({"debug_level": "INFO"})
    Setting.get_instance().load_from_disk(path=str(tmp_path))
    assert Setting.get_instance().debug_level == "DEBUG"


def test_an_update_keeps_the_files_unknown_keys_and_its_last_checked(tmp_path):
    _write(tmp_path, {"debug_level": "INFO", "api_server_url": "https://k8s", "last_checked": 42.0})
    service = make_service(facade=object())

    service.update_settings({"debug_level": "ERROR"})

    saved = _read(tmp_path)
    assert saved["debug_level"] == "ERROR"
    assert saved["api_server_url"] == "https://k8s"
    assert saved["last_checked"] == 42.0


@pytest.mark.parametrize(
    "values",
    [{"net_prefix": "Bad"}, {"device_prefix": "a-b"}, {"debug_level": "FOO"}, {"image": " "}, {"image": "a b"}],
)
def test_an_invalid_value_is_rejected_before_anything_changes(tmp_path, values):
    service = make_service(facade=object())
    before = Setting.get_instance().addons.merge(Setting.get_instance()._to_dict())

    with pytest.raises(InvalidSettingsError):
        service.update_settings({"device_shell": "/bin/zsh", **values})

    assert not _conf(tmp_path).exists()
    assert Setting.get_instance().addons.merge(Setting.get_instance()._to_dict()) == before


def test_startup_without_a_file_keeps_the_defaults_and_creates_none(tmp_path):
    service = make_service(facade=object())

    service.load_persisted_settings()

    assert not _conf(tmp_path).exists()
    view = service.get_settings_view()
    assert view["settings_file"] == str(_conf(tmp_path))
    assert view["settings_file_error"] is None
    assert view["settings_warnings"] == []


def test_startup_loads_the_saved_settings(tmp_path):
    _write(tmp_path, {"debug_level": "WARNING", "net_prefix": "lab_net", "shared_cds": 2})
    service = make_service(facade=object())

    service.load_persisted_settings()

    setting = Setting.get_instance()
    assert (setting.debug_level, setting.net_prefix, setting.shared_cds) == ("WARNING", "lab_net", 2)


def test_a_corrupt_file_leaves_the_defaults_and_refuses_to_save_over_it(tmp_path):
    _conf(tmp_path).write_text("{ not json")
    service = make_service(facade=object())

    service.load_persisted_settings()
    assert service.get_settings_view()["settings_file_error"]

    shell = Setting.get_instance().device_shell
    with pytest.raises(SettingsFileInvalidError):
        service.update_settings({"device_shell": "/bin/zsh"})

    assert _conf(tmp_path).read_text() == "{ not json"
    assert Setting.get_instance().device_shell == shell


def test_an_invalid_value_in_the_file_is_ignored_with_a_warning_until_a_save_replaces_it(tmp_path):
    _write(tmp_path, {"debug_level": "LOUD", "device_shell": "/bin/sh"})
    service = make_service(facade=object())

    service.load_persisted_settings()

    assert Setting.get_instance().debug_level == "INFO"
    assert Setting.get_instance().device_shell == "/bin/sh"
    assert any("debug_level" in w for w in service.get_settings_view()["settings_warnings"])

    service.update_settings({"device_shell": "/bin/bash"})

    assert _read(tmp_path)["debug_level"] == "INFO"
    assert service.get_settings_view()["settings_warnings"] == []


def test_a_kubernetes_manager_in_the_file_runs_docker_warns_and_is_never_overwritten(tmp_path):
    _write(tmp_path, {"manager_type": "kubernetes", "debug_level": "INFO"})
    service = KatharaService()

    service.load_persisted_settings()

    assert Setting.get_instance().manager_type == "docker"
    warnings = service.get_settings_view()["settings_warnings"]
    assert len(warnings) == 1 and "Docker" in warnings[0] and "kubernetes" in warnings[0]

    service.update_settings({"manager_type": "docker", "debug_level": "ERROR"})

    saved = _read(tmp_path)
    assert saved["manager_type"] == "kubernetes"
    assert saved["debug_level"] == "ERROR"
    assert service.get_settings_view()["settings_warnings"] == warnings


def test_an_environment_override_wins_for_the_session_and_is_not_saved(tmp_path):
    _write(tmp_path, {"image": "kathara/frr"})
    service = make_service(facade=object())

    service.load_persisted_settings()
    service.apply_startup_settings({"image": "kathara/quagga"})
    assert Setting.get_instance().image == "kathara/quagga"

    service.update_settings({"image": "kathara/quagga", "debug_level": "ERROR"})
    assert _read(tmp_path)["image"] == "kathara/frr"

    service.update_settings({"image": "kathara/base"})
    assert _read(tmp_path)["image"] == "kathara/base"


def test_an_unwritable_file_rolls_the_update_back(tmp_path, monkeypatch):
    service = make_service(facade=object())
    shell = Setting.get_instance().device_shell

    def fail(*_args):
        raise PermissionError("denied")

    monkeypatch.setattr(settings_store, "write_conf", fail)

    with pytest.raises(SettingsPersistError):
        service.update_settings({"device_shell": "/bin/zsh"})

    assert Setting.get_instance().device_shell == shell
