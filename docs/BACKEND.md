# Kathara REST API — Backend reference

FastAPI backend (`src/kathara_api`) that wraps the [Kathara](https://www.kathara.org) network-emulation
framework and exposes it over HTTP. This document lists every endpoint so they can be reviewed at a
glance. Generated from `src/kathara_api/routers/*.py`.

## Architecture at a glance

- **`main.py`** builds the app and mounts every router under the **`/api`** prefix. All paths below
  include it.
- **`services/kathara_service.py`** (`KatharaService`) — the single integration point with Kathara. It
  holds the `Kathara.get_instance()` facade behind a mutation lock and a process-local `LabRegistry`
  (`services/registry.py`); state is single-worker by design.
- **`services/lab_store.py`** (`LabStore`) — on-disk persistence of labs under `KATHARA_API_LABS_DIR`
  (atomic tmp-swap writes). An imported/uploaded/hand-edited `lab.conf` is always persisted
  **verbatim** — byte for byte, comments/quoting/ordering and all — via `write_lab_conf_text`;
  `gen_lab_conf` (a generator, since Kathara ships only readers) is used for exactly one case: a
  JSON-created lab (`POST /labs`) that has no source file to preserve.
- **`services/lab_import.py`** / **`lab_builder.py`** / **`serializers.py`** — parse `lab.conf`/folders,
  build Kathara model objects, and serialize models back to response schemas. Options this API
  doesn't interpret (an unknown `machine[key]=value`, an unrecognized top-level `KEY=value` line)
  are warnings, not errors: they stay in the file untouched but don't block the import. Only
  `[volume]` is *never* applied to the model (an arbitrary host bind-mount is a real risk over
  REST), though it too survives verbatim in the file.
- **`services/lab_conf_edit.py`** — surgical, line-level `lab.conf` text edits (add/remove a device,
  add/remove an interface, set/unset a meta or `LAB_*` directive). Every offline structural change
  (`add_machine`, `remove_machine`, `connect_machine`/`disconnect_machine` on a stopped device) goes
  through this module instead of rebuilding the file from a model, so only the lines an edit
  actually changes are touched — comments, ordering and unmodelled options elsewhere in the file
  survive untouched. Every edit re-validates against the parser/builder before it's written.
- **`errors.py`** — maps Kathara + API exceptions to HTTP status codes (see below); routers stay free of
  try/except.
- **Fixed topology layout** — a lab may pin its topology-graph node positions in a `lab.layout` file
  at the lab root (JSON; keys are `dev:<machine>` / `cd:<collision domain>`). It is presentation
  metadata only: unknown to Kathara and ignored by `lab_import`, so it rides along with the lab
  directory (zip download/upload, restarts) without affecting the topology itself. An absent or
  unparseable file simply means "no fixed layout".
- **Config vs runtime** — interface edits on a **stopped** device modify `lab.conf` (persisted config,
  via `lab_conf_edit` — never by serializing the live model, so a running sibling's runtime
  interfaces can't leak in); edits on a **running** device use Kathara's runtime manager APIs (live
  only, never written to `lab.conf`). A full undeploy restores the saved-config topology.

### Error mapping (`errors.py`)

| Situation | HTTP |
|---|---|
| `LabNotFoundError`, `MachineNotFoundError`, `LinkNotFoundError`, `DockerImageNotFoundError`, `InterfaceNotFoundError` | 404 |
| `*AlreadyExistsError`, `MachineNotRunningError`, `MachineNotReadyError`, `EmptyLabError`, settings/lab.conf locked | 409 |
| `InvocationError`, `MachineOptionError`, `MachineCollisionDomainError`, `NotSupportedError`, … | 400 |
| `SyntaxError` (invalid device name / lab.conf value) | 422 |
| `DockerDaemonConnectionError`, builtin `ConnectionError` (registry unreachable) | 503 |
| `HTTPConnectionError`, `DockerPluginError` | 502 |
| anything else | 500 |

Errors return `{"detail": str, "error_type": str}`.

---

## System — `/api`

| Method | Path | Purpose | Body / params | Response |
|---|---|---|---|---|
| GET | `/api/health` | Liveness probe | — | `{status}` |
| GET | `/api/system` | Manager name/version + available managers | — | `SystemInfo` |
| GET | `/api/settings` | Current Kathara settings | — | `SettingsView` |
| PUT | `/api/settings` | Update settings (`manager_type` only before first use → 409; others runtime-updatable) | `SettingsUpdate` | `SettingsView` |
| POST | `/api/system/images/check` | Validate an image is available (503 if registry unreachable) | `{image}` | `Message` |
| POST | `/api/system/wipe` | Undeploy all of the user's running scenarios | — | `Message` |

## Labs — `/api/labs`

| Method | Path | Purpose | Body / params | Response |
|---|---|---|---|---|
| POST | `/api/labs` | Create a lab from a JSON description (not deployed) | `LabCreate` | `LabDetail` (201) |
| POST | `/api/labs/import/preview` | Dry-run parse of a lab.conf/folder (creates nothing) | `LabImportRequest` | `LabImportPreview` |
| POST | `/api/labs/import` | Create (and optionally deploy) from lab.conf/.startup/folder files | `LabImportRequest` | `LabImportResult` (201) |
| POST | `/api/labs/upload` | Create (and optionally deploy) from an uploaded `.zip` (binary-safe) | multipart: `file`, `name?`, `deploy?` | `LabImportResult` (201) |
| GET | `/api/labs` | List known scenarios | — | `LabSummary[]` |
| GET | `/api/labs/{lab}` | Lab detail (devices + collision domains) | — | `LabDetail` |
| GET | `/api/labs/{lab}/download` | Download the lab directory as `.zip` | — | `application/zip` |
| GET | `/api/labs/{lab}/lab-conf` | The lab's on-disk `lab.conf`, verbatim (`exists: false` if none yet) | — | `LabConfView {content, exists}` |
| PUT | `/api/labs/{lab}/lab-conf` | Apply an edited `lab.conf`, stored verbatim (rebuilds topology; 409 if deployed) | `{content}` | `LabDetail` |
| GET | `/api/labs/{lab}/layout` | Fixed topology layout (`lab.layout`); empty `nodes` when the lab has none | — | `LabLayout` |
| PUT | `/api/labs/{lab}/layout` | Fix the topology layout (writes `lab.layout` into the lab directory) | `LabLayout {version, nodes}` | `LabLayout` |
| DELETE | `/api/labs/{lab}/layout` | Remove the fixed layout (back to automatic layout) | — | `Message` |
| GET | `/api/labs/{lab}/pending-files` | Queued files/dirs/startup per machine | — | `{machine: PendingMachineFiles}` |
| POST | `/api/labs/{lab}/deploy` | Deploy all / a subset | `DeployOptions {selected_machines?, excluded_machines?}` | `LabDetail` |
| POST | `/api/labs/{lab}/undeploy` | Undeploy all / a subset (full undeploy restores config topology) | `UndeployOptions {selected_machines?, excluded_machines?}` | `Message` |
| POST | `/api/labs/{lab}/rename` | Rename the lab directory (409 if deployed or name taken) | `LabRename {name}` | `LabDetail` |
| DELETE | `/api/labs/{lab}` | Delete the lab (undeploy + remove on disk) | — | `Message` |

## Machines — `/api/labs/{lab}/machines`

| Method | Path | Purpose | Body / params | Response |
|---|---|---|---|---|
| GET | `…/machines` | List devices | — | `MachineDetail[]` |
| GET | `…/machines/{m}` | Device detail | — | `MachineDetail` |
| POST | `…/machines` | Add + deploy a device | `MachineCreate` | `MachineDetail` (201) |
| DELETE | `…/machines/{m}` | Undeploy + remove a device | `?keep_links=false` | `Message` |
| POST | `…/machines/{m}/connect` | Attach to a collision domain (running → runtime; stopped → lab.conf) | `?link=` `&interface_number=` `&mac_address=` | `MachineDetail` |
| POST | `…/machines/{m}/disconnect` | Detach from a collision domain | `?link=` `&keep_link=false` | `Message` |
| POST | `…/machines/{m}/files` | Copy inline text files into a running device | `CopyFilesRequest {files}` | `Message` |
| GET | `…/machines/{m}/fs/list` | List a runtime directory | `?path=/` | `FsListResponse` |
| GET | `…/machines/{m}/fs/text` | Read a UTF-8 text file | `?path=` | `FsReadTextResponse` |
| PUT | `…/machines/{m}/fs/text` | Write a text file | `FsWriteTextRequest {path, content}` | `Message` |
| POST | `…/machines/{m}/fs/mkdir` | Create a directory (`mkdir -p`) | `FsMkdirRequest {path}` | `Message` |
| POST | `…/machines/{m}/fs/move` | Move/rename a path | `FsMoveRequest {sourcePath, destinationPath}` | `Message` |
| DELETE | `…/machines/{m}/fs` | Delete a path | `FsDeleteRequest {path, recursive?}` | `Message` |
| POST | `…/machines/{m}/fs/upload` | Upload a file (binary) | multipart: `path`, `file` | `FsUploadResponse` |
| GET | `…/machines/{m}/fs/download` | Download a file (octet-stream) | `?path=` | binary |
| PUT | `…/machines/{m}/pending-files` | Queue files/dirs/startup for a device | `PendingFilesUpdate` | `PendingMachineFiles` |
| PUT | `…/machines/shared-files` | Queue `shared/`-style files for every device | `SharedPendingFilesUpdate` | `{machine: PendingMachineFiles}` |

## Exec — `/api/labs/{lab}/machines/{m}`

| Method | Path | Purpose | Body / params | Response |
|---|---|---|---|---|
| POST | `…/{m}/exec` | Run a command, wait, return combined output | `ExecRequest {command, wait?}` | `ExecResult` |
| POST | `…/{m}/exec/stream` | Stream stdout/stderr as SSE, then a final `exit` event | `ExecRequest` | `text/event-stream` |
| WS | `…/{m}/exec/live/ws` | WebSocket command streaming (`run`/`close` → `output`/`exit`/`error`) | — | WebSocket |
| WS | `…/{m}/tty/ws` | Interactive TTY bridge (Docker) | `?shell=bash` | WebSocket |

## Stats — `/api/labs/{lab}`

| Method | Path | Purpose | Response |
|---|---|---|---|
| GET | `…/{lab}/stats` | One-shot machine stats snapshot | `MachineStats[]` |
| GET | `…/{lab}/machines/{m}/stats` | One-shot stats for a device (409 if not running) | `MachineStats` |
| GET | `…/{lab}/links/stats` | One-shot collision-domain stats | `LinkStats[]` |
| GET | `…/{lab}/stats/stream` | Live machine stats (SSE) | `text/event-stream` |
| GET | `…/{lab}/links/stats/stream` | Live collision-domain stats (SSE) | `text/event-stream` |

## Collision domains — `/api/labs/{lab}/links`

| Method | Path | Purpose | Body / params | Response |
|---|---|---|---|---|
| GET | `…/{lab}/links` | List collision domains | — | `LinkDetail[]` |
| POST | `…/{lab}/links` | Create a collision domain (optionally attached to host interfaces, `iface` or `iface.<vlan>`) | `{name, external?}` | `LinkDetail` (201) |
| DELETE | `…/{lab}/links/{name}` | Remove a collision domain | — | `Message` |

---

Interactive OpenAPI docs are also served at **`/docs`** (Swagger UI) and **`/redoc`** when the backend
is running, generated from these same route + schema definitions.
