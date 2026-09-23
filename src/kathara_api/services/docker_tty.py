"""Low-level Docker exec-socket mechanics backing the interactive live-TTY websocket bridge.

Kept separate from ``routers/exec.py`` so the router only handles the websocket/JSON protocol;
everything that reaches into the Docker SDK's exec API and its raw transport socket lives here.
"""

import asyncio
import io
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from ..config import get_settings

# A dedicated pool for TTY session I/O, separate from asyncio's default executor
# (min(32, cpu+4)) that every other `asyncio.to_thread` call in the app shares — including
# get_machine_api_object, used to open the *next* terminal. A live session holds one of these
# threads for as long as it stays open (read() blocks in a loop), so without this isolation a
# handful of open terminals can starve every other blocking Docker call in the process (see
# docs/DESIGN-NOTES.md). Sized from settings so it doubles as the session cap enforced in
# routers/exec.py:tty_live_ws — read when the first session opens, not at import: the settings
# singleton is read at point of use everywhere else precisely because it is mutable, and pinning
# it here would also force it into existence before the process has finished configuring itself.
#
# Built on demand, and rebuilt after a shutdown rather than being a true one-shot singleton:
# `create_app()` (and so this module's shutdown hook) can run more than once per process — every
# test that builds its own app does — and a one-shot executor would leave every app instance
# after the first unable to schedule any TTY work at all. `None` is that "needs building" state.
_TTY_EXECUTOR: Optional[ThreadPoolExecutor] = None
_tty_executor_lock = threading.Lock()


def _get_tty_executor() -> ThreadPoolExecutor:
    global _TTY_EXECUTOR
    with _tty_executor_lock:
        if _TTY_EXECUTOR is None:
            _TTY_EXECUTOR = ThreadPoolExecutor(
                max_workers=get_settings().tty_max_sessions, thread_name_prefix="kathara-tty"
            )
        return _TTY_EXECUTOR


def shutdown_tty_executor() -> None:
    """Stop accepting new TTY work and abandon whatever is still blocked in a read/write.

    Called from main.py's lifespan on shutdown. `wait=False` is deliberate: a session thread can
    be blocked in a read for as long as its terminal stays open, and the process is exiting
    anyway — there is nothing to gain from waiting for it.
    """
    global _TTY_EXECUTOR
    with _tty_executor_lock:
        if _TTY_EXECUTOR is not None:
            _TTY_EXECUTOR.shutdown(wait=False, cancel_futures=True)
            _TTY_EXECUTOR = None


SHELL_PATHS = {
    "bash": "/bin/bash",
    "sh": "/bin/sh",
    "ash": "/bin/ash",
    "zsh": "/bin/zsh",
}


def resolve_shell_path(shell: str) -> str:
    """Map a shell name to its path, or raise ``RuntimeError`` for an unsupported one."""
    shell_cmd = SHELL_PATHS.get((shell or "bash").strip().lower())
    if shell_cmd is None:
        raise RuntimeError("Unsupported shell. Allowed values: bash, sh, ash, zsh.")
    return shell_cmd


def _iter_socket_transports(root):
    """BFS-walk a docker exec socket's `_sock`/`socket`/`raw` wrapper chain.

    Docker/urllib3/socket wrappers hide the actual readable/writable transport under one of
    these attributes depending on SDK version; walk them breadth-first until a caller finds a
    usable reader/writer method on one of the yielded objects.
    """
    seen: set[int] = set()
    queue = [root]
    while queue:
        obj = queue.pop(0)
        if obj is None or id(obj) in seen:
            continue
        seen.add(id(obj))
        yield obj
        for attr in ("_sock", "socket", "raw"):
            nested = getattr(obj, attr, None)
            if nested is not None:
                queue.append(nested)


def _write_exec_socket(exec_socket, data: bytes) -> None:
    """Write bytes to a docker exec socket across SDK transport variants."""
    attempts: list[str] = []

    def _attempt_write(target) -> bool:
        if target is None:
            return False

        # Prefer socket-like methods; keep `write` as a fallback only.
        for name in ("sendall", "send", "write"):
            fn = getattr(target, name, None)
            if not callable(fn):
                continue
            try:
                fn(data)
                return True
            except (AttributeError, io.UnsupportedOperation, OSError, RuntimeError, TypeError, ValueError) as exc:
                attempts.append(f"{type(target).__name__}.{name}: {exc}")
                continue

        return False

    for target in _iter_socket_transports(exec_socket):
        if _attempt_write(target):
            return

    if attempts:
        detail = "; ".join(attempts)
        raise RuntimeError(f"Unsupported docker exec socket type: cannot write input ({detail}).")
    raise RuntimeError("Unsupported docker exec socket type: cannot write input (no candidate writer methods found).")


def _read_exec_socket(exec_socket, size: int) -> bytes:
    """Read bytes from a docker exec socket across SDK transport variants."""
    attempts: list[str] = []

    for target in _iter_socket_transports(exec_socket):
        for name in ("recv", "read"):
            fn = getattr(target, name, None)
            if not callable(fn):
                continue
            try:
                chunk = fn(size)
            except (AttributeError, io.UnsupportedOperation, OSError, RuntimeError, TypeError, ValueError) as exc:
                attempts.append(f"{type(target).__name__}.{name}: {exc}")
                continue

            if chunk is None:
                return b""
            if isinstance(chunk, bytes):
                return chunk
            if isinstance(chunk, str):
                return chunk.encode("utf-8", errors="ignore")
            attempts.append(f"{type(target).__name__}.{name}: unexpected return type {type(chunk).__name__}")

    if attempts:
        detail = "; ".join(attempts)
        raise RuntimeError(f"Unsupported docker exec socket type: cannot read output ({detail}).")
    raise RuntimeError("Unsupported docker exec socket type: cannot read output (no candidate reader methods found).")


class DockerTtySession:
    """An interactive Docker exec session (create, read, write, resize, close)."""

    def __init__(self, client, container_id: str, shell: str) -> None:
        self._client = client
        self._container_id = container_id
        self._shell_cmd = resolve_shell_path(shell)
        self._exec_id: str | None = None
        self._socket = None

    def start(self) -> None:
        created = self._client.exec_create(
            self._container_id,
            cmd=[self._shell_cmd],
            stdin=True,
            stdout=True,
            stderr=True,
            tty=True,
        )
        self._exec_id = created.get("Id")
        if not self._exec_id:
            raise RuntimeError("Failed to create Docker exec session.")
        self._socket = self._client.exec_start(self._exec_id, tty=True, stream=False, socket=True)

    def read(self, size: int = 4096) -> bytes:
        return _read_exec_socket(self._socket, size)

    def write(self, data: bytes) -> None:
        _write_exec_socket(self._socket, data)

    def resize(self, cols: int, rows: int) -> None:
        self._client.exec_resize(self._exec_id, height=rows, width=cols)

    def close(self) -> None:
        close = getattr(self._socket, "close", None)
        if callable(close):
            close()

    # -- async wrappers, routed onto the dedicated TTY executor ---------------------------------
    #
    # Parallel to the sync methods above rather than replacing them, so a test double can still
    # implement (or override) just the sync ones. routers/exec.py:tty_live_ws uses only these.

    async def astart(self) -> None:
        await asyncio.get_running_loop().run_in_executor(_get_tty_executor(), self.start)

    async def aread(self, size: int = 4096) -> bytes:
        return await asyncio.get_running_loop().run_in_executor(_get_tty_executor(), self.read, size)

    async def awrite(self, data: bytes) -> None:
        await asyncio.get_running_loop().run_in_executor(_get_tty_executor(), self.write, data)

    async def aresize(self, cols: int, rows: int) -> None:
        await asyncio.get_running_loop().run_in_executor(_get_tty_executor(), self.resize, cols, rows)

    async def aclose(self) -> None:
        await asyncio.get_running_loop().run_in_executor(_get_tty_executor(), self.close)
