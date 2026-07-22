"""Low-level Docker exec-socket mechanics backing the interactive live-TTY websocket bridge.

Kept separate from ``routers/exec.py`` so the router only handles the websocket/JSON protocol;
everything that reaches into the Docker SDK's exec API and its raw transport socket lives here.
"""

import io

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
