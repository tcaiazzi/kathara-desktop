"""Schemas for Kathara settings and system information."""

from typing import Optional

from pydantic import BaseModel, ConfigDict


class SystemInfo(BaseModel):
    """Environment information about the running Kathara manager."""

    manager: str
    version: str
    available_managers: dict[str, str]
    # Whether this process's real UID is 0 — Kathara's own gate for privileged devices
    # (DockerMachine.create -> Kathara.utils.is_admin()) checks the process's real UID, not
    # Docker socket access, so this is what the frontend needs to know before offering an
    # elevation prompt for a lab with privileged devices.
    is_admin: bool


class SettingsView(BaseModel):
    """A safe view of the current Kathara settings — the full field surface of ``Setting`` (core)
    plus the Docker addon (the only manager this project supports), so a response never carries a
    key this schema doesn't already know about.

    ``remote_url``/``cert_path`` are readable here but absent from ``SettingsUpdate`` below: see
    that class's docstring for why.
    """

    manager_type: str
    image: str
    terminal: Optional[str] = None
    open_terminals: Optional[bool] = None
    device_shell: Optional[str] = None
    net_prefix: Optional[str] = None
    device_prefix: Optional[str] = None
    debug_level: Optional[str] = None
    print_startup_log: Optional[bool] = None
    enable_ipv6: Optional[bool] = None
    volume_mount_policy: Optional[str] = None
    # Read-only internal bookkeeping (last GitHub-release-check time) — display only. Absent from
    # `SettingsUpdate`, not just unused by the frontend: see that class's docstring.
    last_checked: Optional[float] = None
    # Docker addon (the only manager_type this project exposes as selectable).
    hosthome_mount: Optional[bool] = None
    shared_mount: Optional[bool] = None
    image_update_policy: Optional[str] = None
    shared_cds: Optional[int] = None
    remote_url: Optional[str] = None
    cert_path: Optional[str] = None
    network_plugin: Optional[str] = None

    # A future/older Kathara version could plausibly add or drop an addon field; tolerate an
    # unknown key here (in the response we build ourselves) rather than fail the whole request —
    # unlike SettingsUpdate below, dropping an unrecognized key from what we return is harmless.
    model_config = ConfigDict(extra="ignore")


class SettingsUpdate(BaseModel):
    """Settings overrides forwarded to ``Setting.load_from_dict``.

    Every field Kathara's ``Setting.load_from_dict`` would actually apply is named explicitly, and
    ``extra="forbid"`` rejects anything else with a 422 — this used to be ``extra="allow"``, which
    let a client set *any* attribute ``Setting``/``DockerSettingsAddon`` expose, unvalidated,
    including two genuinely dangerous ones:

    - ``hosthome_mount`` bind-mounts this process's real ``$HOME`` into every device this backend
      deploys from then on (``DockerMachine.py``: ``volumes[get_current_user_home()] = {'bind':
      '/hosthome', ...}``) — kept here, but gated by the frontend exactly like a lab's own host
      volumes are before a deploy (see ``SettingsPage.tsx``'s submit handler).
    - ``remote_url`` repoints this process's *entire* Docker client at an arbitrary daemon
      (``DockerManager.py``: ``docker.DockerClient(base_url=remote_url, ...)``) — every deploy,
      exec and wipe this backend performs afterward targets whatever host is named. There is no
      legitimate reason a REST client of a local tool needs to redo that at runtime, so it — and
      ``cert_path``, the TLS material for that same redirected daemon — are simply not writable
      through this API at all; changing them means editing Kathara's own settings file
      (``~/.config/kathara.conf``) and restarting.

    ``last_checked`` is also absent: it is this project's own bookkeeping of when it last polled
    GitHub for a release, and the frontend already never sends it back (see the comment in
    ``SettingsPage.tsx``'s submit handler) — modeling it here as a writable field would just be an
    invitation nothing currently uses correctly.
    """

    manager_type: Optional[str] = None
    image: Optional[str] = None
    terminal: Optional[str] = None
    open_terminals: Optional[bool] = None
    device_shell: Optional[str] = None
    net_prefix: Optional[str] = None
    device_prefix: Optional[str] = None
    debug_level: Optional[str] = None
    print_startup_log: Optional[bool] = None
    enable_ipv6: Optional[bool] = None
    volume_mount_policy: Optional[str] = None
    hosthome_mount: Optional[bool] = None
    shared_mount: Optional[bool] = None
    image_update_policy: Optional[str] = None
    shared_cds: Optional[int] = None
    network_plugin: Optional[str] = None

    model_config = ConfigDict(extra="forbid")
