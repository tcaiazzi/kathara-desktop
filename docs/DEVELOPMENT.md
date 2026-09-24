# Kathara Desktop — Development

How to work on the app itself: run it from a checkout, run the backend and frontend standalone,
build the installers, and run the checks CI gates a pull request on. For installing and using a
packaged build, see the [README](../README.md).

## Architecture

Three parts, in one repo:

- **Desktop app** — an Electron shell (`services/desktop`) that is the shipped product: it
  starts a local backend itself and renders the UI in a native window, adding native menus,
  file dialogs, a system terminal and `kathara://` links. See [DESKTOP.md](DESKTOP.md).
- **Backend** — a FastAPI service (`src/kathara_api`) that wraps the Kathara Python API and
  exposes it over HTTP. The desktop app drives it directly; it can also be run standalone
  for development. Labs are persisted on disk as real Kathara lab directories, so they
  survive restarts. See [BACKEND.md](BACKEND.md) for the full endpoint reference.
- **Frontend** — a React + Vite single-page app (`services/frontend`) with a desktop-style
  workspace: a topology view, a file/config editor, and xterm.js terminals wired to live
  devices. Built once and served by the desktop app; also runnable with a dev server against
  the standalone backend.

## Requirements

A checkout needs [Docker](https://docs.docker.com/get-docker/), plus Python 3.10+ and Node 24 (the
version in `.nvmrc`, which CI, the Makefile and the Compose dev stack all follow). Node 22.12+ is
the real floor, imposed by Electron's own install/build tooling for `services/desktop`; the repo
pins one version above it rather than tracking two. None of this is needed to *run* a packaged
build.

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

## Running the desktop app from a checkout

```bash
npm --prefix services/frontend install && npm --prefix services/frontend run build
npm --prefix services/desktop install
npm --prefix services/desktop start
```

The shell starts a local backend and loads its UI once the backend is healthy. In a dev
checkout it prefers the repo's `.venv` and otherwise uses `python3` from `PATH`; a packaged build
has no such search — it always uses the environment bundled inside it. See
[DESKTOP.md](DESKTOP.md) for the startup sequence in detail, including the pairing token
mentioned under [Security](../README.md#security), and a VS Code launch quirk to be aware of.

## Running backend and frontend standalone

Outside the desktop shell — for working on either half, or for driving the API directly.

### With Docker Compose

```bash
# Hot-reload backend + Vite dev server
docker compose -f docker-compose-dev.yml up --build
# -> http://localhost:5173
```

Labs are persisted to `./data/labs` on the host, bind-mounted into the backend container at the
*same absolute path* (see `docker-compose-dev.yml`'s own comment for why that matters).

This Compose stack is dev-only — there is no supported production deployment (see
[Not supported yet](../README.md#not-supported-yet)).

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

Run this way (or through Compose), the backend has no authentication at all, and it drives the
host Docker socket — so run it only in a local or trusted environment.

## Configuration

Backend settings come from environment variables prefixed `KATHARA_API_` (or a `.env` file). The
desktop app sets the ones it needs itself; these matter when running the backend on its own.

| Variable | Default | Description |
|---|---|---|
| `KATHARA_API_HOST` | `127.0.0.1` | Bind address. Loopback by default — this process can exec inside containers and reach the host filesystem. The Compose stack and the desktop app both pass `--host` explicitly on uvicorn's CLI, which overrides this |
| `KATHARA_API_PORT` | `8000` | Bind port |
| `KATHARA_API_LABS_DIR` | `./data/labs` | Where labs are persisted on disk |
| `KATHARA_API_STATIC_DIR` | *(unset)* | Serve a built frontend (`services/frontend/dist`) from this process at `/`. Set by the desktop app; unset when running the backend standalone for development |
| `KATHARA_API_AUTH_TOKEN` | *(unset)* | Require this exact token (`Authorization: Bearer …` or `?token=`) on every request. Set by the desktop app to a random per-launch value; unset (no auth) everywhere else |
| `KATHARA_API_CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins (only needed when the frontend is served from a different origin). `*` is accepted but disables credentialed cross-origin requests — the spec forbids combining the two, and allowing both would let any website call this API |
| `KATHARA_API_MANAGER_TYPE` | *(Kathara default)* | Kathara manager override. Only `docker` is supported for now |
| `KATHARA_API_DEFAULT_IMAGE` | *(Kathara default)* | Default device image |

## Building installers

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
(`.dmg` requires macOS, `.deb` an x86_64 host) — see [DESKTOP.md](DESKTOP.md) for why. They are
unsigned; [First launch](../README.md#first-launch) is what a user has to do about that.

`make dist-linux` / `dist-mac` / `dist-win` does the whole sequence above in one step — installing
the npm dependencies, building the backend wheel, fetching the interpreter and vendoring the
dependencies before packaging — mirroring what the release workflow runs. Use it unless you
specifically want to repackage without rebuilding the wheel.

`services/desktop/resources/icon.png` is generated from the frontend's Kathara logo by
`services/desktop/scripts/make-icon.py` (standard library only — no Pillow or ImageMagick
needed); re-run it from `services/desktop` if the logo changes.

## Make targets

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
