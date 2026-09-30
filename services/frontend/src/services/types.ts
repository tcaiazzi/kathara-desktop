// Mirrors the response/request schemas in src/kathara_api/schemas/*.py.

export interface Message {
  detail: string;
}

export interface WipeResult extends Message {
  failed: string[];
}

export interface ErrorResponse {
  detail: string;
  error_type: string;
}

export interface SystemInfo {
  manager: string;
  // null when the backend can't reach the Docker daemon: this is the daemon's own version, the
  // only field here that needs it. The rest stays accurate with Docker stopped.
  version: string | null;
  available_managers: Record<string, string>;
  // Whether the backend process's real UID is 0 — Kathara's own gate for privileged devices
  // checks this, not Docker socket access. See ElevationContext.tsx.
  is_admin: boolean;
}

// Mirrors Kathara's Setting class plus the Docker addon (schemas/settings.py's SettingsView) — the
// full known field surface, each optional since it depends on which addon merged in (only
// manager_type/image are ever guaranteed).
export interface SettingsView {
  manager_type: string;
  image: string;
  terminal?: string;
  open_terminals?: boolean;
  device_shell?: string;
  net_prefix?: string;
  device_prefix?: string;
  debug_level?: string;
  print_startup_log?: boolean;
  enable_ipv6?: boolean;
  volume_mount_policy?: string;
  // Read-only: when the Kathara CLI last checked for a newer Kathara release — its own
  // bookkeeping, never sent back on update.
  last_checked?: number;
  // Docker addon
  hosthome_mount?: boolean;
  shared_mount?: boolean;
  image_update_policy?: string;
  shared_cds?: number;
  // Read-only: the backend schema (SettingsUpdate) rejects both on write. Redirecting this
  // backend's Docker client to an arbitrary daemon has no legitimate runtime use case here —
  // changing it means editing Kathara's own settings file and restarting.
  remote_url?: string | null;
  cert_path?: string | null;
  network_plugin?: string;
  // This app's own upload/import caps (ApiSettings), not a Kathara setting and never written to
  // kathara.conf. The backend applies a change at once but only for its own lifetime; the desktop
  // app keeps it and passes it to every backend it starts (DesktopApi.setUploadLimits).
  max_files_per_lab?: number;
  max_bytes_per_file?: number;
  max_bytes_per_lab?: number;
  // Read-only, about kathara.conf itself: its path, why it could not be read (defaults in use,
  // saving refused until fixed), and the values in it this session ignores.
  settings_file?: string;
  settings_file_error?: string | null;
  settings_warnings?: string[];
}

// The fields SettingsView only reports, never part of an update — see services/settings.ts.
export type SettingsReadOnlyKey =
  | "last_checked"
  | "remote_url"
  | "cert_path"
  | "settings_file"
  | "settings_file_error"
  | "settings_warnings";

export type SettingsUpdate = Partial<Omit<SettingsView, SettingsReadOnlyKey>>;

interface LabMetadata {
  description: string | null;
  version: string | null;
  author: string | null;
  email: string | null;
  web: string | null;
}

// Mirrors schemas/lab.py LabConfView — the lab's on-disk lab.conf, verbatim.
export interface LabConfView {
  content: string;
  exists: boolean;
}

export interface LabSummary {
  name: string | null;
  // What every per-lab call and route takes. Derived by the backend from the lab directory's path
  // (and equal to its Kathara hash), so a rename changes it — never build one from `name`.
  id: string;
  // The lab's directory on the host; null for a lab known only from running containers.
  path: string | null;
  // Whether that directory is under the labs root rather than a folder opened from elsewhere: a
  // managed lab is deleted, an opened one is only closed (its folder is the user's own).
  managed: boolean;
  // Set only for an opened folder that is remembered but not loaded: "missing" (not there) or
  // "unloadable" (its lab.conf doesn't parse). It can only be closed; it loads by itself once back.
  problem?: string | null;
  n_machines: number;
  n_links: number;
  // Whether any device is running; `n_running` says how many — a lab can be partly running, since
  // devices are deployed one at a time as well as all together (services/labRunState.ts).
  deployed: boolean;
  n_running: number;
  // Why the last deploy failed, while devices it was meant to start are still stopped; null once
  // a deploy succeeds or nothing runs.
  deploy_error?: string | null;
}

// Mirrors the backend's lab events (GET /api/events; KatharaService.handle_disk_change): a lab's
// lab.conf or startup scripts changed on disk outside this app, or its devices in Docker.
// `conf-reloaded` — the topology was
// rebuilt from the new lab.conf; `conf-pending` — not applied because the lab is deployed;
// `conf-invalid` — not applied because it doesn't load (`detail` says why); `startup` — the listed
// `<device>.startup` / `shared.startup` files changed; `missing` — the lab's folder is gone. A
// stopped lab is then listed as missing (an opened folder) or not at all (a lab in the labs
// folder); a deployed one stays as it is until it stops, which `detail` says. `adopted` — a lab
// folder that appeared in the labs folder was loaded (KatharaService.rescan_labs_root). `runtime` —
// the lab's devices were started, stopped or changed state outside the app, e.g. from the CLI
// (KatharaService.check_running_labs).
export type LabEventKind =
  | "conf-reloaded"
  | "conf-pending"
  | "conf-invalid"
  | "startup"
  | "missing"
  | "adopted"
  | "runtime";

export interface LabEvent {
  lab_id: string;
  kind: LabEventKind;
  files: string[];
  detail: string | null;
}

// What a whole-lab action needs: `id` to address the lab, `name` to talk about it to the user.
export type LabRef = Pick<LabSummary, "id" | "name">;

export interface PortMapping {
  host_port: number;
  guest_port: number;
  protocol: "tcp" | "udp" | "sctp";
}

export interface InterfaceModel {
  num: number;
  link: string;
  mac_address: string | null;
}

export interface VolumeMount {
  host_path: string;
  guest_path: string;
  mode: "ro" | "rw" | "rx";
}

export interface Ulimit {
  name: string;
  soft: number;
  hard: number | null;
}

// Mirrors backend schemas/machine.py's MachineOptionsBase — every device "option"/meta this API
// models explicitly, shared by the add-device payload and the update-device payload. MachineDetail
// below layers `name`/`interfaces`/`running`/`status` on top, so on this side the field list lives
// in exactly one place (the backend's MachineDetail repeats it field by field).
export interface MachineOptionsPayload {
  image: string | null;
  mem: string | null;
  cpus: number | null;
  ports: PortMapping[];
  envs: Record<string, string>;
  sysctls: Record<string, string | number>;
  exec_commands: string[];
  volumes: VolumeMount[];
  ulimits: Ulimit[];
  privileged: boolean;
  bridged: boolean;
  ipv6: boolean | null;
  shell: string | null;
  num_terms: number | null;
  entrypoint: string | null;
  args: string | null;
  metas: Record<string, string>;
}

export type MachineUpdatePayload = MachineOptionsPayload;

export interface MachineDetail extends MachineOptionsPayload {
  name: string;
  interfaces: InterfaceModel[];
  running: boolean;
  status: string | null;
}

export interface LinkDetail {
  name: string;
  machines: string[];
  external: string[];
  running: boolean;
  // No device on it yet, so not in lab.conf: kept for the backend's session only, until a device
  // is connected to it (KatharaService.add_link).
  draft: boolean;
  // The Docker network plugin: the one its network was created with while it is up, else the
  // configured one a deploy would use. Null if the backend could not tell.
  network_plugin: string | null;
}

export interface LabDetail extends LabSummary {
  metadata: LabMetadata;
  machines: MachineDetail[];
  links: LinkDetail[];
  // The devices the failed deploy (`deploy_error`) was meant to start: the error explains the ones
  // among them still stopped, and says nothing about any other device.
  deploy_failed_machines: string[];
}

// Response for POST /api/labs/upload — mirrors backend
// schemas/lab_import.py's LabImportResult (LabDetail plus non-fatal parse warnings, e.g. a
// lab.conf directive the API doesn't support).
export interface LabImportResult extends LabDetail {
  warnings: string[];
}

// One bundled example network scenario (backend schemas/examples.py's ExampleSummary) — the
// "start from an example" list on the frontend's welcome screen.
export interface ExampleLab {
  // The examples catalog's directory name; also the default lab name if installed as-is.
  id: string;
  description: string | null;
  author: string | null;
  n_machines: number;
  // Whether a lab with this id already exists — the welcome screen renders "Open" instead of
  // "Create" when true.
  installed: boolean;
}

// One installable lab in the upstream Kathara-Labs gallery (backend schemas/gallery.py's
// GalleryLabSummary) — the "Browse Kathara Labs" modal's catalog. The remote twin of ExampleLab.
export interface GalleryLab {
  // Repo-relative path of the lab directory upstream — unique, and what POST /labs/gallery takes.
  id: string;
  // Lab name this installs as (disambiguated server-side when two upstream labs share a basename).
  name: string;
  category: string;
  n_files: number;
  size_bytes: number;
  // github.com link to the lab's *parent* directory upstream — not the lab directory itself, since
  // the parent also holds the lab's slides PDF (if any) and README (if any).
  repo_url: string;
  // Whether a lab named `name` already exists locally — same "Open" vs "Import" convention as
  // ExampleLab.installed.
  installed: boolean;
}

// GET /api/labs/gallery's response (backend schemas/gallery.py's GalleryCatalog).
export interface GalleryCatalog {
  repo: string;
  ref: string;
  section: string;
  // Unix timestamp (seconds) of the fetch this catalog came from — the backend caches it, so this
  // can legitimately be minutes old.
  fetched_at: number;
  labs: GalleryLab[];
}

// A lab's fixed topology layout — the content of its `lab.layout` file (backend schemas/lab.py's
// LabLayout). Keys are topology node ids (`dev:<machine>` / `cd:<collision domain>`); an empty
// `nodes` map means the lab has no fixed layout.
export interface LabLayout {
  version: number;
  nodes: Record<string, { x: number; y: number }>;
}

// Deliberately the subset the UI actually sends, not a full mirror of the backend's `LabCreate`
// (which also accepts metadata, machines and links): the only creation path here posts a name and
// nothing else — everything richer arrives through import or upload. Kept this narrow on
// purpose: a `Record<string, unknown> & { name: string }` would let a typo'd key type-check.
export interface LabCreate {
  name: string;
}

// Mirrors schemas/filesystem.py's FsEntry. The tree only draws `name`/`path`/`is_dir`; the rest
// is carried because the response has it, so a panel that wants to show size or mtime doesn't
// have to widen the schema first.
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  mode: string | null;
  mtime: number | null;
}

export interface FsListResponse {
  path: string;
  entries: FsEntry[];
}

export interface FsReadTextResponse {
  path: string;
  content: string;
}

export interface FsUploadResponse {
  path: string;
  size: number;
}

export interface FsSearchMatch {
  path: string;
  line_number: number;
  line_text: string;
}

export interface FsSearchResponse {
  query: string;
  matches: FsSearchMatch[];
  truncated: boolean;
}

// A running device's boot-time startup progress — the live /var/log/startup.log tail and whether
// its startup commands (.startup script + exec_commands) have finished executing.
export interface StartupStatus {
  log: string;
  finished: boolean;
}

// GET /labs/{lab}/live-addresses: device -> interface number -> the addresses actually on it, for
// each running device whose startup has finished. JSON object keys, so the numbers are strings.
export type LiveAddresses = Record<string, Record<string, string[]>>;

// Docker image state for a lab, ahead of a deploy. Only `missing` (mandatory) and `outdated`
// (optional) are actionable; `not-found` is a missing image the registry won't serve, so no
// download is offered for it (see LabImagesStatus.not_found); `unknown` means the registry
// couldn't be consulted (offline, or slower than the backend's time budget) and is deliberately
// not reported as `ok`.
type ImageState = "ok" | "missing" | "not-found" | "outdated" | "unknown";

interface LabImageStatus {
  name: string;
  state: ImageState;
}

export interface LabImagesStatus {
  // Kathara's own image_update_policy: Prompt | Always | Never. Passed through so the client
  // decides whether to *ask* about an update or just take it, matching the CLI's behaviour.
  update_policy: string;
  images: LabImageStatus[];
  missing: string[];
  // Missing images the registry says it doesn't have, or won't serve without a login — not in
  // `missing`, since no download can fetch them; only the image name can be fixed.
  not_found: string[];
  outdated: string[];
}

// Suggestions for an "image" field, split by source so the picker can label the two sections.
// `local` never repeats an entry already in `official`. Either list can be empty — Docker Hub
// unreachable, or the Docker daemon stopped — and neither case is an error.
export interface AvailableImages {
  official: string[];
  local: string[];
}

export interface ImagePullResult {
  pulled: string[];
}

// Snapshot of the single in-flight image download. `total_bytes` of 0 means *indeterminate*, not
// empty: Docker announces layers as the stream starts, so the total is unknown at first and grows
// as layers appear — clamp the displayed percentage rather than letting a bar run backwards.
export interface ImagePullProgress {
  active: boolean;
  finished: boolean;
  image: string | null;
  images_total: number;
  images_done: number;
  downloaded_bytes: number;
  total_bytes: number;
  // Per-layer detail the progress bar doesn't draw — it shows bytes and the server-authored
  // `detail` line instead. Mirrored because the response carries it.
  layers_total: number;
  layers_done: number;
  extracting: boolean;
  elapsed_seconds: number;
  detail: string;
  error: string | null;
}

export interface MachineStats {
  name: string;
  container_name: string | null;
  status: string | null;
  image: string | null;
  pids: number | null;
  cpu_usage: string | null;
  mem_usage: string | null;
  mem_percent: string | null;
  net_usage: string | null;
  interfaces: string | null;
}
