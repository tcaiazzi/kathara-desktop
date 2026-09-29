"""Start uvicorn with the pairing secrets read from stdin rather than from the command line.

For the desktop shell's elevated start on Linux (services/desktop/src/backend.ts's
runElevatedLinux). `sudo` resets the environment, so every other setting reaches this process as
`sudo env KEY=value … python …` — a command line any local user can read in /proc/<pid>/cmdline
for as long as the backend runs, and that sudo writes to the system log. The two secrets follow
the password on sudo's stdin instead, one ``KEY=value`` line each.

It also ties this process's life to sudo's (``die_with_parent``): the shell can signal sudo but not
this root process, so sudo is the only handle it has on the backend.

Usage: ``python -m kathara_api.stdin_secrets <uvicorn arguments>``
"""

import ctypes
import os
import signal
import sys
from typing import Iterable

SECRET_KEYS = ("KATHARA_API_AUTH_TOKEN", "KATHARA_API_SHELL_TOKEN")

# <linux/prctl.h>
_PR_SET_PDEATHSIG = 1


def die_with_parent() -> None:
    """Linux: have the kernel SIGKILL this process as soon as its parent — sudo — dies.

    When a backend stops answering, the shell's last resort is SIGKILL to sudo
    (services/desktop/src/backend.ts's stopBackend), and sudo cannot pass a SIGKILL on. Without
    this, the root backend would outlive it, still listening, while the shell counts it as gone. A
    normal shutdown never trips it: this process exits first, and sudo after it. The parent is
    checked again once the request is in place, in case sudo died before it was.
    """
    if not sys.platform.startswith("linux"):
        return
    parent = os.getppid()
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(_PR_SET_PDEATHSIG, int(signal.SIGKILL), 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    except (OSError, AttributeError) as exc:
        print(f"warning: could not tie the backend to its parent process: {exc}", file=sys.stderr)
        return
    if os.getppid() != parent:
        sys.exit("refusing to start: the parent process exited during startup")


def read_secrets(lines: Iterable[str]) -> dict[str, str]:
    """The ``KEY=value`` lines naming ``SECRET_KEYS``, read until all of them are found or the input
    ends. Any other line is skipped: under a NOPASSWD sudoers rule sudo never reads the password,
    which then arrives here first."""
    found: dict[str, str] = {}
    for line in lines:
        key, sep, value = line.rstrip("\r\n").partition("=")
        if sep and key in SECRET_KEYS and value:
            found[key] = value
            if len(found) == len(SECRET_KEYS):
                break
    return found


def main() -> None:
    die_with_parent()
    secrets = read_secrets(sys.stdin)
    missing = [key for key in SECRET_KEYS if key not in secrets]
    if missing:
        # Starting anyway would put a root backend on loopback with no auth at all.
        sys.exit(f"refusing to start: {', '.join(missing)} not received on stdin")
    os.environ.update(secrets)

    from uvicorn.main import main as uvicorn_main

    sys.argv = ["uvicorn", *sys.argv[1:]]
    uvicorn_main()


if __name__ == "__main__":
    main()
