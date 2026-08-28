# Kathara IDE

A web-based IDE for the [Kathara](https://www.kathara.org) network-emulation framework.
Design lab topologies, edit device configs and files, deploy them as containers, and
attach to interactive shells — all from the browser.

It has two parts:

- **Backend** — a FastAPI service (`src/kathara_api`) that wraps the Kathara Python API and
  exposes it over HTTP. Labs are persisted on disk as real Kathara lab directories, so they
  survive restarts. See [docs/BACKEND.md](docs/BACKEND.md) for the full endpoint reference.
- **Frontend** — a React + Vite single-page app (`services/frontend`) with a desktop-style
  workspace: a topology view, a file/config editor, and xterm.js terminals wired to live
  devices.

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
| `KATHARA_API_CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins (only needed when the frontend is served from a different origin) |
| `KATHARA_API_MANAGER_TYPE` | *(Kathara default)* | Kathara manager override (e.g. `docker`) |
| `KATHARA_API_DEFAULT_IMAGE` | *(Kathara default)* | Default device image |

## Tests

```bash
pip install -e '.[dev]'
pytest                      # unit tests
pytest -m docker            # integration tests (require a running Docker daemon)
```

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
