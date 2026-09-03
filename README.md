# Kathara IDE

A desktop IDE for the [Kathara](https://www.kathara.org) network-emulation framework. Design
lab topologies, edit device configs and files, deploy them as containers, and attach to
interactive shells — from a native app, with no browser tab or server to manage.

It's built from three parts:

- **Desktop app** — an Electron shell (`services/desktop`) that is the shipped product: it
  starts a local backend itself and renders the UI in a native window, adding native menus,
  file dialogs, a system terminal and `kathara://` links. See [Desktop app](#desktop-app).
- **Backend** — a FastAPI service (`src/kathara_api`) that wraps the Kathara Python API and
  exposes it over HTTP. The desktop app drives it directly; it can also be run standalone
  for development. Labs are persisted on disk as real Kathara lab directories, so they
  survive restarts. See [docs/BACKEND.md](docs/BACKEND.md) for the full endpoint reference.
- **Frontend** — a React + Vite single-page app (`services/frontend`) with a desktop-style
  workspace: a topology view, a file/config editor, and xterm.js terminals wired to live
  devices. Built once and served by the desktop app; also runnable with a dev server against
  the standalone backend.

## Requirements

- [Docker](https://docs.docker.com/get-docker/) (Kathara deploys each device as a container
  via the host Docker socket)
- Python 3.10+ and Node 20+ — only for running outside Docker

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

## Desktop app

An Electron shell in `services/desktop`. It supervises a local backend and loads its UI, so
there is no Compose stack to start and no browser tab to keep track of.

A packaged build **bundles its own Python interpreter** (fetched at build time by
`services/desktop/scripts/fetch-python.mjs`), so the user needs no system Python; it seeds a
private virtualenv under the app's user-data directory and installs the bundled
`kathara-api-rest` wheel into it. Docker and Kathara are **not** bundled — those it drives from
what is installed on the machine. On startup it runs a preflight (Docker, Python 3.10+,
`kathara-api-rest`, Kathara, uvicorn, the bundled UI) and, if something is missing, shows what
to install instead of a blank window. The lab storage is per user
(`~/.config/kathara-ide/labs` on Linux).

### Running from a checkout

```bash
npm --prefix services/frontend install && npm --prefix services/frontend run build
npm --prefix services/desktop install
npm --prefix services/desktop start
```

The shell starts a local backend and loads its UI once the backend is healthy. In a dev
checkout it prefers the repo's `.venv`; otherwise it uses `python3` from `PATH`, or an
interpreter chosen through **Choose Python interpreter…** on the setup screen (remembered in
`~/.config/kathara-ide/preferences.json`). See [docs/DESKTOP.md](docs/DESKTOP.md) for the
startup sequence in detail, including the pairing token mentioned under
[Security](#security), and a VS Code launch quirk to be aware of.

### Building installers

```bash
# Once per OS, before the first build: downloads and checksum-verifies the Python interpreter
# the app bundles, into the gitignored services/desktop/vendor/. `npm run dist` does NOT do
# this for you — skip it and the installer builds fine but ships without an interpreter.
node scripts/fetch-python.mjs linux            # (run from services/desktop; or `mac` / `win`)

npm --prefix services/desktop run dist:linux   # AppImage + deb + rpm (x64 + arm64)
npm --prefix services/desktop run dist:mac     # dmg (x64 + arm64)
npm --prefix services/desktop run dist:win     # NSIS installer
```

Artifacts land in `services/desktop/release/`. Each target must be built on its own platform
(`.dmg` requires macOS, `.deb` an x86_64 host) — see [docs/DESKTOP.md](docs/DESKTOP.md) for why.

`services/desktop/resources/icon.png` is generated from the frontend's Kathara logo by
`services/desktop/scripts/make-icon.py` (standard library only — no Pillow or ImageMagick
needed); re-run it from `services/desktop` if the logo changes.

Installers are **unsigned**, so first launch needs a manual override:

| Platform | What the user sees | Workaround |
|---|---|---|
| Windows | SmartScreen warning | *More info* → *Run anyway* |
| macOS | Gatekeeper refuses to open it | Right-click → *Open*, or `xattr -dr com.apple.quarantine "/Applications/Kathara IDE.app"` |
| Linux | nothing | — |

There is no auto-update: releases are installed manually.

### Desktop-only behaviour

- A custom title bar with an HTML menu (File / Lab / View / Help), styled after VS Code.
- Terminal pop-outs open as their own framed window.
- Native dialogs for importing a lab, saving a download, *Open Labs Folder* and
  reveal-in-file-manager.
- **Open in system terminal** attaches to a device with `kathara connect` in the OS terminal
  emulator (override it with `terminalCommand` in `preferences.json`).
- **`kathara://lab/<name>`** opens that lab, in the running instance if there is one.
- Quitting with labs still deployed asks first, and offers to undeploy them — their containers
  would otherwise keep running.
- The backend is bound to `127.0.0.1` only and paired with this one launch via a random token
  (see [Security](#security)); the renderer runs sandboxed and context-isolated with no Node
  access, reaching the shell only through an explicit bridge.

See [docs/DESKTOP.md](docs/DESKTOP.md) for the implementation behind each of these.

## Development

The backend and frontend can also run standalone, outside the desktop app — for contributors
working on either of them, or for driving the API directly.

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

## Tests

```bash
pip install -e '.[dev]'
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
- **Known upstream bug:** disconnecting a device from a collision domain, or removing a domain a
  device is attached to, can leave the lab wedged (an unguarded `None` interface in the Kathara
  framework). The lab must then be deleted or the server restarted. The fix belongs to the
  upstream [Kathara](https://github.com/KatharaFramework/Kathara) repo.

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
