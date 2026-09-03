"""Application configuration, sourced from environment variables (prefix ``KATHARA_API_``)."""

import re
from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# owner/repo, GitHub's own charset for both halves — see ApiSettings.gallery_slug.
_GALLERY_SLUG_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$")


class ApiSettings(BaseSettings):
    """Server settings and Kathara overrides applied at startup."""

    model_config = SettingsConfigDict(env_prefix="KATHARA_API_", env_file=".env", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8000

    # Comma-separated allowed origins for CORS (e.g. "http://localhost:5173,http://localhost:3000").
    # Empty by default: same-origin only, until a separate frontend is actually deployed.
    cors_origins: str = ""

    # Directory under which every lab is persisted as a real Kathara lab directory, so labs
    # survive a server restart (the in-memory registry alone does not). A plain named volume is
    # sufficient in Docker Compose: machine files/startup always travel to containers over the
    # Docker API (Machine.pack_data), and Kathara's native `/shared` bind mount is disabled
    # per-lab (see lab_builder.build_lab), so nothing here is ever bind-mounted into a device.
    labs_dir: str = "./data/labs"

    # Directory holding the built frontend (services/frontend/dist). Unset by default: the SPA
    # is normally served by Vite in dev and by the nginx reverse proxy in Docker Compose. The
    # desktop app has neither, so it sets this and lets this process serve the SPA itself,
    # keeping the renderer same-origin with the API (see spa.mount_spa).
    static_dir: Optional[str] = None

    # Directory holding the bundled example network scenarios (kathara_api/examples/ package
    # data), offered as "start from an example" on the frontend's welcome screen. Unset means
    # "use the bundled ones" — an override exists only so a deployment can ship its own catalog
    # (e.g. a course's own lab set) without rebuilding this package.
    examples_dir: Optional[str] = None

    # Upstream lab gallery (services/lab_gallery.py): the GitHub repo browsed by the frontend's
    # "Browse Kathara Labs" modal. Overridable for the same reason as examples_dir above — a course
    # can point the IDE at its own fork without rebuilding this package.
    gallery_repo: str = "KatharaFramework/Kathara-Labs"
    gallery_ref: str = "main"
    # Subtree of the repo to offer. Everything outside it is ignored, so a repo that also holds
    # exams or solutions doesn't leak them into the catalog.
    gallery_section: str = "main-labs"
    # Seconds a fetched catalog is reused. The catalog costs one GitHub API call and changes
    # rarely; unauthenticated GitHub allows 60 calls/hour per IP, which a shared university NAT
    # can exhaust, so the default is deliberately generous.
    gallery_cache_ttl: int = 900
    # Optional GitHub token, sent as a bearer token on API calls to lift that 60/hour limit. Only
    # public repos are ever read, so a token needs no scopes.
    gallery_token: Optional[str] = None

    # Kathara settings applied via Setting.load_from_dict() before the first backend use.
    manager_type: Optional[str] = None
    default_image: Optional[str] = Field(default=None)

    # Shared secret pairing a single launched backend with its own frontend (the desktop app
    # generates one per launch — see services/desktop/src/backend.ts). Unset by default: every
    # other deployment (Docker Compose, dev) keeps today's no-auth behavior untouched (see
    # dependencies.require_auth_token).
    auth_token: Optional[str] = None

    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def labs_dir_path(self) -> Path:
        """Absolute path to the lab storage root."""
        return Path(self.labs_dir).expanduser().resolve()

    def static_dir_path(self) -> Optional[Path]:
        """Absolute path to the built frontend, or None if not configured or absent.

        A configured-but-missing directory is treated as "not configured" rather than an
        error: the API must still start and serve /api even when the frontend hasn't been
        built yet.
        """
        configured = (self.static_dir or "").strip()
        if not configured:
            return None
        path = Path(configured).expanduser().resolve()
        return path if path.is_dir() else None

    def examples_dir_path(self) -> Path:
        """Absolute path to the examples catalog: a configured override, or the bundled one.

        Unlike static_dir_path, never None: the bundled directory (kathara_api/examples/) always
        exists as package data, so there is always a catalog to read, even if it turns out empty.
        """
        configured = (self.examples_dir or "").strip()
        if configured:
            return Path(configured).expanduser().resolve()
        return Path(__file__).resolve().parent / "examples"

    def gallery_slug(self) -> str:
        """``owner/repo`` for the configured gallery, validated.

        The slug is interpolated straight into the GitHub API and raw.githubusercontent URLs, so a
        value containing ``/``-separated extra segments, ``..`` or a query string would let a
        mis-set env var point the fetcher somewhere else entirely. Rejecting it here keeps every
        URL builder in lab_gallery.py free of that concern.
        """
        slug = (self.gallery_repo or "").strip().strip("/")
        if not _GALLERY_SLUG_RE.match(slug):
            raise ValueError(
                f"KATHARA_API_GALLERY_REPO must be `owner/repo`, got {self.gallery_repo!r}"
            )
        return slug

    def gallery_section_path(self) -> str:
        """The gallery subtree, normalized to a bare relative posix path ("" means the whole repo)."""
        return (self.gallery_section or "").strip().strip("/")

    def kathara_overrides(self) -> dict:
        """Return the subset of settings to forward to Kathara's Setting."""
        overrides: dict = {}
        if self.manager_type:
            overrides["manager_type"] = self.manager_type
        if self.default_image:
            overrides["image"] = self.default_image
        return overrides


_settings: Optional[ApiSettings] = None


def get_settings() -> ApiSettings:
    global _settings
    if _settings is None:
        _settings = ApiSettings()
    return _settings
