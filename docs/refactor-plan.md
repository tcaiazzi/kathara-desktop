> **Historical.** This plan has been carried out and the codebase has since moved on: the
> client-side "pending files" model it revolves around, and the `*/pending-files` routes it
> describes, no longer exist — both filesystem panels now read and write the real filesystem on
> every call (see `services/frontend/src/hooks/useFsTree.ts` and
> `src/kathara_api/services/kathara_service.py`'s `fs_*_offline` methods). Kept for the design
> rationale and the decision record; `docs/BACKEND.md` is the current API reference.

# Kathara API REST — Frontend/Deployment Refactor Plan (v2)

**Status:**
- **Track 1 implemented** (2026-07-17) — see `services/lab_import.py`,
  `services/registry.py`'s pending-state additions, the `/api/labs/import*` and
  `*/pending-files` routes, and `tests/unit/test_lab_import*.py`. The pre-refactor UI is kept
  at `old/static/index.html` for reference.
- **Track 2, Phase 1 implemented** (2026-07-17): all API routes now live under `/api`, and
  CORS middleware is wired up (disabled by default; see README's "API prefix & CORS"). Done
  on explicit request, ahead of the "wait for a concrete driver" guidance below — see the
  updated API-versioning decision.
- **Track 2, Phase 2/3 — all 6 vertical slices implemented** (2026-07-17): `services/frontend`
  is a Vite + React + TypeScript + React-Bootstrap app (see its own section below) now covering
  system/lab list, devices/links tables, the file editor/explorer, the exec terminal, live
  stats, and the topology graph — full feature parity with the bundled `/ui/` UI's core
  functionality. One caveat found while verifying topology against real Docker: a
  pre-existing bug in the **sibling `Kathara` framework** (not this repo) crashes any lab
  where a machine has a disconnected interface — see the topology slice entry below.
- **Track 2, Phase 5 implemented** (2026-07-17): `docker-compose-dev.yml` /
  `docker-compose-prod.yml` + `services/{backend,frontend,reverse-proxy}` Docker artifacts —
  see the Phase 5 entry below. Verified end-to-end against real Docker, including
  Docker-outside-of-Docker (the containerized backend deploying real sibling lab containers
  on the host). Phase 6 (cutover — retiring the bundled `/ui/`) hasn't started; see README's
  new "Deployment (Docker Compose)" section for usage.
- **First real browser click-through completed** (2026-07-17), via a Playwright MCP server —
  every tab (Lab list, Topology, Devices, Editor, Terminal, Stats) and the New-lab/topology
  action modals were driven in an actual Chromium instance for the first time (all prior
  verification was type-level + network-level only). Found and fixed 5 real bugs; see the
  "Visual QA pass" note at the end of this file for details.
- **Light-theme style/usability refactor completed** (2026-07-17), inspired by containerlab's
  UI (a very similar, slightly older network-emulation tool): unified the frontend to a single
  light theme (previously the Topology graph, its context menu, and the Exec terminal were
  dark, hardcoded straight from the pre-refactor vanilla UI, while the rest of the app used
  default Bootstrap light — two visually unrelated apps stitched together). Kept the existing
  dark navbar deliberately (intentional "dark top bar / light body" pattern, not part of the
  inconsistency). See the "Style refactor" section below for the phase-by-phase detail.
- **Lab directory upload + on-disk persistence implemented** (2026-07-18): users can upload a
  lab as a binary-safe `.zip` archive (`POST /api/labs/upload` + an "Upload lab" button in the
  React frontend), and **every** lab — uploaded, JSON-created, or lab.conf/folder-imported — is
  now persisted to disk as a real Kathara lab directory and reloaded on server restart. Kathara's
  native on-disk `Lab(path=...)` deploy machinery (`Machine.pack_data`) replaced the old
  in-memory `mem://` fs + post-deploy copy_files/exec workaround for a machine's *first* deploy.
  See the "Lab upload & persistence" section below for full detail, including two real bugs found
  and fixed while verifying against actual Docker (one in this repo's own `deploy_lab`, one a
  Kathara framework `shared_mount` option-resolution bug worked around per-lab).
- **Track 2, Phase 6 (cutover) implemented** (2026-07-18): the bundled `static/index.html` UI is
  fully retired — `/ui` mount, `/` redirect, the static directory, `run_ui.sh`, and every
  README/nginx/compose reference are gone. `services/frontend` is now the only web UI this
  project ships. This closes out the entire Track 2 plan (Phases 1-6, all done).

## Context

The original plan (Copilot-authored) proposed splitting the embedded vanilla-JS UI into a
separate React+TypeScript+Bootstrap frontend behind an nginx reverse proxy, shipped via
Docker Compose, modeled on `ixp-digital-twin-dashboard`, in 6 phases.

Revised here because: the project is a few days old, the current UI (`static/index.html`)
hasn't been used/validated yet, the API has no auth and is documented as local/trusted-use
only, and there is no stated driver (multiple users, hosted deployment) requiring a split
origin, CORS, or a reverse proxy. A full framework + infra rewrite now would be migrating
assumptions rather than validated pain points. One piece of the original plan *is* valuable
independent of any frontend decision — backend-authoritative lab import — and should happen
first, on its own.

## Track 1 — Do now: backend-authoritative lab import

Move `lab.conf` / `.startup` / folder parsing out of the client-side JS parser in
`static/index.html` into a backend endpoint. Make file + startup application atomic and
ordered from the backend (write files, then run the combined `shared.startup` +
`<machine>.startup` script) instead of orchestrated by the browser.

This directly fixes known issues: pending imported files are currently client-side state
lost on page reload; `copy_files` only targets running containers, so today's UI defers
startup-script execution to a post-deploy exec step it has to orchestrate itself.

Files likely touched:
- `src/kathara_api/routers/labs.py` or `machines.py` — new import/apply endpoint(s)
- `src/kathara_api/services/kathara_service.py` — queued files/dirs/startup ordering
- `src/kathara_api/services/lab_builder.py` — add the `lab.conf` parser here (server-side)
- `src/kathara_api/static/index.html` — replace client-side parsing with a call to the new
  endpoint; drop the client-side pending-file workaround once the backend is atomic

Value: real today, independent of frontend framework choice, and removes complexity that
would otherwise have to be re-implemented in any future frontend.

## Track 2 — split frontend + deployment

Originally scoped as "future, conditional: revisit only once a concrete driver appears (e.g.
multiple concurrent users, hosting this for a class/team, or wanting to reuse dashboard
chrome from `ixp-digital-twin-dashboard`)." **Phase 1 was started ahead of that gate, on
explicit request** — no such driver has appeared yet, so this is a deliberate exception, not
a reversal of the reasoning above.

- [x] **Phase 1 — API prefix + CORS.** All routers now mounted under `/api` in
  `src/kathara_api/main.py` (`API_PREFIX`); `CORSMiddleware` added with
  `allow_origins` sourced from `KATHARA_API_CORS_ORIGINS` (empty/same-origin-only by
  default — see `config.py`'s `cors_origins_list()`). The bundled UI
  (`static/index.html`) was updated to call through the same `/api` prefix (`API_BASE`
  constant), so it keeps working same-origin, unaffected by CORS. The static mount at `/ui`
  and root `/` → `/ui/` redirect were deliberately **not** removed yet — that's a Phase 6
  cutover concern, and removing it now would leave the tool with no working UI until the
  React frontend exists.
- [x] **Phase 2/3, slice 1 — system/lab list/header actions.** `services/frontend/` scaffolded
  with Vite + React + TypeScript + React-Bootstrap:
  - `src/services/api.ts` + `types.ts` — typed fetch client against `/api` (same-origin;
    proxied to the backend by Vite in dev, by the eventual reverse proxy in prod).
  - `src/context/{ToastContext,ConfirmContext}.tsx` — reusable toast/confirm-modal
    primitives (promise-based confirm, mirroring the vanilla UI's `askConfirm`).
  - `src/components/{AppNavbar,NewLabModal}.tsx`, `src/pages/{LabListPage,LabDetailPage}.tsx`
    — health/system badge, lab list with deploy/undeploy/delete, "new lab from JSON" modal,
    a minimal lab detail page (name/metadata/counts + lifecycle actions).
  - `react-router-dom` for `/` (list) and `/labs/:name` (detail).
  - Dev proxy in `vite.config.ts` forwards `/api` to `http://localhost:8000` (override via
    `VITE_BACKEND_URL`) so local dev needs no CORS entry at all.
  - **Not yet migrated** (still only in the bundled `/ui/`): devices/links tables, lab.conf
    import, topology graph, terminal (exec + SSE), file explorer, live stats. The detail page
    says so explicitly and points back at `/ui/`.
- [x] **Phase 2/3, slice 2 — devices/links tables.** Read-only, matching the vanilla UI's
  Devices panel scope exactly (mutating actions — add/remove device, connect/disconnect —
  live with the topology graph in the original UI, so they're deferred to that later slice,
  not this one):
  - `src/components/{DevicesTable,LinksTable}.tsx` — machines (name/image/state/interfaces)
    and collision domains (name/state/devices/external) tables, both filtering out Kathara's
    internal `kathara_host_bridge` link (`src/services/constants.ts`).
  - `LabDetailPage` restructured into `react-bootstrap` `Tabs`: "Devices" has real content;
    Topology/Editor/Terminal/Stats are `NotMigratedPanel` placeholders pointing at `/ui/`,
    each to be swapped for real content as its slice lands.
- [x] **Phase 2/3, slice 3 — editor/explorer.** `src/components/LabExplorer.tsx` +
  `src/services/labfs.ts` (`genLabConf`/`buildVirtualFs`/`buildFileTree`, ported from the
  vanilla UI's equivalents for consistency between the two frontends). Organized by machine
  (the backend already flattens `shared/` into every machine's pending entry, so the tree
  doesn't try to reconstruct a separate "shared/" node). Covers: browsing lab.conf (read-only
  preview) and each device's startup/files; editing and saving (queues via
  `PUT .../pending-files`, *and* pushes live + re-runs the startup script if the device is
  running); "load from device" (`cat`); creating new files/directories. Added
  `src/context/PromptContext.tsx` (promise-based text prompt, same pattern as
  `ConfirmContext`) for the new-file/new-dir dialogs.
  - **Known, deliberately accepted gaps** (matches the vanilla UI's own documented
    limitation): no "shared/" broadcast-to-all-devices shortcut — editing a file only queues
    it for the one device whose tree node you edited it under. No drag-and-drop file moves.
- [x] **Phase 2/3, slice 4 — exec terminal.** `src/components/ExecTerminal.tsx`, ported from
  the vanilla UI's exec panel: device picker (running machines only), command input with sync
  ("Run") and streaming ("Stream") modes, a `wait` checkbox, and a scrolling terminal-style
  output area (colored `cmd`/`err`/`exit` segments, matching the vanilla UI's palette).
  Streaming reads Server-Sent Events directly off the raw `fetch` Response body
  (`api.execStream` in `services/api.ts`) since `exec/stream` is a POST endpoint and the
  browser's `EventSource` is GET-only — same reason and same manual chunk-buffering /
  `\r\n`-normalization approach as the vanilla UI. Added an "Exec" quick-jump button per
  running device in `DevicesTable` that switches to the Terminal tab with that device
  preselected (`LabDetailPage` now holds `activeTab`/`execJump` state; `Tabs` is controlled).
- [x] **Phase 2/3, slice 5 — live stats.** `src/components/StatsPanel.tsx`, ported from the
  vanilla UI's stats panel: Start/Stop buttons, a table of per-device CPU/memory/net/PIDs
  samples. Unlike exec/stream, `stats/stream` is a GET endpoint, so the browser's native
  `EventSource` is used directly (`api.statsStreamUrl` in `services/api.ts`) — no manual SSE
  body-parsing needed here, unlike the exec terminal. Stream stops on unmount/lab-name change
  (mirrors the vanilla UI stopping it on lab switch/delete/unload).
- [x] **Phase 2/3, slice 6 — topology (last vertical slice).** `src/components/
  TopologyGraph.tsx` + `src/services/topology.ts` (`computeTopology`/`parseIfaceIps`), ported
  from the vanilla UI's force-directed SVG graph. Deliberate architecture choice: the
  simulation/render loop manipulates SVG DOM attributes directly every animation frame
  (mutable `Engine` object in a ref), the same way the vanilla version did — dozens of
  position updates a second per node is a poor fit for React re-renders. React only owns the
  low-frequency parts: the side panel (re-renders on node selection), a reusable
  `TopologyActionModal` (generic field-driven form, reused for add device/domain/interface,
  disconnect, copy-file — one component, same as the vanilla UI's one dynamic modal), and
  `TopologyContextMenu` (right-click actions). Toolbar: + Device, + Domain, Fit, Re-layout
  (bumps a nonce to force the sim to rebuild with fresh randomized positions, since the effect
  always rebuilds from scratch — matching the vanilla UI, which never preserves node positions
  across a detail reload either). Drag, pan, zoom, hover-highlight, dblclick (device → Editor
  tab, domain → prefilled add-device) all ported. New API methods in `services/api.ts`:
  `addMachine`, `removeMachine`, `connectMachine`/`disconnectMachine` (query-param based,
  matching the backend's `connect`/`disconnect` routes), `addLink`, `removeLink`.
  - **Found a real, pre-existing bug while verifying against real Docker** (not introduced by
    this port, and not in this repo): disconnecting a machine from a domain, or removing a
    domain a machine is attached to, leaves a `None` slot in that machine's Kathara-model
    `interfaces` dict. Every *subsequent* call touching that lab then crashes with
    `AttributeError: 'NoneType' object has no attribute 'link'` inside
    `../Kathara/src/Kathara/manager/docker/DockerManager.py:798`
    (`update_lab_from_api`'s `static_links = set([x.link for x in device.interfaces.values()])`
    has no `None` guard). The lab is stuck until force-deleted (whole-lab `DELETE` skips the
    resync) or the server restarts. This affects the "Disconnect from domain" and "Remove
    domain" actions in **both** this new topology tab and the original vanilla UI (same
    underlying endpoints) — nothing before this session had exercised those two actions
    end-to-end against real Docker. Decision: noted here, not fixed — it's in the sibling
    `Kathara` framework repo, out of scope for kathara-api-rest itself, and fixing a different
    project's source wasn't done without being asked. `Add device`, `Add domain`,
    `connect` (with an explicit interface number, including the correctly-rejected case of
    connecting to an already-running device), `Remove device`, and `copy-file` were all
    verified working correctly.
- [x] **Phase 5 — Docker Compose.** `services/backend/Dockerfile` (installs `kathara>=3.8.3`
  from PyPI — not the `../Kathara` editable checkout used for local dev — via `pip install .`),
  `services/frontend/Dockerfile` (multi-stage: `node:20-alpine` build → `nginx:1.27-alpine`
  serving the static `dist/`, with an SPA `try_files` fallback), and
  `services/reverse-proxy/nginx.conf` (routes `/api` → backend with `proxy_buffering off` for
  the two SSE endpoints, `/docs`/`/redoc`/`/openapi.json` → backend, everything else →
  frontend; the `/ui` block was removed at the Phase 6 cutover below).
  - `docker-compose-prod.yml`: all three services behind the reverse-proxy on one origin
    (port 8080) — no CORS needed, same reasoning as the Vite dev proxy.
  - `docker-compose-dev.yml`: backend as an editable install (`services/backend/Dockerfile.dev`)
    with `./src` bind-mounted and `uvicorn --reload`; frontend as a plain `node:20-alpine`
    container running `npm run dev -- --host 0.0.0.0` against a bind-mounted
    `services/frontend`, `VITE_BACKEND_URL=http://backend:8000` so its own dev proxy reaches
    the backend by Compose DNS name. No reverse-proxy in dev — same flow as running both
    directly on the host, just containerized.
  - The backend mounts `/var/run/docker.sock` — Kathara's Docker manager deploys lab devices
    as *sibling* containers on the true host, not nested inside the backend container
    (Docker-outside-of-Docker). **Verified for real**: built all three images, brought up
    `docker-compose-prod.yml`, and through the reverse-proxy (port 8080) confirmed the React
    frontend loads, `/docs` works, and — the real test — created, deployed,
    `exec`'d into (`hostname` → correct container), undeployed, and deleted a lab entirely
    through the containerized backend, with no leftover containers afterward. Also brought up
    `docker-compose-dev.yml` and confirmed both services start and the frontend's dev proxy
    correctly reaches `backend` by Compose DNS.
  - **Known gap, not fixed**: `VolumeMount` (`host_path`/`guest_path` bind mounts in
    `MachineCreate`) doesn't translate cleanly here — `host_path` is resolved by the *true*
    host's Docker daemon, not by anything visible inside the backend container, so such a path
    must exist on the actual host running Compose, not in the backend image. Noted in README;
    not something this stack can paper over without deeper changes.
- [x] **Phase 6 — cutover (2026-07-18)**: the bundled vanilla UI is fully retired. Removed
  `src/kathara_api/static/` (the served `index.html`) entirely, the `app.mount("/ui", ...)` +
  `/` → `/ui/` redirect from `main.py`, the `package-data` entry in `pyproject.toml`, and
  `run_ui.sh` (its only purpose was opening `/ui/`). `services/reverse-proxy/nginx.conf`'s
  `location /ui/` block removed (the `/docs`/`/redoc`/`/openapi.json` block is kept — those are
  FastAPI's own interactive docs, unrelated to the retired UI, not a "legacy" concern). Updated
  every remaining `/ui` reference in `README.md` and the `docker-compose-prod.yml` usage
  comment. `old/static/index.html` is untouched — it's the pre-Track-1 archival reference copy,
  already excluded from packaging, and stays as historical reference per `old/README.md`.
  Verified: full non-Docker suite green (68 passed) after removal; a fresh server instance
  confirmed `/` and `/ui/` now 404 while `/api/health` and `/docs` still 200.

This content is preserved from the original plan intentionally — it doesn't need to be
redesigned later, just picked back up when justified.

## Decisions (revised)

- **API versioning**: the `/api` prefix is now in place (Track 2 Phase 1), but still
  unversioned — no `/api/v1`. Add version segmenting only if/when an actual breaking change
  needs it; introducing it speculatively, with a single consumer (the bundled UI), would be
  guessing at a versioning scheme before there's any evidence of what needs to version.
- **Legacy coexistence window**: still moot — there's only one UI today (the bundled one,
  now calling through `/api`). Applies once a second (React) frontend actually exists.
- **State persistence**: keep current in-memory pending state. Track 1's atomic
  backend-side apply removes the actual problem (lost pending files on reload) without
  needing a persisted draft-session mechanism.
- Frontend library (React-Bootstrap), TypeScript, and Docker Compose topology choices from
  the original plan are unchanged *for Track 2* — no disagreement with those, only with
  doing them now.

## Verification

- Track 1: existing unit tests plus new tests for the backend parser/apply endpoint(s);
  manual run through `./run_ui.sh` importing a real Kathara lab folder, confirming files +
  startup scripts land in the same order as today, and that a page reload no longer loses
  pending imports.
- Track 2, Phase 1: `pytest -m "not docker"` (48 passed) and `pytest -m docker` (7 passed)
  both green after the prefix change; manual check that `/`, `/ui/`, `/api/health` behave as
  expected and a disallowed-origin CORS preflight is rejected by default.
- Track 2, Phase 2/3 slice 1: `npm run typecheck` and `npm run build` both clean. Verified
  the exact request sequence the frontend makes (create → list → deploy → get detail →
  undeploy → delete) through the Vite dev proxy against the real Docker-backed API, with
  responses matching the TS types. **Not verified**: actual rendering/interaction in a real
  browser — this environment has no browser/screenshot tool available, so component
  rendering, routing clicks, and modal/toast behavior are unverified beyond a clean
  TypeScript build. Recommend a manual click-through (`npm run dev` in `services/frontend`,
  `kathara-api` running, visit `http://localhost:5173`) before relying on this slice.
- Track 2, Phase 2/3 slice 2: same method — clean typecheck/build, then a 2-machine
  shared-link lab created/deployed through the dev proxy against real Docker, confirming the
  `LabDetail` response shape (`machines[].interfaces[].{num,link,mac_address}`,
  `links[].{name,machines,external,running}`, `kathara_host_bridge` present) matches what
  `DevicesTable`/`LinksTable` expect. Same browser-rendering caveat as slice 1 applies.
- Track 2, Phase 2/3 slice 3: clean typecheck/build, then every `LabExplorer` code path
  exercised through the dev proxy against real Docker on a lab imported with a startup
  script + a shared file: `GET pending-files` shape matches `buildVirtualFs`'s expectations;
  saving a running device's file (`PUT pending-files` + `POST files`) and reading it back
  confirmed the new content; saving a running device's startup (`PUT pending-files` +
  `POST files` for `/tmp/.kathara_boot.sh` + `POST exec` to run it) was confirmed to have
  actually executed (`test -f` the file it creates); queuing a new directory
  (`PUT pending-files` with `dirs`) was confirmed to show up in a follow-up `GET
  pending-files`. Same browser-rendering caveat as slices 1-2 — tree expand/collapse,
  textarea editing, and the new-file/dir prompt modals are unverified visually.
- Track 2, Phase 2/3 slice 4: clean typecheck/build, then both exec modes exercised through
  the dev proxy against real Docker on a deployed device: sync exec (`hostname`) returned the
  expected stdout/exit_code; streaming exec (`ping -c 3 127.0.0.1`) was read via `curl -N` in
  the exact `event:`/`data:` framing `handleSseEvent` parses, and a sample base64 `data`
  payload was decoded and matched the expected ping output. Same browser-rendering caveat —
  the terminal's colored output, Stop-button abort, and Exec quick-jump from Devices are
  unverified visually.
- Track 2, Phase 2/3 slice 5: clean typecheck/build, then `curl -N` against the exact
  `stats/stream` URL `StatsPanel` opens an `EventSource` on (through the dev proxy, real
  Docker, a deployed device) confirmed the `event: stats` / JSON-array-of-`MachineStats`
  framing the component's listener expects, with `name`/`status`/`cpu_usage`/`mem_usage`/
  `mem_percent`/`net_usage`/`pids` all present. Same browser-rendering caveat — the
  Start/Stop toggle and live table updates are unverified visually.
- Track 2, Phase 2/3 slice 6 (topology): clean typecheck/build, then every mutating action
  `TopologyGraph` can trigger was called against real Docker through the dev proxy on a
  freshly deployed lab: add domain, add device (both attached and unattached), copy-file to a
  running device, and remove device all succeeded and left the lab in a healthy, queryable
  state afterward. Connecting with an explicit interface number to an already-running device
  correctly surfaced the backend's existing `NotSupportedError` rejection (not a bug — this
  constraint predates the topology slice). Disconnect and remove-domain surfaced the
  pre-existing upstream `Kathara` framework bug described above (confirmed via the backend's
  own traceback in the server log, then cleaned up with a whole-lab delete and verified no
  containers were left behind). Same browser-rendering caveat as prior slices — drag, zoom,
  pan, the context menu, and the action modal are unverified visually; only their underlying
  network calls and data shapes were confirmed.
- Track 2, Phase 5 (Docker Compose): `docker compose -f docker-compose-prod.yml build` — all
  three images built clean, including `pip install .` correctly resolving `kathara==3.8.3`
  from PyPI. `docker compose -f docker-compose-prod.yml up`, then through the reverse-proxy
  (`localhost:8080`): frontend SPA served at `/`, `/api/health` + `/api/system` proxied
  correctly, `/ui/` and `/docs` both 200. Full lab lifecycle (create → deploy → exec →
  undeploy → delete) run against the *containerized* backend, confirming
  Docker-outside-of-Docker actually works — `exec`'s `hostname` response matched the real
  sibling container, and cleanup left zero leftover containers on the host. Separately,
  `docker compose -f docker-compose-dev.yml up --build` confirmed both dev services start and
  the frontend's Vite dev server (running inside its own container) successfully proxies
  `/api` to `backend` over Compose's internal DNS. Not additionally re-verified: hot-reload
  actually firing on a live edit (the underlying bind-mount + editable-install + `--reload`
  mechanism is standard and each piece was verified independently, but the reload-on-edit
  loop itself wasn't exercised this pass).

## Visual QA pass (2026-07-17) — first real browser click-through

Every prior verification pass in this document was type-level (clean `tsc`) and network-level
(exact request sequences against real Docker) — never an actual rendered page. Once a
Playwright MCP server was working, every tab was driven in real Chromium against the running
`docker-compose-dev.yml` stack's `demo` lab. Found and fixed:

1. **Topology toolbar/legend silently missing from the DOM entirely** (not just visually
   hidden). `TopologyGraph`'s simulation `useEffect` called `canvas.replaceChildren()` on the
   *same* DOM node React was rendering the toolbar/legend into as children — every rebuild
   wiped them out from under React without React knowing. Fixed by giving the imperatively-
   managed SVG its own dedicated mount div (`kt-topo-svg-mount`), sibling to the React-owned
   toolbar/legend rather than sharing a parent with them.
2. **Right-click on a topology node opened the context menu, then immediately deselected the
   node.** The node's `pointerdown` handler didn't check which mouse button fired, so a
   right-click's `pointerup` ran the same "toggle selection off if already selected" logic the
   `contextmenu` handler had just triggered. Fixed by ignoring non-primary-button pointerdowns
   in the drag/select handler (`if (ev.button !== 0) return`).
3. **Duplicate IP shown in the topology side panel** (`10.0.0.1/24, 10.0.0.1/24`). Root cause
   was in the *data*, not obviously the frontend: Kathara's own `exec_commands` list includes
   an auto-generated `echo "++ <command>" >> /var/log/startup.log` line right before each real
   command, and that echoed text also matches `parseIfaceIps`'s regex — so the same IP got
   extracted twice per interface. Fixed by deduping per-interface IPs in `parseIfaceIps`
   (`services/topology.ts`).
4. **Exec terminal's command input, wait checkbox, and Run/Stream/Clear buttons each wrapped
   onto their own line**, even at 1280px wide. Root cause: Bootstrap's `.form-control` sets
   `width: 100%`, which flexbox honors as the item's preferred main-axis size even with
   `flex-grow` set — so the input claimed the *entire* row by itself, pushing every sibling
   onto new lines. Fixed with an inline `width: "auto"` override (inline style beats the
   stylesheet class) so `flex-grow`/`flex-basis` size it normally instead.
5. **Minor fidelity gap**: the Editor's file-tree icon logic didn't distinguish `lab.conf`
   (should be ⚙️) from `.startup` scripts (📜) the way the vanilla UI did — both got 📜. Fixed
   by porting the vanilla UI's exact `fileIcon` mapping.

Everything else checked out correctly on first render: the lab list, devices/links tables,
file editor (tree, load-from-device, save), sync + streaming exec (colors, exit codes), live
stats table, the New-lab-from-JSON modal, and the topology action modal (add
device/domain/interface) all rendered and behaved as designed. One environment-only artifact,
not a bug: emoji icons rendered as empty boxes in the sandboxed headless Chromium (no
color-emoji font installed on that machine) — confirmed via `document...textContent` that the
actual emoji characters are present in the DOM; a normal user's browser will render them fine.

**6th bug**, found by the user from a screenshot right after this pass: every page stopped
dead at its last element with no bottom breathing room (no page-level bottom padding
anywhere) — reads as an abruptly cut-off page. Fixed with one `pb-5` on a `<main>` wrapping
`<Routes>` in `App.tsx`, rather than patching each page's container individually.

## Style refactor (2026-07-17) — light-theme unification

Full plan lived at `docs/` planning time in a throwaway plan file; summarized here for the
permanent record. Five phases, each verified independently (`npm run typecheck && npm run
build`, then a real Playwright click-through against the running dev stack):

- **Phase 0 — design tokens.** New `src/styles/theme.css`, imported in `main.tsx` right after
  Bootstrap's CSS. Layers `--kt-*` custom properties on top of Bootstrap's own `--bs-*`
  variables (reused wherever the intent is just a standard semantic color) for the things
  Bootstrap has no equivalent for: topology node/edge states (`--kt-node-*`, `--kt-domain-*`,
  `--kt-edge-*`, `--kt-selected-glow`) and a shared "recessed surface" look for
  console/canvas areas (`--kt-surface-recessed*`, `--kt-term-*`) — a GitHub-code-block-style
  light gray, not stark white, so those areas still read as visually distinct from the page.
  Verified zero visual diff (tokens unused until later phases).
- **Phase 1 — terminal.** `ExecTerminal.tsx`: replaced the hardcoded dark hex palette
  (`SEGMENT_COLOR` map, output-box background/border/text) with the `--kt-term-*` tokens.
  Verified against a real deployed device: sync exec, streaming exec, and all three segment
  colors (cmd/err/exit) legible on the new light background.
- **Phase 2 — topology.** Full light conversion of `TopologyGraph.css` (canvas, running/
  stopped node fill+border, collision-domain fill+border incl. the dashed "external" variant,
  edges, edge labels, side panel, legend) and `TopologyContextMenu.tsx`'s inline dark colors.
  Toolbar buttons changed from `variant="outline-light"` to `variant="outline-secondary"` —
  this was a must-fix, not cosmetic: outline-light is invisible on a light canvas. Legend
  swatches moved from inline hex `style` props to CSS classes (`.swatch.running/.stopped/
  .domain/.domain-external`) using the same tokens. Added a `drop-shadow` glow
  (`--kt-selected-glow`) on `.selected` nodes so selection stays a distinct signal now that
  stroke-width alone is subtler on light backgrounds. Verified with a lab containing a running
  device, a stopped device, and an external domain: canvas background, running/stopped
  contrast, external-domain dashed styling, hover highlight, selection glow, dim state,
  right-click context menu, and the add-device modal.
- **Phase 3 — card consistency.** `StatsPanel.tsx` was the one panel not wrapped in a
  `.card`/`.card-body` the way `DevicesTable`/`LinksTable` are; wrapped it to match.
- **Phase 4 — lab list search/filter.** `LabListPage.tsx`: added a `Form.Control` search box
  (client-side filter over the existing `labs` array by name — `api.listLabs()` already
  returns everything, no new endpoint needed) plus a distinct "No labs match "<query>"." empty
  state, separate from the existing "No labs yet." state shown when there are zero labs at
  all. Verified with three test labs: typing a filter that matches one, typing one that
  matches none (confirms the new empty state), and clearing it back to the full list.

Decisions made without a separate ask, so the user can object rather than being asked six
small questions upfront: no new icon library — any future role-based device shape
differentiation (router vs. host) would use SVG shape (hexagon vs. rounded-rect), not icons;
the topology side panel stays as a panel, not a containerlab-style floating popup; no
terminal "chrome" decoration; edge-label position unchanged (containerlab's two-label-per-
link convention doesn't map onto this project's bipartite device/collision-domain model).
Explicitly out of scope: a layered/horizontal topology layout toggle (a different rendering
engine's feature; this project's force-directed physics sim would need a rewrite, not a style
change) and a persistent lab→device→interface sidebar tree (a navigation change, not a style
one — duplicates what the Topology/Devices tabs already do). Optional, independently
shippable stretch items *not* picked up here: role-icon shapes, an icon-only toolbar restyle,
inline single-IP node labels.

## Lab upload & persistence (2026-07-18)

### Context

Requested by the user: upload a lab as a directory, and have labs stored somewhere durable.
Before this, import was JSON/text-only (`LabImportRequest.files: dict[str, str]` — binary files
had to be omitted and listed in `skipped_files`), the React frontend had no import/upload UI at
all, and `LabRegistry` was pure in-memory dicts — **every** lab (however created) was lost on
restart. Deploy also used Kathara's in-memory `mem://` fs plus a bespoke post-deploy
copy_files+exec workaround (`_apply_pending`), rather than the framework's own file-packing.

Chose the thorough option over incremental alternatives: binary-safe `.zip` upload, **every**
lab (uploaded, JSON-created, or lab.conf/folder-imported) persisted to disk as a real Kathara lab
directory and reloaded on restart, and adoption of Kathara's native on-disk `Lab(path=...)` so
deploy uses the framework's own `Machine.pack_data` (tar-over-Docker-API) instead of the old
workaround for a machine's first deploy.

### Storage layer — `src/kathara_api/services/lab_store.py` (new)

`LabStore(root)`, rooted at `ApiSettings.labs_dir` (env `KATHARA_API_LABS_DIR`, default
`./data/labs`). Each lab lives at `<root>/<name>/` as a real Kathara lab directory (`lab.conf`,
`<machine>.startup`, per-machine subfolders). Key methods: `write_lab`/`extract_zip` (both
atomic — write to a sibling `.tmp` dir then `os.replace`), `read_lab` (directory → text
path→content map, binary files skipped — only relevant to the reload path's pending
reconstruction, not to deploy, which reads real files off disk directly), `delete_lab`,
`sanitize_lab_name` (single-path-segment allowlist, blocks traversal), and zip-slip-safe path
joining in `extract_zip` (every archive member resolved and checked against the destination
root before writing).

`gen_lab_conf(lab)` regenerates `lab.conf` from a built `Lab` object — Kathara ships parsers
(`LabParser`, `FolderParser`) but no writer, so every persisted lab's `lab.conf` is *always*
regenerated from the model rather than kept verbatim from an uploaded/imported source (built on
a reference implementation the user supplied, extended for lab metadata, MAC-optional interface
lines, and full meta coverage — ports/envs/sysctls/ulimits/exec). Verified to round-trip through
both this project's own parser and Kathara's actual `LabParser` (a temp-dir integration check,
not just a unit test).

### Native on-disk deploy — `lab_builder.build_lab`, `kathara_service.py`

`build_lab(spec, path=None)` now constructs `Lab(spec.name, path=path)` — every lab is OS-backed
(`osfs://`), not `mem://`. A new `_materialize_pending_to_fs` writes a machine's queued
files/dirs (via `machine.create_file_from_string`, auto-creating `machine.fs` if needed) and its
combined startup script (via `lab.create_file_from_string(..., f"{name}.startup")`) onto the real
directory *before* that machine's first deploy, so Kathara's own `Machine.pack_data` packs them
into the container over the Docker API — the old copy_files+exec push is no longer needed for a
fresh deploy.

Two real bugs were found and fixed while verifying this against actual Docker (not just the
unit-tested fake facade):

1. **This repo's own `deploy_lab` would crash a genuine redeploy.** Kathara's `DockerMachine.
   create()` raises `MachineAlreadyExistsError` for a machine that's already running — but the
   pre-existing `deploy_lab` always called the facade with the *full* target machine set,
   including already-running ones (this predates Phase 2; the fake facade in the unit tests
   never modeled the error, so it went undetected until a real redeploy 409'd). Fixed by
   splitting target machines into "freshly created" (passed to the facade; their pending state
   is materialized to disk first) vs. "already running" (never passed to the facade again —
   instead pushed a live update via the old copy_files+exec path, `_apply_pending`, now scoped
   to just that subset). Regression test:
   `test_redeploy_never_repasses_already_running_machines_to_facade`.
2. **Kathara's own `shared_mount` per-lab override is silently ignored** in
   `DockerMachine.create()` (`../Kathara/src/Kathara/manager/docker/DockerMachine.py`) —
   `shared_mount = ['shared_mount'] if 'shared_mount' in lab_options else ...` constructs a
   truthy *list literal* instead of doing the dict subscript `lab_options['shared_mount']` the
   sibling `deploy_machines()` method correctly does. Not fixed (out of scope, sibling repo) but
   worked around: since this API deliberately merges `shared/` files into each machine's own
   tree instead of relying on Kathara's native `/shared` bind mount (that bind mount is resolved
   by the *true* Docker host, not the API container — Docker-outside-of-Docker), and
   `lab.shared_path` only ever gets set via `create_shared_folder()`'s *own*, correctly-gated
   call site (`deploy_machines()`, not the buggy one in `create()`), disabling `shared_mount` via
   `lab.add_option("shared_mount", False)` in `build_lab` still works in practice — confirmed via
   real Docker that no `shared/` directory is ever created under the lab dir and no bind mount
   appears in `docker inspect`. (A `/shared` *anonymous Docker volume* does still appear on every
   container — that's `kathara/base`'s own `VOLUME ["/hosthome", "/shared"]` Dockerfile
   directive, entirely unrelated to Kathara's mount logic or this API's storage.)

`shared.startup`/`<machine>.startup` friction: since a machine's *combined* startup script
(shared + own + inline execs, already concatenated by `lab_import.translate_lab_files`) is
written as that machine's own `<machine>.startup` file, any standalone `shared.startup`/
`shared.shutdown` a raw upload might contain is deleted after materialization in `upload_lab` —
otherwise Kathara's `pack_data` would auto-pick up the literal `shared.startup` file *too* and
run its content a second time.

### Upload endpoint — `POST /api/labs/upload`

`routers/labs.py`, `UploadFile` + optional `Form` fields `name`/`deploy` (added
`python-multipart` to `pyproject.toml`). `KatharaService.upload_lab`: sanitizes the name,
rejects a duplicate before touching disk, extracts the zip (binary-safe — unlike `import_lab`,
whose `files` are JSON/text and can't carry binaries), parses the extracted directory the same
way as a JSON import, materializes pending state, regenerates `lab.conf`, and rolls back the
extracted directory on any failure before registration succeeds. Verified end-to-end against
real Docker: a zip containing a binary file, a `shared/` file, and a startup script all landed
correctly in a real deployed container (binary content confirmed byte-identical via `md5sum`
inside vs. outside the container).

### Frontend — `UploadLabModal.tsx`

New component (separate from `NewLabModal`, which stays JSON-only — the two flows share no
state or submit lifecycle) with a `.zip` file input (name auto-derived from the filename) and a
"Upload lab" button next to "+ New lab" on `LabListPage`. `api.ts` gained a `uploadLab(file,
name?)` method using a new `requestForm` helper — a `FormData` POST that deliberately does *not*
set `Content-Type` itself, so the browser sets `multipart/form-data` plus the boundary. New
`LabImportResult` type (mirrors backend `schemas/lab_import.py`, surfaces `warnings` via toast).
Verified with a real Playwright click-through: choose file → name auto-fills → Upload → modal
closes → lab appears in the list → Deploy succeeds through the real backend.

### Persistence — reload on startup, pending-edit write-through

`KatharaService.__init__` now takes an injectable `LabStore` (defaults to
`ApiSettings.labs_dir_path()`) and calls `_reload_from_disk()` at construction: every stored lab
directory is reparsed (reusing `lab_import.translate_lab_files`) and re-registered as an
OS-backed `Lab`, with its pending state reconstructed too. `update_pending_files`/
`update_shared_pending_files` (the Explorer's queue-an-edit endpoints) now also materialize
straight to disk, immediately — not just at next deploy — so an edit made before a lab is *ever*
deployed still survives a restart. This is independent of the Explorer's own live-push-to-a-
running-container calls (`copyFiles`+`execCommand`, made directly by the frontend); it only keeps
the on-disk source of truth current.

Verified against real Docker at every phase (not just unit tests): labs surviving a full backend
process restart and a full Docker Compose container restart; a pending edit queued *before* any
deploy surviving a restart and correctly applying on the eventual first deploy; a redeploy of an
already-running machine no longer crashing and instead live-pushing exactly once; an uploaded
zip's binary file round-tripping byte-for-byte into a real container.

### Docker Compose

Both `docker-compose-dev.yml` and `docker-compose-prod.yml` gained a `labs_data` named volume
mounted at `/app/data/labs` (matching `WORKDIR /app` in both backend Dockerfiles) plus
`KATHARA_API_LABS_DIR=/app/data/labs`. A plain named volume is sufficient — not the
identical-host-path bind mount that would otherwise be needed for Docker-outside-of-Docker
bind-mount visibility — because `shared_mount` is always disabled per-lab (see above), so nothing
under this volume is ever bind-mounted into a sibling device container; machine files/startup
always travel over the Docker API instead. Verified for real: built and brought up
`docker-compose-dev.yml`'s backend service, created a lab, restarted just the `backend`
container, confirmed the lab was still listed, then uploaded+deployed a lab through the
containerized (DinD) backend successfully. Added `data` to `.dockerignore` and `data/` to
`.gitignore`.

### Tests

`tests/unit/test_lab_store.py` (new): `gen_lab_conf` round-trip through both parsers, binary
write/read, zip extraction (flat layout, wrapper-folder stripping, binary preservation,
zip-slip rejection), directory reload, deletion. `tests/unit/test_persistence.py` (new):
create/import/upload write a directory; a fresh `KatharaService` reloads labs and pending state
from disk; delete removes the directory; a pending edit write-through survives a restart before
any deploy; a shared pending edit materializes to every machine. `tests/unit/
test_lab_import_service.py`: updated deploy-related tests for the new native-fs contract (a
fresh deploy materializes to disk instead of using copy_files/exec; a redeploy of an
already-running machine still live-pushes, exactly once) plus new `upload_lab` tests (binary
content, duplicate-name rejection, rollback-on-parse-error, deploy-immediately). All additions
run under `pytest -m "not docker"` (68 passed).

**Independently re-verified against real Docker (2026-07-18)**: uploaded a `.zip` lab (one
device, a `shared/etc/motd` file, a `pc1.startup` writing a marker file, and a genuinely binary
`pc1/etc/blob.bin`) through `POST /api/labs/upload`, deployed it, and confirmed via `exec`: the
binary file's bytes landed intact (`Machine.pack_data`'s Docker-API tar transfer is binary-safe,
unlike the old JSON-only pending-files path), the `shared/` file was merged into `pc1`'s own tree
(not left as a native `/shared` bind mount), and `pc1.startup` actually ran. Undeployed, deleted,
and confirmed zero leftover containers.

## Verbatim lab.conf persistence (2026-08-26) — supersedes "always regenerated" above

The design at line ~449 above ("every persisted lab's `lab.conf` is *always* regenerated from
the model rather than kept verbatim") turned out to be the wrong call: it silently dropped
`[volume]`, `[exec]`, `[num_terms]`/`[entrypoint]`/`[args]`, comments, ordering, quoting style,
and any option the model didn't carry, on every import. Reversed:

- `lab_import.py`'s parser is now lossless into the model (`num_terms`/`entrypoint`/`args`
  mapped; unknown options and `exec_commands` kept as pass-through/model fields instead of
  dropped; only `[volume]` stays unapplied, for the reason given in `BACKEND.md`). An
  unrecognized top-level `KEY=value` line is a warning, not a fatal error — a hard error there
  used to mean the whole lab silently disappeared from the registry on the next restart.
- Import/upload/editor-save now persist `lab.conf` **verbatim** (`LabStore.write_lab_conf_text`,
  atomic) instead of round-tripping it through `gen_lab_conf`. `gen_lab_conf` survives only for
  `create_lab` (JSON-described labs with no source file).
- Offline structural edits (add/remove device, connect/disconnect on a stopped device) moved from
  "rebuild a `Lab` from disk, re-serialize the whole file" to surgical text edits
  (`services/lab_conf_edit.py`) that touch only the lines an edit actually changes. This also
  fixed a live bug: disconnecting a device's *middle* interface used to leave a numbering gap
  that made the lab fail to reload after a restart.
- `GET /api/labs/{lab}/lab-conf` was added so the editor shows (and round-trips) the real on-disk
  file instead of a client-side reconstruction (`labfs.ts`'s old `genLabConf` was deleted).
- Deliberately **out of scope for now**: a `shared/` folder in an imported lab is left untouched
  on disk and reported as a warning rather than merged into every device's tree (the previous
  per-machine-copy approach also isn't verbatim-safe). Delivering `shared/` to containers without
  writing derived copies to disk is a follow-up.

See `BACKEND.md`'s "Architecture at a glance" for the current, load-bearing description of this
area — this entry is left as history, not as the current design.
