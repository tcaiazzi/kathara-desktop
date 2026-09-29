"""Schemas for Kathara settings and system information."""

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class SystemInfo(BaseModel):
    """Environment information about the running Kathara manager."""

    manager: str
    # None when the Docker daemon can't be reached: this is the *daemon's* version
    # (`client.version()["Version"]`), the only field here that needs it. Every other field stays
    # accurate with Docker stopped, which is why this endpoint answers instead of 503-ing — see
    # `KatharaService.system_info`.
    version: Optional[str] = None
    available_managers: dict[str, str]
    # Whether this process's real UID is 0 (Kathara.utils.is_admin). Without a desktop shell to
    # grant them, privileged devices start only when it is (KatharaService._authorize_host_access),
    # so a browser build asks this before deploying one.
    is_admin: bool


class SettingsView(BaseModel):
    """A safe view of the current Kathara settings — the full field surface of ``Setting`` (core)
    plus the Docker addon (the only manager this project supports), so a response never carries a
    key this schema doesn't already know about.

    The Kathara settings are the ones saved in ``settings_file`` (``kathara.conf``, shared with
    the Kathara CLI) — see ``KatharaService.load_persisted_settings``.

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
    # Read-only: the Kathara CLI's own bookkeeping of when it last checked GitHub for a newer
    # Kathara release. This backend never checks. Absent from `SettingsUpdate`: see that class's
    # docstring.
    last_checked: Optional[float] = None
    # Docker addon (the only manager_type this project exposes as selectable).
    hosthome_mount: Optional[bool] = None
    shared_mount: Optional[bool] = None
    image_update_policy: Optional[str] = None
    shared_cds: Optional[int] = None
    remote_url: Optional[str] = None
    cert_path: Optional[str] = None
    network_plugin: Optional[str] = None
    # This project's own upload/import caps (ApiSettings in config.py) — not a Kathara
    # `Setting`/`DockerSettingsAddon` field at all, shown on the Settings page's own tab for this
    # app. A change here is NOT saved to kathara.conf: it mutates the in-process `ApiSettings`
    # singleton, which reads `KATHARA_API_MAX_*` (or the built-in default) when the process starts.
    # The desktop app keeps the values and passes them as those env vars to every backend it
    # starts (services/desktop/src/uploadLimits.ts); anywhere else they last until the backend
    # exits.
    max_files_per_lab: Optional[int] = None
    max_bytes_per_file: Optional[int] = None
    max_bytes_per_lab: Optional[int] = None
    # Read-only, about the file itself rather than a setting: its path; why it could not be read
    # (the defaults are in use and saving is refused until it is fixed); and the values in it this
    # session ignores, one sentence each.
    settings_file: Optional[str] = None
    settings_file_error: Optional[str] = None
    settings_warnings: list[str] = []

    # A future/older Kathara version could plausibly add or drop an addon field; tolerate an
    # unknown key here (in the response we build ourselves) rather than fail the whole request —
    # unlike SettingsUpdate below, dropping an unrecognized key from what we return is harmless.
    model_config = ConfigDict(extra="ignore")


class SettingsUpdate(BaseModel):
    """Settings changes forwarded to ``Setting.load_from_dict`` and saved to ``kathara.conf``.

    Every field Kathara's ``Setting.load_from_dict`` would actually apply is named explicitly, and
    ``extra="forbid"`` rejects anything else with a 422. ``extra="allow"`` here would let a client
    set *any* attribute ``Setting``/``DockerSettingsAddon`` exposes, unvalidated, including two
    genuinely dangerous ones:

    - ``hosthome_mount`` bind-mounts this process's real ``$HOME`` into every device this backend
      deploys from then on (``DockerMachine.py``: ``volumes[get_current_user_home()] = {'bind':
      '/hosthome', ...}``) — kept here, and confirmed by the frontend exactly like a lab's own host
      volumes are before a deploy (see ``SettingsPage.tsx``'s submit handler). A confirmation in
      the UI, not a check this API makes.
    - ``remote_url`` repoints this process's *entire* Docker client at an arbitrary daemon
      (``DockerManager.py``: ``docker.DockerClient(base_url=remote_url, ...)``) — every deploy,
      exec and wipe this backend performs afterward targets whatever host is named. There is no
      legitimate reason a REST client of a local tool needs to redo that at runtime, so it — and
      ``cert_path``, the TLS material for that same redirected daemon — are simply not writable
      through this API at all; changing them means editing Kathara's own settings file
      (``~/.config/kathara.conf``) and restarting.

    ``last_checked`` is also absent: it is the Kathara CLI's own bookkeeping of when it last checked
    GitHub for a newer release (this backend never checks), kept as the file has it on every save
    (``KatharaService._save_kathara_settings``) — modeling it here as a writable field would just
    be an invitation no caller has a correct use for.

    ``max_files_per_lab``/``max_bytes_per_file``/``max_bytes_per_lab`` are the odd ones out: they
    are not Kathara settings at all, but this project's own upload/import caps (``ApiSettings`` in
    config.py) — writable here so the Settings page can change them with the rest.
    ``update_settings`` routes them to the ``ApiSettings`` singleton instead of
    ``Setting.load_from_dict``; see that method's docstring.
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
    max_files_per_lab: Optional[int] = Field(default=None, gt=0)
    max_bytes_per_file: Optional[int] = Field(default=None, gt=0)
    max_bytes_per_lab: Optional[int] = Field(default=None, gt=0)

    model_config = ConfigDict(extra="forbid")
