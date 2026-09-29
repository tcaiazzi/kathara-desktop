"""Lets Kathara's Docker manager create privileged devices from a backend that isn't root.

``DockerMachine.create`` refuses a privileged device unless ``utils.is_admin()`` holds — a policy
of Kathara's CLI, not a Docker requirement: any user who can reach the daemon can create a
privileged container. This backend never runs as root, and decides for itself who may start a
privileged device: ``KatharaService.deploy_lab`` checks a grant the desktop shell issues only
after the user's own password (``services/deploy_grants.py``), and it is the only path that
creates devices. So Kathara's check has to go, and only that one.

Only ``DockerMachine``'s module global ``utils`` is replaced, with a proxy that answers
``is_admin()`` with True and delegates every other name. ``Kathara.utils`` itself is untouched, so
every other caller still sees the real UID: ``DockerLink``'s external collision domains, which do
need root to create host interfaces, and ``GET /api/system``'s ``is_admin``. The one other
``is_admin()`` read in ``DockerMachine`` is ``get_machines_stats(user=None)``, which this backend
never calls (``KatharaService`` streams stats its own way).

A module global, not a context variable: Kathara creates devices on a ``multiprocessing.dummy``
thread pool, where a context variable set by the caller is not seen.
"""

import types

import Kathara.utils
from Kathara.manager.docker import DockerMachine


class _UtilsWithoutRootCheck(types.ModuleType):
    """``Kathara.utils``, except that ``is_admin()`` is always True."""

    def __init__(self, wrapped: types.ModuleType) -> None:
        super().__init__(wrapped.__name__, wrapped.__doc__)
        self._wrapped = wrapped

    def __getattr__(self, name: str):
        return getattr(self._wrapped, name)

    @staticmethod
    def is_admin() -> bool:
        return True


def allow_privileged_devices_without_root() -> None:
    """Install the proxy on ``DockerMachine``. Idempotent."""
    if not isinstance(DockerMachine.utils, _UtilsWithoutRootCheck):
        DockerMachine.utils = _UtilsWithoutRootCheck(Kathara.utils)
