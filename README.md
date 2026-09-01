# Kathara IDE

A web-based IDE for the [Kathara](https://www.kathara.org) network-emulation framework.
Design lab topologies, edit device configs and files, deploy them as containers, and
attach to interactive shells — all from the browser.

It has three parts:

- **Backend** — a FastAPI service (`src/kathara_api`) that wraps the Kathara Python API and
  exposes it over HTTP. Labs are persisted on disk as real Kathara lab directories, so they
  survive restarts. See [docs/BACKEND.md](docs/BACKEND.md) for the full endpoint reference.
- **Frontend** — a React + Vite single-page app (`services/frontend`) with a desktop-style
  workspace: a topology view, a file/config editor, and xterm.js terminals wired to live
  devices.
- **Desktop app** — an optional Electron shell (`services/desktop`) that starts the backend
  itself and renders the same UI in a native window, adding native menus, file dialogs, a
  system terminal and `kathara://` links. See [Desktop app](#desktop-app).

## Requirements

- [Docker](https://docs.docker.com/get-docker/) (Kathara deploys each device as a container
  via the host Docker socket)
- Python 3.10+ and Node 20+ — only for running outside Docker

## Running

### With Docker Compose (recommended)

```bash
# Development: hot-reload backend + Vite dev server
docker compose -f docker-compose-dev.yml up --build
# -> http://localhost:5173
```

Labs are persisted to `./data/labs` on the host (bind-mounted into the backend container at the
*same absolute path* — required so Kathara's native `/shared` folder mount, which the host's own
Docker daemon resolves, points at a path that actually exists there; see the compose file's
comment for why). For `docker-compose-prod.yml`, set `KATHARA_IDE_LABS_DIR` to an absolute host
path (defaults to `/var/lib/kathara-ide/labs`) — it's used for both the bind mount and
`KATHARA_API_LABS_DIR` inside the container.

### On the host

```bash
# Backend
pip install -e .
kathara-api                 # serves on http://localhost:8000

# Frontend (in another shell)
cd services/frontend
npm install
npm run dev                 # http://localhost:5173, proxies /api to the backend
```

## Configuration

Backend settings come from environment variables prefixed `KATHARA_API_` (or a `.env` file):

| Variable | Default | Description |
|---|---|---|
| `KATHARA_API_HOST` | `0.0.0.0` | Bind address |
| `KATHARA_API_PORT` | `8000` | Bind port |
| `KATHARA_API_LABS_DIR` | `./data/labs` | Where labs are persisted on disk |
| `KATHARA_API_STATIC_DIR` | *(unset)* | Serve a built frontend (`services/frontend/dist`) from this process at `/`. Unset in the Compose deployments, where nginx does it; set by the desktop app |
| `KATHARA_API_CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins (only needed when the frontend is served from a different origin) |
| `KATHARA_API_MANAGER_TYPE` | *(Kathara default)* | Kathara manager override (e.g. `docker`) |
| `KATHARA_API_DEFAULT_IMAGE` | *(Kathara default)* | Default device image |

## Tests

```bash
pip install -e '.[dev]'
pytest                      # unit tests
pytest -m docker            # integration tests (require a running Docker daemon)
```

## Desktop app

An Electron shell in `services/desktop`. It supervises a local backend and loads its UI, so
there is no Compose stack to start and no browser tab to keep track of.

It does **not** bundle Python, Kathara or Docker — it drives what is installed on the machine.
On startup it checks for all four prerequisites and, if any is missing, shows what to install
instead of a blank window. The lab storage is per user (`~/.config/kathara-ide/labs` on Linux).

### Running from a checkout

```bash
npm --prefix services/frontend install && npm --prefix services/frontend run build
npm --prefix services/desktop install
npm --prefix services/desktop start
```

The shell picks a free loopback port, starts `uvicorn` on it with `KATHARA_API_STATIC_DIR`
pointing at the built frontend, waits for `/api/health`, and loads
`http://127.0.0.1:<port>/`. Because the UI is served over HTTP from the same origin as the
API, nothing in the frontend needs to know it is running in Electron: relative `/api` calls,
the terminal WebSocket, the stats `EventSource` and `BrowserRouter` deep links all work as
they do in a browser.

In a dev checkout it prefers the repo's `.venv`; otherwise it uses `python3` from `PATH`, or an
interpreter chosen through **Choose Python interpreter…** on the setup screen (remembered in
`~/.config/kathara-ide/preferences.json`).

> Running `npm start` from a terminal **inside VS Code** works, but note that VS Code exports
> `ELECTRON_RUN_AS_NODE=1`; `services/desktop/scripts/start.mjs` strips it before launching,
> because with it set Electron runs as plain Node and never opens a window.

### Building installers

```bash
npm --prefix services/desktop run dist:linux   # AppImage + deb
npm --prefix services/desktop run dist:mac     # dmg (x64 + arm64)
npm --prefix services/desktop run dist:win     # NSIS installer
```

Artifacts land in `services/desktop/release/`. Each target must be built on its own platform
(`.dmg` requires macOS), and `.deb` additionally requires an **x86_64** host: electron-builder
ships `fpm` only for `linux-x86`, so a `.deb` cannot be produced on an arm64 machine.

`services/desktop/resources/icon.png` is a **placeholder** — replace it with the real
application icon before publishing.

Installers are **unsigned**, so first launch needs a manual override:

| Platform | What the user sees | Workaround |
|---|---|---|
| Windows | SmartScreen warning | *More info* → *Run anyway* |
| macOS | Gatekeeper refuses to open it | Right-click → *Open*, or `xattr -dr com.apple.quarantine "/Applications/Kathara IDE.app"` |
| Linux | nothing | — |

There is no auto-update: `electron-updater` is unreliable on unsigned Windows and macOS
builds, so releases are installed manually.

### Desktop-only behaviour

- **Custom title bar.** The window has no native title bar (`titleBarStyle: "hidden"`): the app
  draws a single strip carrying the brand, the menu, the window title and the status badge, the
  way VS Code does — instead of a native title bar with a native menu bar stacked under it. The
  window controls come back as the overlay Chromium paints over that strip on Windows and Linux,
  and as the inset traffic lights on macOS. The strip measures the overlay at runtime
  (`navigator.windowControlsOverlay`, re-measured on `geometrychange`) so its height and its
  right-hand inset always match the real buttons, and it re-colours the overlay when the theme is
  flipped. The whole strip drags the window; interactive parts opt out with `.kt-titlebar-nodrag`.
- **The menu (File / Lab / View / Help) is rendered in HTML** (`desktop/TitleBar.tsx`) and
  dispatches through the same command registry the native menu uses, so both paths run one
  implementation. The native `Menu` stays registered but its bar is hidden, because that `Menu`
  is what binds the keyboard accelerators; on macOS it remains in the system menu bar, where the
  extra *Window* menu also lives. `Ctrl/Cmd+S` is deliberately *not* registered as a native
  accelerator so the keystroke still reaches the editor that has focus — and opening an HTML menu
  does not take focus away from the page, so clicking *Save* saves the panel the user was in.
- Terminal pop-outs keep an ordinary framed window (titled `Terminal: <device>`): they render only
  the terminal, with no strip of their own to drag or close by.
- **Native dialogs** for importing a lab and saving a download, plus *Open Labs Folder* and
  reveal-in-file-manager.
- **Open in system terminal** attaches to a device with `kathara connect` in the OS terminal
  emulator. On Linux the first supported emulator on `PATH` wins; override it with
  `terminalCommand` in `preferences.json` (use `{cmd}` where the command goes).
- **`kathara://lab/<name>`** opens that lab, in the running instance if there is one.
- Quitting with labs still deployed asks first, and offers to undeploy them — their containers
  would otherwise keep running.
- The backend is bound to `127.0.0.1` only, and the renderer runs sandboxed and
  context-isolated with no Node access, reaching the shell only through an explicit bridge.

## Not supported yet

- **No authentication or multi-user support.** The server holds lab state in-process and must
  run with a **single worker**, so it can't be scaled horizontally.
- **Live terminals require the Docker manager.** Attaching to a running device (`connect` /
  interactive TTY) is unsupported on Kathara managers other than Docker.
- **No layered/hierarchical topology layout** — the graph is force-directed only.
- **Known upstream bug:** disconnecting a device from a collision domain, or removing a domain a
  device is attached to, can leave the lab wedged (an unguarded `None` interface in the Kathara
  framework). The lab must then be deleted or the server restarted. The fix belongs to the
  upstream [Kathara](https://github.com/KatharaFramework/Kathara) repo.

## Security

There is no authentication. The backend needs the host Docker socket to deploy devices, so
run it only in a **local or trusted** environment.

## License

GPL-3.0
