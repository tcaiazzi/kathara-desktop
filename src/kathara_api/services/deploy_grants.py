"""One-shot permissions to deploy a lab whose devices reach outside their containers.

A device that is privileged, bind-mounts a host directory, or gets the user's home mounted at
``/hosthome`` needs the user's own OS password first. The desktop shell's main process checks that
password and records a grant here (``POST /labs/{lab_id}/deploy-grant``, shell token only);
``KatharaService.deploy_lab`` consumes it. This is the single place that says what a grant covers:
exactly the host access the lab asked for when it was issued (``HostAccess``), for one deploy, for
``GRANT_TTL`` seconds. So neither a ``lab.conf`` edit made after the password nor a second deploy
rides on it.
"""

import threading
import time
from dataclasses import dataclass
from typing import Optional

# Long enough for the deploy request that follows the password prompt, which comes straight after
# it; short enough that a grant nobody used is gone before anything else could use it.
GRANT_TTL = 60.0


@dataclass(frozen=True)
class HostAccess:
    """What a set of devices would get on the host: which are privileged, which host directories
    they mount (``(device, host_path, guest_path, mode)``), and whether ``/hosthome`` is mounted."""

    privileged: frozenset[str] = frozenset()
    volumes: frozenset[tuple[str, str, str, str]] = frozenset()
    hosthome: bool = False

    def is_empty(self) -> bool:
        return not (self.privileged or self.volumes or self.hosthome)

    def beyond(self, granted: Optional["HostAccess"]) -> "HostAccess":
        """The part of this access that ``granted`` does not cover (all of it, with no grant)."""
        if granted is None:
            return self
        return HostAccess(
            privileged=self.privileged - granted.privileged,
            volumes=self.volumes - granted.volumes,
            hosthome=self.hosthome and not granted.hosthome,
        )

    def describe(self) -> str:
        """One sentence naming every item, for the refusal a deploy answers with."""
        items = [f"device `{name}` is privileged" for name in sorted(self.privileged)]
        items += [
            f"device `{device}` mounts `{host}` at `{guest}` ({mode})"
            for device, host, guest, mode in sorted(self.volumes)
        ]
        if self.hosthome:
            items.append("the host home directory is mounted at `/hosthome`")
        return "; ".join(items)


class DeployGrants:
    """The grants issued and not yet used, by lab id. Thread-safe."""

    def __init__(self, ttl: float = GRANT_TTL) -> None:
        self._ttl = ttl
        self._lock = threading.Lock()
        self._grants: dict[str, tuple[HostAccess, float]] = {}

    def grant(self, lab_id: str, access: HostAccess) -> None:
        """Record ``access`` for the next deploy of ``lab_id``, replacing any grant it still had."""
        with self._lock:
            self._grants[lab_id] = (access, time.monotonic() + self._ttl)

    def consume(self, lab_id: str) -> Optional[HostAccess]:
        """Take ``lab_id``'s grant, if it has one that has not expired. Either way it is gone after
        this call: a grant serves one deploy attempt, successful or not."""
        with self._lock:
            entry = self._grants.pop(lab_id, None)
        if entry is None:
            return None
        access, expires_at = entry
        return access if time.monotonic() < expires_at else None
