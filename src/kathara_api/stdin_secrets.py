"""Start uvicorn with the pairing secrets read from stdin rather than from the command line.

For the desktop shell's elevated start on Linux (services/desktop/src/backend.ts's
runElevatedLinux). `sudo` resets the environment, so every other setting reaches this process as
`sudo env KEY=value … python …` — a command line any local user can read in /proc/<pid>/cmdline
for as long as the backend runs, and that sudo writes to the system log. The two secrets follow
the password on sudo's stdin instead, one ``KEY=value`` line each.

Usage: ``python -m kathara_api.stdin_secrets <uvicorn arguments>``
"""

import os
import sys
from typing import Iterable

SECRET_KEYS = ("KATHARA_API_AUTH_TOKEN", "KATHARA_API_SHELL_TOKEN")


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
