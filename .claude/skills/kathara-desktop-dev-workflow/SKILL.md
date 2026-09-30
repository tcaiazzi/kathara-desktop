---
name: kathara-desktop-dev-workflow
description: "Run, build, lint, typecheck, and test kathara-desktop (frontend/backend/desktop) in dev mode, and verify a change before considering it done. Use when asked to start/launch/run this app, when preparing a change for commit/PR, or when a build/test/lint command needs to be chosen for this repo."
user-invocable: true
---

# kathara-desktop dev workflow

For architecture/orientation, see the `kathara-desktop-architecture` skill first if you haven't
already worked in this repo this session.

## Three ways to run in dev

**1. Docker Compose dev stack — fastest inner loop, prefer this by default** for verifying a
frontend or backend change:

```bash
docker compose -f docker-compose-dev.yml up --build   # run from repo root
```

- Frontend (hot reload) → `http://localhost:5173`
- Backend (uvicorn `--reload`, bind-mounted `./src`) → `http://localhost:8000` directly
- Must be run from the repo root — `./data/labs` bind-mount path parity matters (see the
  compose file's own comments).

**2. Desktop app from a checkout** (the shipped product):

```bash
npm --prefix services/frontend install && npm --prefix services/frontend run build
npm --prefix services/desktop install
npm --prefix services/desktop start
```

`npm start` runs `build:shell` (esbuild) then `scripts/start.mjs`, which launches Electron;
Electron spawns the backend itself.

**3. Directly on host** (no Docker for the app processes; Docker is still needed for
Kathara-deployed devices):

```bash
pip install -e .
export KATHARA_API_CORS_ORIGINS=http://localhost:5173
kathara-api                                            # http://127.0.0.1:8000

cd services/frontend && npm install && npm run dev     # http://localhost:5173
```

The `CORS_ORIGINS` env var is required in this mode specifically — Vite's dev proxy forwards the
browser's real `Origin` verbatim on WebSocket upgrades, so the backend needs to allow it
explicitly when the two aren't served same-origin by Electron.

## Verifying a change — mirrors CI (`.github/workflows/ci.yml`)

- **Frontend** (`services/frontend`): `npm run lint && npm run typecheck && npm run test && npm run build`
  - `npm run test:coverage` = the same tests with v8 coverage (config in `vite.config.ts`'s
    `test.coverage`): terminal table + `services/frontend/coverage/`. Report only, no threshold;
    CI runs this instead of plain `npm run test` and prints the table on the run summary. The
    total counts components/hooks too, so it reads low by design — watch the per-file numbers.
- **Backend** (repo root, after `pip install -e '.[dev]'`):
  `ruff check src tests && pytest -m "not docker and not network"`
  - `pytest -m docker` needs a live Docker daemon; `pytest -m network` needs internet (live
    gallery fetch) — neither runs in CI, run them only when relevant to the change.
  - `make coverage` = the same suite with branch coverage (`pytest-cov`, config in
    `pyproject.toml`'s `[tool.coverage]`): terminal summary + `htmlcov/`. Report only, no
    threshold; CI prints the table on the run summary and never fails on it.
  - Ruff is configured narrowly in `pyproject.toml` (`select = ["F", "I"]`: dead imports/names and
    import order) and nothing else — see that file's comment for why formatting and the rest of
    the rule set stay off. `ruff check --fix` resolves the import-order half on its own.
- **Desktop** (`services/desktop`): `npm run typecheck && npm run test && npm run build` (CI runs
  `test:coverage` in place of `test`). Vitest in the `node` environment, `src/**/*.test.ts`, config
  in `vitest.config.ts`: it only covers modules that import nothing from `electron` (`safety.ts`
  and siblings); logic stuck in an electron-importing module is moved into one of those first.
  Windows, IPC and child processes are verified by running the app (see below), not by tests.
  With no test file at all `vitest run` fails ("No test files found") — keep at least one.
- **Mutation testing** — never in CI, never a gate; run it when you want to know whether the tests
  would notice a change, not to verify one. `make mutation` (or `mutation-frontend` /
  `mutation-desktop` / `mutation-backend`), `make clean-mutation` afterwards. Backend needs
  `pip install -e '.[dev,mutation]'` (mutmut, pinned; Linux/macOS only). Stryker mutates the
  modules with a sibling `.test.ts` (`stryker.config.mjs` in each tree, HTML report in
  `<tree>/reports/mutation/`); mutmut mutates the list in `pyproject.toml`'s `[tool.mutmut]`, then
  `mutmut results` / `mutmut show <name>`. Many survivors are equivalent mutants: read them, don't
  chase the score. Details in `docs/DEVELOPMENT.md`.

**Frontend test coverage is intentionally narrow**: Vitest picks up `src/**/*.test.ts` and runs in
the `node` environment with **no jsdom**, so it can only cover pure helpers — there are no component
or hook tests by design. Every module under `src/services/` has a `.test.ts` next to it except
`download.ts` and `terminalWindow.ts` (DOM glue) and `types.ts` (types only); so do
`editor/labConfRules.ts` and `editor/lineBreaks.ts`. That is why the lint rules live apart from
`labConfLint.ts`, and why helpers such as `topologyTooltip`, `machineOptionsForm`,
`notificationHistory` and `topology`'s `fitTransform` live outside the component or hook that uses
them. Anything new that you want tested has to be shaped the same way — pure, and in a file
that imports no component. Shared test input (a `MachineDetail` builder) lives in
`src/test/fixtures.ts`, excluded from coverage. `api.test.ts` shows how to test the client: stub
`fetch` and `window`, then `vi.resetModules()` + a dynamic import, because the pairing token is
read at module load. A clean `typecheck` + `build` does **not** verify that a UI
change actually renders or behaves correctly. For any visual or interactive change, do a real
click-through with the **Playwright MCP server** (already configured in `.mcp.json`) against a
running dev stack before considering the change verified — this is how prior UI bugs in this
project were actually caught, not by the automated test suite.

## Driving the real Electron app (not just the browser-served UI)

The default `playwright` MCP server launches its own Chromium and is enough for anything reachable
as a plain web page (the Compose/host dev stack at `:5173`/`:8000` — this is nearly everything,
since the app's own UI is plain React). It **cannot** launch or attach to the actual Electron
desktop shell.

For that, a second server, `playwright-electron`, is configured in `.mcp.json` — it connects via
`--cdp-endpoint` instead of launching its own browser. To use it:

1. Start the desktop app with Chromium's remote-debugging switch (Electron passes this through to
   Chromium automatically, no code change needed):
   ```bash
   cd services/desktop
   node scripts/start.mjs --remote-debugging-port=9222
   ```
2. Confirm it's up: `curl http://localhost:9222/json/version` should return the app's Chrome/
   Electron version; `curl http://localhost:9222/json/list` should show a `"title": "Kathara Desktop"`
   page target. CDP reaches the real backend, real labs and the real renderer.
3. Use the `playwright-electron` MCP tools (not `playwright`) to drive that target — same
   click/snapshot/evaluate tools, now acting on the actual Electron window's content.

**Real limits of this approach**, even once connected: CDP only reaches the Chromium renderer's
own DOM. It does **not** cover truly native OS chrome — native file/folder picker dialogs, the
app's native menu bar, or the macOS/Windows admin-password dialog (`@vscode/sudo-prompt`) — those exist outside
any web page context and aren't clickable via CDP. Use this setup for the setup/prereqs screen,
in-window UI, and anything else rendered as HTML; fall back to manual verification for native
dialogs and menus.

Remember to kill both the Electron process and its spawned `uvicorn` backend child when done (the
backend does not always die with a plain `Ctrl+C` on the launcher — check `ps aux | grep uvicorn`
and kill the PID directly if it lingers).

## Environment gotchas — already handled, don't "re-fix"

- **VS Code integrated terminal exports `ELECTRON_RUN_AS_NODE=1`**, which makes the `electron`
  binary run as plain Node with no window. Already stripped by
  `services/desktop/scripts/start.mjs` before it launches Electron — if `npm start` seems to do
  nothing, check that this script ran, don't add a workaround elsewhere. Nothing strips it for a
  **packaged** build, though: launching an AppImage/`.app`/`.exe` straight from such a terminal
  fails with `bad option: --no-sandbox` (or just exits silently), so `unset ELECTRON_RUN_AS_NODE`
  first when testing an installer by hand.
- **`.deb` packages fail to build on arm64** (electron-builder's `fpm` dependency only ships for
  linux-x86) — AppImage builds fine on this platform. Not a bug to chase.
- **A packaged build failing at startup with `ModuleNotFoundError` for a Python package** points
  at the packaging, not the machine: a packaged app has no interpreter choice and no runtime
  install. Either the module was never vendored (`scripts/vendor-python-deps.mjs` was skipped, or
  the package is in its `OPTIONAL_ACCELERATORS` allowlist) or `PYTHONPATH` isn't reaching the
  backend (`backend.ts`'s `pythonEnv()`). Check `resources/site-packages/vendor-manifest.json` in
  the built app first — it lists exactly what was vendored. There is no "choose an interpreter"
  preference to suspect.
- **A module that *is* in `vendor-manifest.json` and still won't import** — suspect a `.pth` file.
  A `--target` tree reached via `PYTHONPATH` is not a site directory, so Python ignores `.pth`
  files; the generated `resources/site-packages/sitecustomize.py` is what runs them. If that file
  is missing from the build, packages whose modules live in a subdirectory (`pywin32` →
  `win32/win32pipe.pyd`) are present on disk but unimportable. This bit on Windows as every
  Docker call failing with `ImportError`.

## Building installers

```bash
# Both from services/desktop, once per OS, before packaging. `npm run dist` runs neither.
node scripts/fetch-python.mjs {linux|mac|win}       # the bundled interpreter
node scripts/vendor-python-deps.mjs {linux|mac|win} # its dependency closure (needs the wheel first)
npm --prefix services/desktop run dist:{linux,mac,win}
```

`make dist-{linux,mac,win}` runs that whole sequence (wheel included) and is the safer path.
`vendor-python-deps.mjs` must run on the OS it targets — pip reads `sys_platform` markers from the
machine it runs on — and fails the build if a dependency has no wheel for a target.

Artifacts land in `services/desktop/release/`.

### Verifying a packaged build actually runs — offline

The app's whole promise is that a packaged build installs and downloads nothing, so the check that
matters is running one with **no network**. On Linux (verified working 2026-09-09, arm64/WSL2):

```bash
# Extract once — FUSE can't mount inside the namespace, so don't run the AppImage directly.
cd /tmp && /path/to/Kathara-Desktop-*.AppImage --appimage-extract   # -> squashfs-root/

# --map-root-user, not --map-current-user: a fresh netns has `lo` DOWN, and bringing it up needs
# CAP_NET_ADMIN — without it the backend binds a loopback nothing can reach and startup stalls
# after preflight with no error.
unshare --map-root-user -n sh -c '
  unset ELECTRON_RUN_AS_NODE
  ip link set lo up
  HOME=/tmp/probe XDG_CONFIG_HOME=/tmp/probe/.config \
    /tmp/squashfs-root/AppRun --no-sandbox --remote-debugging-port=9223 &
  sleep 20; curl -s http://localhost:9223/json/list'
```

Seed `$XDG_CONFIG_HOME/kathara-desktop/preferences.json` with `{"labsDir": "...", "launchCount": 3}`
first, or the first-run labs-directory prompt blocks startup before the backend ever spawns. That
directory is `kathara-desktop` because `main.ts` sets the path explicitly with `app.setPath` —
Electron's own default would be productName, `Kathara Desktop`, spaces and all. A good run reaches
`backend healthy` in about a second and the CDP target URL ends in `/workspace`; if it ends in
`build/setup.html`, something failed — read `$XDG_CONFIG_HOME/../logs/backend.log`.

Only `update check: request failed` should appear as a network error; anything else means something
still reaches for the network at startup.
