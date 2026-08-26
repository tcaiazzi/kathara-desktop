// Mirrors the response/request schemas in src/kathara_api/schemas/*.py.

export interface Message {
  detail: string;
}

export interface ErrorResponse {
  detail: string;
  error_type: string;
}

export interface SystemInfo {
  manager: string;
  version: string;
  available_managers: Record<string, string>;
}

// Mirrors Kathara's Setting class plus whichever manager addon is active (extra="allow" on the
// backend schema, so only manager_type/image are ever guaranteed — everything else here is
// optional since it depends on which addon merged in).
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
  // Read-only internal bookkeeping (last GitHub-release-check time) — display only, never sent
  // back on update.
  last_checked?: number;
  // Docker addon
  hosthome_mount?: boolean;
  shared_mount?: boolean;
  image_update_policy?: string;
  shared_cds?: number;
  remote_url?: string | null;
  cert_path?: string | null;
  network_plugin?: string;
  // Kubernetes addon
  api_server_url?: string | null;
  api_token?: string | null;
  host_shared?: boolean;
  image_pull_policy?: string;
  docker_config_json?: string | null;
}

export type SettingsUpdate = Partial<Omit<SettingsView, "last_checked">>;

export interface LabMetadata {
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
  hash: string;
  n_machines: number;
  n_links: number;
  deployed: boolean;
}

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

export interface MachineDetail {
  name: string;
  image: string | null;
  mem: string | null;
  cpus: number | null;
  ports: PortMapping[];
  envs: Record<string, string | number>;
  sysctls: Record<string, string | number>;
  exec_commands: string[];
  interfaces: InterfaceModel[];
  bridged: boolean;
  running: boolean;
  status: string | null;
}

export interface LinkDetail {
  name: string;
  machines: string[];
  external: string[];
  running: boolean;
}

export interface LabDetail extends LabSummary {
  metadata: LabMetadata;
  machines: MachineDetail[];
  links: LinkDetail[];
}

// Response for POST /api/labs/upload (and /api/labs/import) — mirrors backend
// schemas/lab_import.py's LabImportResult (LabDetail plus non-fatal parse warnings, e.g. a
// lab.conf directive the API doesn't support).
export interface LabImportResult extends LabDetail {
  warnings: string[];
}

// A lab's fixed topology layout — the content of its `lab.layout` file (backend schemas/lab.py's
// LabLayout). Keys are topology node ids (`dev:<machine>` / `cd:<collision domain>`); an empty
// `nodes` map means the lab has no fixed layout.
export interface LabLayout {
  version: number;
  nodes: Record<string, { x: number; y: number }>;
}

// The "New lab from JSON" flow accepts a raw JSON blob rather than a full typed form.
export type LabCreate = Record<string, unknown> & { name: string };

// Files/dirs/startup queued for a machine, applied on the lab's next deploy (see
// services/lab_import.py and services/registry.py on the backend).
export interface PendingMachineFiles {
  files: Record<string, string>;
  dirs: string[];
  startup: string;
}

export interface ExecResult {
  machine: string;
  stdout: string;
  stderr: string;
  exit_code: number;
}

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
