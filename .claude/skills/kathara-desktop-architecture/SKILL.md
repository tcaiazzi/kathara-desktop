---
name: kathara-desktop-architecture
description: "Orient in the kathara-desktop codebase — architecture, directory map, how the pieces talk to each other, and non-obvious backend/frontend constraints. Use when reading, modifying, or debugging code in services/frontend, services/desktop, or src/kathara_api (the IDE application itself, not the Kathara framework's own Python API — see the kathara-api skill for that)."
user-invocable: true
---

# kathara-desktop architecture

## What this is

An Electron desktop shell (`services/desktop`) wraps a React/Vite SPA (`services/frontend`) and
supervises a FastAPI backend (`src/kathara_api`, packaged as `kathara-api-rest`) that wraps the
Kathara Python API and deploys lab devices as Docker containers. Backend and frontend can also run
independently of Electron (see the `kathara-desktop-dev-workflow` skill for how).

For Kathara's own Python API (the layer this backend calls into), use the `kathara-api` skill
instead. For authoring lab.conf/.startup lab content, use `kathara-lab-creation`. This skill is
about the IDE application's own code.

## Directory map

| Path | Stack | Purpose |
|---|---|---|
| `services/frontend` | React 18 + TS + Vite 5, Vitest, ESLint 9 (flat config) | The SPA: pages, components, hooks, CodeMirror editor, xterm terminals, dockview panel layout |
| `services/desktop` | Electron + TS, esbuild, electron-builder (version in its package.json) | Desktop shell: spawns/supervises the backend, native dialogs, installer packaging |
| `src/kathara_api` | FastAPI, Python 3.10+ | The backend: `main.py`, `routers/`, `services/` (`kathara_service.py` — the one facade every router calls — plus `lab_store.py`, `known_labs.py`, `registry.py`, `lab_import.py`, `lab_builder.py`, `lab_conf_edit.py`, `serializers.py`, `lab_watch.py`, `lab_events.py`, `lab_gallery.py`, `examples.py`, `docker_tty.py`, `docker_hub.py`, `image_pull.py`, `deploy_grants.py`), `schemas/`, `kathara_compat.py` (lets Kathara's Docker manager start privileged devices without root), and `lab_conf_options.py` — a leaf module (imports nothing from either) holding the lab.conf vocabulary every layer derives from |
| `services/backend` | — | Only `Dockerfile.dev`, used by the Compose dev stack. The actual backend code lives at root `src/kathara_api`, not here. |
| `tests/` (root) | pytest | `unit/` (no Docker needed) and `integration/` (needs Docker, `@pytest.mark.docker`: the end-to-end flow and the privileged deploy) |
| `docs/` | Markdown | `BACKEND.md` (full endpoint reference), `DESKTOP.md` (Electron startup sequence + security), `DEVELOPMENT.md` (running from a checkout, configuration, make targets, checks, coverage and mutation testing), `DESIGN-NOTES.md` (cross-cutting runtime invariants: the TTY thread pool, the gallery's event-loop coordination, the `lab.conf` vocabulary, the linter's severity contract). Read these for detail instead of duplicating them here. |
| `scripts/` | shell/ps1 | One-shot **dev-checkout** environment setup (`install-linux.sh`, `install-macos.sh`, `install-windows.ps1`) — they create `<repo>/.venv`; a packaged app uses none of this |
| `data/` | — | Dev-only lab storage used by the Compose stack (`./data/labs`) |
| `../Kathara` (sibling repo) | Python | The Kathara framework itself — source of truth for framework behavior/bugs, not this repo |

## How the pieces talk to each other

- **Desktop → backend**: `services/desktop/src/backend.ts` picks a free loopback port, generates a
  random per-launch pairing token (`KATHARA_API_AUTH_TOKEN`), spawns `uvicorn` and waits until
  `/api/pairing/proof` answers `HMAC(token, nonce)` — sending no token, so a process that grabbed
  the port first learns nothing — then `main.ts` loads `http://127.0.0.1:<port>/` in the
  BrowserWindow. Only origins that passed that proof get IPC answers (`ipc.ts`). The
  backend serves the **built** frontend itself via `KATHARA_API_STATIC_DIR`
  (`src/kathara_api/spa.py`) — same-origin, no CORS, no `file://`. The frontend's transport layer
  (`API_BASE = "/api"`, TTY websocket built from `window.location.host`, relative `EventSource`,
  `BrowserRouter`) assumes HTTP-served, same-origin — don't reintroduce `file://` loading.
- **Which Python runs the backend**: a packaged app has exactly one and no fallbacks — the
  interpreter bundled inside it (`resources/python/`, from `scripts/fetch-python.mjs`) with the
  whole dependency closure shipped beside it (`resources/site-packages/`, from
  `scripts/vendor-python-deps.mjs`) and handed over on `PYTHONPATH` (`backend.ts`'s `pythonEnv()`,
  which `prereqs.ts` also probes under). It therefore **installs nothing and downloads nothing on
  first launch**, on any OS. A dev checkout is the only place there is still a search: the repo's
  `.venv`, then `PATH`. See the `kathara-desktop-dev-workflow` skill for the build steps that
  produce those two trees, and `docs/DESKTOP.md` for why the tree is read-only.
- **Frontend (dev) → backend**: separate origins (`:5173` Vite vs `:8000` FastAPI). Vite's dev
  proxy (`services/frontend/vite.config.ts`) forwards `/api/*` including websockets (`ws: true`)
  to `VITE_BACKEND_URL` (default `http://localhost:8000`).
- **Auth**: opt-in bearer token (`Authorization: Bearer <token>` or `?token=` for WS/SSE) — only
  the desktop app sets one, pairing one Electron instance to its own backend process. Compose/host
  runs are unauthenticated by default.
- **IPC (desktop only)**: context-isolated preload bridge (`preload.ts`) exposes a narrow API
  (auth token retrieval, native dialogs, deep links, labs-dir picking, the sudo password check
  that grants a privileged/host-mounting deploy, the root `chown` of lab files devices left
  root-owned) — the renderer has no direct Node/Electron access. The backend never runs as root.
- Labs are real Kathara lab directories on disk (survive restarts): the ones this app creates live
  under `KATHARA_API_LABS_DIR` (`lab_store.py`, `managed: true`); a folder opened from anywhere
  else (`POST /labs/open`, shell-token only) is used in place and remembered in
  `services/known_labs.py` (`managed: false`). A managed lab is deleted, an opened one only closed
  — never `rmtree` a folder the user opened.
- Outside edits to a lab's `lab.conf`/`*.startup` are picked up by a polling thread
  (`services/lab_watch.py`, started in `main.py`'s lifespan — not by `KatharaService` itself) and
  handled by `KatharaService.handle_disk_change`, which reaches the frontend over `GET /api/events`
  (`services/lab_events.py`, `hooks/useLabEvents.ts`). Every lab.conf write must go through
  `LabStore.write_lab_conf`/`write_lab_conf_text`: that is how the watcher recognizes the app's
  own writes and doesn't reload on them.

## Backend, non-obvious constraints

- **Privileged devices and host mounts are gated in the backend, not by root.** The backend never
  runs as root; `kathara_compat.py` removes Kathara's own root check from `DockerMachine` only, and
  `KatharaService._authorize_host_access` refuses a deploy that starts a privileged device, mounts
  a `[volume]` or `/hosthome` unless a one-shot grant covers it (`services/deploy_grants.py`,
  issued by the desktop shell after the user's password via `POST /labs/{lab}/deploy-grant`).
  `deploy_lab` is the only path that creates devices — a new one must go through the same check.

- `KatharaService`/`Kathara.get_instance()` are **process-scoped singletons** behind a mutation
  lock + in-process `LabRegistry` — single-worker uvicorn by design, no horizontal scaling, no
  multi-user support.
- Nearly every Kathara setting is read fresh at point of use and can be changed at runtime via
  `PUT /settings` — **except `manager_type`**: `Kathara.get_instance()` reads it exactly once at
  construction (true singleton, no reset), so changing it after the facade is first touched never
  takes effect until process restart. `KatharaService.update_settings()` only rejects a
  `manager_type` change once the facade is already initialized; every other field always succeeds.
- `exec(..., wait=True)` reads `sys.stdin` interactively and crashes headless/under pytest — REST
  code paths must use `wait=False`.
- A lab is identified by `lab_id` = Kathara's hash of its directory's absolute path
  (`lab_store.lab_id_for`, set on the `Lab` by `lab_builder.build_lab`) — the registry key, the URL
  segment and the `lab_hash` of every facade call. `lab.name` is only the display name (the
  directory's basename). A rename changes the id.
- `get_lab_from_api(lab_hash=)` returns an **empty** `Lab`, not an error, for a non-existent lab —
  callers must treat an empty reconstructed lab as 404, not assume the call itself validates.
- Known, unfixed upstream gap (sibling `../Kathara` framework, not this repo): the Docker manager
  never clears a device's `api_object` on undeploy — mitigated here in
  `KatharaService._clear_undeployed_state`, called from `undeploy_lab`, `remove_machine` and
  `_offline_lab_state`. (Not from `remove_link`, which only calls the facade's `undeploy_link`.)
  `_refresh_from_api` also clears a device whose Docker container disappeared without this backend
  doing it (e.g. `kathara lclean` in the lab directory, which shares the lab's hash).
- The lab.conf vocabulary — which `machine[key]=value` options this API models, in which order they
  are written back out, and which names a `metas` pass-through may not use — lives **only** in
  `lab_conf_options.py`. `lab_import`'s parser *gates* on it rather than merely agreeing with it, so
  an option cannot be interpreted without also being reserved. Add a new option there first, or it
  will not work at all. `SCALAR_OPTIONS`' order decides the bytes written to disk and is pinned by a
  golden test.
- A top-level `shared/` folder is **not** a per-machine concept and is never merged into any
  device's tree. It lands on disk verbatim like every other imported file, and Kathara's own
  `deploy()` (`Lab.create_shared_folder` + a `/shared` bind mount) applies it from there — see
  `lab_import.py`'s module header. `shared` is in `RESERVED_NAMES`, so neither `shared/` nor
  `shared.startup` can be mistaken for a device. Don't merge shared files into each machine's own
  tree, and don't expect an import warning about `shared/` anywhere — neither is needed, and both
  duplicate what Kathara's own `deploy()` already does.

## Frontend, shared hooks

`services/frontend/src/hooks/` is where behaviour shared by more than one surface lives. Reach for
one of these before writing the second copy of anything (see the `kathara-desktop-coding-style`
skill for the rule).

| Hook | Owns |
|---|---|
| `useBusyAction` | The busy/try/catch/toast-on-error/finally shell, plus a per-call `AbortController` aborted on unmount. Success toasts stay at the call site. |
| `useReportError` | Error reporting: `toast.reportError`, plus — for a `LabFilePermissionError` on Linux in the desktop app — the offer to reclaim root-owned lab files (`lab-files:reclaim-paths` → the reclaim modal). `useBusyAction` goes through it. |
| `useLabFilesSync` | `useAnnouncingSource` / `useOnLabFilesChanged`: the Lab Configuration tree and each device's Files tab announce their own writes through `WorkspaceCoreContext` and re-read on the others', since the disk watcher covers only `lab.conf` and `*.startup`. |
| `useDeployGate` | The single decision point for "does this deploy need the user's permission?" — per-device `volumes`, the global `hosthome_mount` setting, and `privileged`. Every container-creating path goes through it with the lab id; it returns `proceed` / `cancelled`. The backend enforces the same rule (`KatharaService._authorize_host_access`), refusing a deploy the desktop shell didn't grant after the password. |
| `useFsTree` | The whole state machine behind both editable filesystem panels (tree, multi-selection, editor buffer, search, clipboard, mutations). Per-surface differences arrive as `FsTreeSource` / `FsTreeLabels` objects, never as flags. |
| `useLabLifecycleActions` | Deploy/undeploy toggle, rename, delete, wipe-all — with the fixed ordering image precheck → auth gate → `api.deployLab`. A failed image precheck always means "carry on". |
| `useDeviceActions` | Every per-device/collision-domain action and its context-menu entries. |
| `useCatalogInstall` | Install-or-open for both the examples and the gallery; a 409 means "it already exists, opening it", not an error. |
| `usePromiseModal` | The `open()`/`settle()` plumbing behind the four awaitable modals (confirm, prompt, deploy authorization, reclaim labs dir). Use `await confirm({...})` rather than a bespoke yes/no dialog. |
| `useSaveShortcut`, `useFsClipboardShortcuts`, `useHasFocusWithin` | Keyboard shortcuts, always scoped to focus inside a ref rather than bound globally. |
| `useTheme` | Light/dark. The `data-kt-theme` DOM attribute is the source of truth and a MutationObserver keeps every instance in sync — nothing else reads or writes theme state. |
| `useTerminalSession`, `useLiveTty`, `useShellDetection` | One live terminal: shell detection (`bash` is absent on Alpine), xterm wiring, websocket transport. |
| `useElementSize`, `useDismissOnOutside` | ResizeObserver sizing via a callback ref; close-on-outside-click/Escape. |
| `useAvailableImages`, `useImagePullProgress`, `useIsAdmin`, `useHealth`, `useNetSysctls`, `useStartupStatus` | Small backend-backed lookups. `useIsAdmin` is `boolean \| undefined` and the tri-state is load-bearing. `useNetSysctls` caches the host's `net.*` keys for autocomplete; `useStartupStatus` polls a running device's startup log until `/tmp/EOS`. |
| `useCatalogList` | The load half of the two lab catalogues (examples, gallery), as `useCatalogInstall` is the install half. |
| `useConfirmDiscard` | "Discard unsaved changes?" before switching away from a dirty file; resolves at once when there is nothing to lose. |
| `useLabEvents` | The one `GET /api/events` stream for every lab (outside edits, runtime changes), reopened when the pairing token changes. |
| `useHomeDir` | The user's home directory from the shell, for showing a host path as `~/…`; null outside the desktop app. |
| `useTerminalSlot`, `useTerminalPaneDrop`, `useTerminalTheme` | Terminals tab: mounting a session's host element in a pane, drag-to-split/detach, and the shared colour scheme (synced across windows via `storage`). |
| `useForceLayout` | The imperative SVG force-directed topology engine (builds DOM by hand, not through React). |

Under `services/`, `api.ts` is the only module that calls `fetch`; a `WebSocket` or `EventSource`
still takes its URL from `api.ttyWsUrl` / `api.statsStreamUrl` / `api.labEventsUrl`, because neither can set an
`Authorization` header and the token has to travel as `?token=`. Errors are thrown as `ApiError`,
never toasted from inside `api.ts`. `types.ts` mirrors the backend Pydantic schemas field for
field, snake_case included.

## Frontend, non-obvious constraints

- `components/CodeEditor.tsx` (CodeMirror 6) is deliberately `React.lazy`-loaded inside
  `EditorPane` (Suspense) to keep it out of the initial bundle — don't un-lazy it.
- No `Mod-s` keybinding is registered inside CodeMirror on purpose: Ctrl/Cmd+S bubbles to the
  existing `useSaveShortcut` window listener. Adding a CM save binding would double-fire saves.
- The lab.conf lint rules live in `editor/labConfRules.ts` — a pure function over lines, with no
  CodeMirror or DOM import so it can be unit-tested (vitest runs in `node`, no jsdom).
  `editor/labConfLint.ts` is only the CodeMirror binding on top. The rules mirror the backend parser
  (`services/lab_import.py`), and the severity contract is one-way: if the backend appends to its
  `errors` list, the linter must show an *error*, never a warning — a client-side error the backend
  would accept blocks a legitimate save. The option vocabulary half of that mirror **is** checked,
  by `tests/unit/test_lab_conf_options.py`, which reads `editorLanguage.ts` and compares it with the
  backend's exported set; the value-validation rules are still by hand.
