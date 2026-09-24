# Kathara Desktop

A desktop app for the [Kathara](https://www.kathara.org) network-emulation framework. Design
lab topologies, edit device configs and files, deploy them as containers, and attach to
interactive shells — from a native app, with no browser tab or server to manage.

## Install

Download the installer for your platform from the
[latest release](https://github.com/KatharaFramework/kathara-desktop/releases/latest):

| Platform | File |
|---|---|
| Linux x86_64 | `Kathara-Desktop-<version>.AppImage`, or `kathara-desktop_<version>_amd64.deb` / `kathara-desktop-<version>.x86_64.rpm` |
| Linux ARM64 | `Kathara-Desktop-<version>-arm64.AppImage`, or the `_arm64.deb` / `.aarch64.rpm` of the same version |
| macOS, Apple Silicon | `Kathara-Desktop-<version>-arm64.dmg` |
| macOS, Intel | `Kathara-Desktop-<version>.dmg` |
| Windows | `Kathara-Desktop-Setup-<version>-x64.exe`, or `-arm64.exe` |

The only prerequisite is **[Docker](https://docs.docker.com/get-docker/)** — Kathara deploys each
device as a container through the host Docker socket. On Windows that means Docker Desktop with the
WSL2 backend.

Everything else is inside the installer. A packaged build **bundles a complete Python environment**:
its own interpreter plus `kathara-api-rest`, Kathara, uvicorn and their whole dependency closure,
installed for that exact platform at build time. So the first launch **downloads nothing and
installs nothing**, needs no system Python, and works offline — on every OS identically. Docker is
the one thing it does *not* bundle: that it drives from what is installed on the machine. On startup
it still runs a preflight (Docker, Python, `kathara-api-rest`, Kathara, uvicorn, its dependency
closure, the bundled UI), but to *verify* rather than to repair — anything wrong it explains instead
of showing a blank window.

Labs live outside the app, per user: `~/.config/kathara-desktop/labs` on Linux.

Worth skimming before you start: [Not supported yet](#not-supported-yet), which lists the current
limitations.

### First launch

Installers are **unsigned**, so the first launch needs a manual override:

| Platform | What you see | What to do |
|---|---|---|
| Windows | SmartScreen warning | *More info* → *Run anyway* |
| macOS | Gatekeeper refuses to open it | Right-click → *Open*, or `xattr -dr com.apple.quarantine "/Applications/Kathara-Desktop.app"` |
| Linux | nothing | — |

There is no auto-update: the app checks GitHub once per launch and points you at a newer release if
there is one, but releases are downloaded and installed manually.

## Desktop-only behaviour

- A custom title bar with an HTML menu (File / View / Help), styled after VS Code. The native
  menu stays registered for its keyboard accelerators, and on macOS it also keeps the system
  menu bar's own *Edit* and *Window* entries.
- Terminal pop-outs open as their own framed window.
- Native dialogs for choosing the host directory of a device's `[volume]` bind mount, plus
  *Open Labs Folder* and reveal-in-file-manager. Importing a lab uses the in-page upload modal
  and downloading a file uses the browser's own download, on the desktop as in a browser.
- **Open Terminal Here** opens the OS terminal emulator in a lab's directory — a plain shell, so
  `kathara` commands run against the right lab without having to `cd` (override the emulator
  with `terminalCommand` in `preferences.json`).
- **`kathara://lab/<name>`** opens that lab, in the running instance if there is one.
- Quitting with labs still deployed asks first, and offers to undeploy them — their containers
  would otherwise keep running.
- The backend is bound to `127.0.0.1` only and paired with this one launch via a random token
  (see [Security](#security)); the renderer runs sandboxed and context-isolated with no Node
  access, reaching the shell only through an explicit bridge.

See [docs/DESKTOP.md](docs/DESKTOP.md) for the implementation behind each of these.

## How it's built

Three parts, in one repo:

- **Desktop app** — an Electron shell (`services/desktop`) that is the shipped product: it
  starts a local backend itself and renders the UI in a native window, adding native menus,
  file dialogs, a system terminal and `kathara://` links. See
  [docs/DESKTOP.md](docs/DESKTOP.md).
- **Backend** — a FastAPI service (`src/kathara_api`) that wraps the Kathara Python API and
  exposes it over HTTP. The desktop app drives it directly; it can also be run standalone
  for development. Labs are persisted on disk as real Kathara lab directories, so they
  survive restarts. See [docs/BACKEND.md](docs/BACKEND.md) for the full endpoint reference.
- **Frontend** — a React + Vite single-page app (`services/frontend`) with a desktop-style
  workspace: a topology view, a file/config editor, and xterm.js terminals wired to live
  devices. Built once and served by the desktop app; also runnable with a dev server against
  the standalone backend.

## Development

Everything from here on is for working on the app itself: running it from a checkout, building
the installers, and running the backend and frontend standalone — outside the desktop shell — for
contributors working on either of them, or for driving the API directly.

### Requirements

A checkout needs [Docker](https://docs.docker.com/get-docker/), plus Python 3.10+ and Node 24 (the
version in `.nvmrc`, which CI, the Makefile and the Compose dev stack all follow). Node 22.12+ is
the real floor, imposed by Electron's own install/build tooling for `services/desktop`; the repo
pins one version above it rather than tracking two. None of this is needed to *run* a packaged
build — see [Install](#install).

To install Docker, Python and Kathara in one step (into this checkout's own `.venv`, which
both the backend and the desktop app already look for first), run the script for your OS:

```bash
scripts/install-linux.sh     # Debian/Ubuntu (apt), Fedora/RHEL (dnf) or Arch (pacman)
scripts/install-macos.sh     # needs Homebrew
```
```powershell
scripts\install-windows.ps1  # needs winget (built into Windows 10 1809+/11)
```

Docker Desktop's own first-run setup (license, WSL2 on Windows) isn't scriptable — the script
starts it and tells you when a manual step is needed. Safe to re-run after finishing one.

### Running the desktop app from a checkout

```bash
npm --prefix services/frontend install && npm --prefix services/frontend run build
npm --prefix services/desktop install
npm --prefix services/desktop start
```

The shell starts a local backend and loads its UI once the backend is healthy. In a dev
checkout it prefers the repo's `.venv` and otherwise uses `python3` from `PATH`; a packaged build
has no such search — it always uses the environment bundled inside it. See
[docs/DESKTOP.md](docs/DESKTOP.md) for the
startup sequence in detail, including the pairing token mentioned under
[Security](#security), and a VS Code launch quirk to be aware of.

### Building installers

```bash
# Both of these run from services/desktop, and `npm run dist` does NOT run them for you — skip
# either and the installer builds fine but ships an app that cannot start.
#
# 1. Downloads and checksum-verifies the Python interpreter the app bundles, into the gitignored
#    services/desktop/vendor/.
node scripts/fetch-python.mjs linux            # (or `mac` / `win`)
# 2. Installs the backend's whole dependency closure for both of that OS's architectures, so the
#    packaged app installs nothing at runtime. Must run on the OS it targets: pip reads
#    `sys_platform` markers from the machine it runs on. Needs the wheel from `make wheel` first.
node scripts/vendor-python-deps.mjs linux      # (or `mac` / `win`)

npm --prefix services/desktop run dist:linux   # AppImage + deb + rpm (x64 + arm64)
npm --prefix services/desktop run dist:mac     # dmg (x64 + arm64)
npm --prefix services/desktop run dist:win     # NSIS installer
```

Artifacts land in `services/desktop/release/`. Each target must be built on its own platform
(`.dmg` requires macOS, `.deb` an x86_64 host) — see [docs/DESKTOP.md](docs/DESKTOP.md) for why.
They are unsigned; [First launch](#first-launch) is what a user has to do about that.

`make dist-linux` / `dist-mac` / `dist-win` does the whole sequence above in one step — installing
the npm dependencies, building the backend wheel, fetching the interpreter and vendoring the
dependencies before packaging — mirroring what the release workflow runs. Use it unless you
specifically want to repackage without rebuilding the wheel.

`services/desktop/resources/icon.png` is generated from the frontend's Kathara logo by
`services/desktop/scripts/make-icon.py` (standard library only — no Pillow or ImageMagick
needed); re-run it from `services/desktop` if the logo changes.

### Make targets

`make` drives the whole stack. These are the targets worth knowing; everything else in the
Makefile is a step of one of them.

| Target | What it does |
|---|---|
| `build` *(default)* | The everyday build: frontend SPA + Electron shell, no packaging |
| `check` | Everything CI gates a PR on — see [Checks and tests](#checks-and-tests) |
| `install` | `npm ci` in both Node trees (`install-frontend` / `install-desktop` for one) |
| `frontend` / `shell` | Just one half of `build` |
| `dist-linux` / `dist-mac` / `dist-win` | A full installer for that OS, from wheel to artifact |
| `appimage` | Linux AppImage for the host arch only — faster than `dist-linux` |
| `wheel` | The backend wheel the packaging steps consume |
| `fetch-python` / `vendor-deps` | The bundled interpreter and its dependency closure (packaging only; `*-host` variants do the host arch alone) |
| `clean` | Build output. `clean-wheel` / `clean-python` / `clean-deps` are narrower; `distclean` is all of it |

### With Docker Compose

```bash
# Hot-reload backend + Vite dev server
docker compose -f docker-compose-dev.yml up --build
# -> http://localhost:5173
```

Labs are persisted to `./data/labs` on the host, bind-mounted into the backend container at the
*same absolute path* (see `docker-compose-dev.yml`'s own comment for why that matters).

This Compose stack is dev-only — see [Not supported yet](#not-supported-yet) for the
production-deployment story.

### On the host

```bash
# Backend
pip install -e .
# The Vite dev server is a different origin from the backend, and Vite forwards the browser's
# Origin verbatim on the terminal's WebSocket upgrade — so tell the backend to accept it.
export KATHARA_API_CORS_ORIGINS=http://localhost:5173
kathara-api                 # serves on http://127.0.0.1:8000

# Frontend (in another shell)
cd services/frontend
npm install
npm run dev                 # http://localhost:5173, proxies /api to the backend
```

## Configuration

Backend settings come from environment variables prefixed `KATHARA_API_` (or a `.env` file):

| Variable | Default | Description |
|---|---|---|
| `KATHARA_API_HOST` | `127.0.0.1` | Bind address. Loopback by default — this process can exec inside containers and reach the host filesystem. The Compose stack and the desktop app both pass `--host` explicitly on uvicorn's CLI, which overrides this |
| `KATHARA_API_PORT` | `8000` | Bind port |
| `KATHARA_API_LABS_DIR` | `./data/labs` | Where labs are persisted on disk |
| `KATHARA_API_STATIC_DIR` | *(unset)* | Serve a built frontend (`services/frontend/dist`) from this process at `/`. Set by the desktop app; unset when running the backend standalone for development |
| `KATHARA_API_AUTH_TOKEN` | *(unset)* | Require this exact token (`Authorization: Bearer …` or `?token=`) on every request. Set by the desktop app to a random per-launch value; unset (no auth) everywhere else — see [Security](#security) |
| `KATHARA_API_CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins (only needed when the frontend is served from a different origin). `*` is accepted but disables credentialed cross-origin requests — the spec forbids combining the two, and allowing both would let any website call this API |
| `KATHARA_API_MANAGER_TYPE` | *(Kathara default)* | Kathara manager override (e.g. `docker`) |
| `KATHARA_API_DEFAULT_IMAGE` | *(Kathara default)* | Default device image |

## Checks and tests

`make check` runs everything `.github/workflows/ci.yml` gates a pull request on — the frontend's
lint, typecheck, unit tests and build, the desktop shell's typecheck and build, then `ruff` and
the backend test suite. Run it before opening a PR. It assumes the dependencies are installed:
`make install` for the two Node trees, `pip install -e '.[dev]'` for the backend.

```bash
make check          # all three CI jobs, in the order the workflow runs them
make check-frontend # or one at a time: services/frontend
make check-desktop  #                   services/desktop
make check-backend  #                   ruff + pytest

make lint           # across the stack, for the loop you are in
make typecheck
make test
```

The backend suite is marked, and `make check` runs only what CI does — the rest needs a Docker
daemon or the internet:

```bash
pytest -m 'not docker and not network'   # unit tests only (what CI runs)
pytest -m docker                         # integration tests (need a running Docker daemon)
pytest -m network                        # integration tests (need internet: live gallery fetch)
pytest                                   # everything, including both of the above
```

## Not supported yet

- **No hosted/production deployment.** The only supported ways to run this today are the
  desktop app (single user, local machine) and the dev-only Docker Compose stack for
  contributors. A real production/multi-user deployment story is future work.
- **No multi-user support.** The server holds lab state in-process and must run with a
  **single worker**, so it can't be scaled horizontally. See [Security](#security) for what
  authentication does exist.
- **Live terminals require the Docker manager.** Attaching to a running device (`connect` /
  interactive TTY) is unsupported on Kathara managers other than Docker.
- **No layered/hierarchical topology layout** — the graph is force-directed only.

## Security

The desktop app pairs itself with its own local backend via a per-launch token, so another
local process or browser tab can't drive it just by finding its port — see
[docs/DESKTOP.md](docs/DESKTOP.md#startup-sequence) and
[docs/BACKEND.md](docs/BACKEND.md#architecture-at-a-glance) for how. It is not a login system:
there is still only one implicit user, and no per-user permissions.

Every other way of running the backend (Docker Compose, or directly on the host) has no
authentication at all. The backend also needs the host Docker socket to deploy devices, so run
it only in a **local or trusted** environment.

## License

GPL-3.0
