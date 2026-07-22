"""Application configuration, sourced from environment variables (prefix ``KATHARA_API_``)."""

from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # Kathara settings applied via Setting.load_from_dict() before the first backend use.
    manager_type: Optional[str] = None
    default_image: Optional[str] = Field(default=None)

    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def labs_dir_path(self) -> Path:
        """Absolute path to the lab storage root."""
        return Path(self.labs_dir).expanduser().resolve()

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
