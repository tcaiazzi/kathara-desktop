"""Kathara's settings file (``kathara.conf``), read and written the way the Kathara CLI does.

The single source of truth for where that file is, what a valid value in it looks like and how it
is written. ``KatharaService.load_persisted_settings``/``update_settings`` decide *which* values go
in; nothing else opens the file.

``Setting.load_from_disk``/``save_to_disk`` are deliberately not used: the first applies whatever
the file holds without checking it, and the second rewrites the whole file from the current
addon's keys, dropping everything else in it (another manager's keys, a value this process only
holds for its own session). ``Setting.check`` is not used either: it imports Kathara's Kubernetes
manager and asks GitHub for a release, and the three checks it makes on values are repeated in
``invalid_settings`` with the same rules and messages.
"""

import json
import os
import re
from pathlib import Path
from typing import Any, Mapping, Optional

from Kathara import utils
from Kathara.setting import Setting as kathara_setting
from Kathara.setting.Setting import AVAILABLE_DEBUG_LEVELS, SETTINGS_FILENAME

from ..config import get_settings
from ..errors import SettingsFileInvalidError

# The pattern `Setting.check` enforces on both prefixes: they become part of every container and
# network name Kathara creates.
_PREFIX_RE = re.compile(r"^[a-z]+_?[a-z_]+$")
_PREFIX_LABELS = {"net_prefix": "Networks Prefix", "device_prefix": "Device Prefix"}


def conf_path() -> Path:
    """The ``kathara.conf`` this process reads and writes.

    Kathara's own default path is resolved from the password database, not ``$HOME`` (and from
    ``SUDO_UID`` under sudo), so pointing ``HOME`` elsewhere does not move it — the
    ``kathara_conf_dir`` setting exists for a run that must not touch the user's real file.
    """
    configured = (get_settings().kathara_conf_dir or "").strip()
    if configured:
        return Path(configured).expanduser().resolve() / SETTINGS_FILENAME
    # Read from the module at call time rather than imported by name, so a test patching it wins.
    return Path(kathara_setting.DEFAULT_SETTINGS_PATH)


def read_conf(path: Path) -> Optional[dict[str, Any]]:
    """The file's contents, or ``None`` when there is no file.

    Raises ``SettingsFileInvalidError`` when the file is not a JSON object, which the CLI refuses
    too.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        values = json.loads(text)
    except ValueError:
        raise SettingsFileInvalidError(f"{path} is not valid JSON.") from None
    if not isinstance(values, dict):
        raise SettingsFileInvalidError(f"{path} does not contain a JSON object.")
    return values


def invalid_settings(values: Mapping[str, Any]) -> dict[str, str]:
    """The keys of ``values`` holding a value Kathara would refuse, each with the reason.

    Only the keys present are checked, so this serves both a partial update and a whole file.
    """
    problems: dict[str, str] = {}
    for key, label in _PREFIX_LABELS.items():
        if key in values:
            value = values[key]
            if not isinstance(value, str) or not _PREFIX_RE.match(value):
                problems[key] = f"{label} must only contain lowercase letters and underscore."
    if "debug_level" in values and values["debug_level"] not in AVAILABLE_DEBUG_LEVELS:
        problems["debug_level"] = f"Debug Level must be one of the following: {', '.join(AVAILABLE_DEBUG_LEVELS)}."
    if "image" in values:
        image = values["image"]
        # As permissive as a device's own `image` option: Docker is the one that knows which
        # references exist, and it says so at deploy time. Only what can never be one is refused.
        if not isinstance(image, str) or not image.strip() or re.search(r"\s", image):
            problems["image"] = "Default image must be an image name without spaces."
    return problems


def write_conf(path: Path, values: Mapping[str, Any]) -> None:
    """Write ``values`` to ``path`` in the CLI's own format, readable only by the real user.

    Ownership goes to the user behind sudo, as ``Setting.save_to_disk`` does, so an elevated
    backend does not leave a root-owned file the CLI can no longer read.
    """
    created_dir = not path.parent.is_dir()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(values), indent=True), encoding="utf-8")

    def unix_permissions() -> None:
        uid, gid = utils.get_current_user_uid_gid()
        os.chmod(path, 0o600)
        os.chown(path, uid, gid)
        if created_dir:
            os.chown(path.parent, uid, gid)

    utils.exec_by_platform(unix_permissions, lambda: None, unix_permissions)
