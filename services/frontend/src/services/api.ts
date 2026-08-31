import type {
  ErrorResponse,
  ExecResult,
  FsListResponse,
  FsReadTextResponse,
  FsUploadResponse,
  LabConfView,
  LabCreate,
  LabDetail,
  LabImportResult,
  LabLayout,
  LabSummary,
  LinkDetail,
  MachineDetail,
  MachineUpdatePayload,
  Message,
  SettingsUpdate,
  SettingsView,
  StartupStatus,
  SystemInfo,
} from "./types";

// All backend routes live under /api. In dev this is proxied to the backend by Vite
// (vite.config.ts); in production the reverse proxy plays the same role — so this is always a
// same-origin, relative call, no base URL to configure.
const API_BASE = "/api";

export class ApiError extends Error {
  errorType: string;
  status: number;

  constructor(message: string, errorType: string, status: number) {
    super(message);
    this.errorType = errorType;
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = data as Partial<ErrorResponse> | null;
    throw new ApiError(
      err?.detail || res.statusText || `HTTP ${res.status}`,
      err?.error_type || `HTTP ${res.status}`,
      res.status,
    );
  }
  return data as T;
}

// Multipart POST (file upload). Unlike request<T>, this must NOT set Content-Type: the browser
// sets multipart/form-data plus the boundary itself from the FormData body.
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", body: form });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = data as Partial<ErrorResponse> | null;
    throw new ApiError(
      err?.detail || res.statusText || `HTTP ${res.status}`,
      err?.error_type || `HTTP ${res.status}`,
      res.status,
    );
  }
  return data as T;
}

export const api = {
  health: () => request<{ status: string }>("GET", "/health"),
  systemInfo: () => request<SystemInfo>("GET", "/system"),
  getSettings: () => request<SettingsView>("GET", "/settings"),
  updateSettings: (payload: SettingsUpdate) => request<SettingsView>("PUT", "/settings", payload),
  // Force-undeploys every lab kathara-ide has deployed, not just the currently open one — scopes
  // to labs this backend manages, unlike the Kathara CLI's own `kathara wipe`.
  wipeAll: () => request<Message>("POST", "/system/wipe", {}),
  // Browses the host machine's own filesystem (not a lab's or a device's) — backs the volume
  // host-path picker in the machine options editor.
  browseHost: (path: string) => request<FsListResponse>("GET", `/system/browse?path=${encodeURIComponent(path)}`),
  // Every `net.*` sysctl key available on this host's kernel — the only namespace Kathara accepts.
  listNetSysctls: () => request<string[]>("GET", "/system/sysctls"),
  // Official Kathara device images published on Docker Hub — suggestions for an "image" field,
  // not a restriction (any valid Docker image is still accepted).
  listAvailableImages: () => request<string[]>("GET", "/system/images"),

  listLabs: () => request<LabSummary[]>("GET", "/labs"),
  getLab: (name: string) => request<LabDetail>("GET", `/labs/${encodeURIComponent(name)}`),
  createLab: (payload: LabCreate) => request<LabDetail>("POST", "/labs", payload),
  // Binary-safe lab upload (a .zip of a standard Kathara lab directory) — unlike createLab's
  // JSON payload, this can carry non-text files. `name` is optional; the backend derives one
  // from the filename when omitted.
  uploadLab: (file: File, name?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (name && name.trim()) form.append("name", name.trim());
    return requestForm<LabImportResult>("/labs/upload", form);
  },
  // The lab's real on-disk lab.conf (verbatim: comments/quoting/unmapped options intact).
  // `exists: false` + empty content means the lab has no lab.conf on disk yet; PUT creates it.
  getLabConf: (name: string) => request<LabConfView>("GET", `/labs/${encodeURIComponent(name)}/lab-conf`),
  // Apply an edited lab.conf to a non-deployed lab (rebuilds its topology). 409 if deployed.
  // The submitted text is stored verbatim — a follow-up getLabConf should return it unchanged.
  updateLabConf: (name: string, content: string) =>
    request<LabDetail>("PUT", `/labs/${encodeURIComponent(name)}/lab-conf`, { content }),

  // -- fixed topology layout (the lab's `lab.layout` file) --
  // An empty `nodes` map means the lab has no fixed layout (the graph then auto-lays out).
  getLayout: (name: string) => request<LabLayout>("GET", `/labs/${encodeURIComponent(name)}/layout`),
  saveLayout: (name: string, nodes: Record<string, { x: number; y: number }>) =>
    request<LabLayout>("PUT", `/labs/${encodeURIComponent(name)}/layout`, { version: 1, nodes }),
  deleteLayout: (name: string) => request<Message>("DELETE", `/labs/${encodeURIComponent(name)}/layout`),

  deployLab: (name: string) => request<LabDetail>("POST", `/labs/${encodeURIComponent(name)}/deploy`, {}),
  undeployLab: (name: string) => request<Message>("POST", `/labs/${encodeURIComponent(name)}/undeploy`, {}),
  // Deploy/undeploy a single device (the backend deploy/undeploy accept a machine subset).
  deployDevice: (name: string, machine: string) =>
    request<LabDetail>("POST", `/labs/${encodeURIComponent(name)}/deploy`, { selected_machines: [machine] }),
  undeployDevice: (name: string, machine: string) =>
    request<Message>("POST", `/labs/${encodeURIComponent(name)}/undeploy`, { selected_machines: [machine] }),
  deleteLab: (name: string) => request<Message>("DELETE", `/labs/${encodeURIComponent(name)}`),
  // Rename a lab (its on-disk directory). 409 while the lab is deployed — its name is what
  // Kathara derives container/network names from — or if `newName` is already taken.
  renameLab: (name: string, newName: string) =>
    request<LabDetail>("POST", `/labs/${encodeURIComponent(name)}/rename`, { name: newName }),
  // Download a lab as a .zip of its on-disk directory. Binary response, so it uses the same
  // error-checked raw fetch as fsDownload rather than the JSON `request` wrapper.
  downloadLab: async (name: string) => {
    const res = await fetch(`${API_BASE}/labs/${encodeURIComponent(name)}/download`, { method: "GET" });
    if (!res.ok) {
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const err = data as Partial<ErrorResponse> | null;
      throw new ApiError(
        err?.detail || res.statusText || `HTTP ${res.status}`,
        err?.error_type || `HTTP ${res.status}`,
        res.status,
      );
    }
    return res.blob();
  },

  // -- Lab Configuration tab: the lab's own on-disk directory, browsed/edited directly (real
  // reads/writes on every call — no separate cache, so nothing here can ever drift from disk). --
  getStartupScripts: (labName: string) =>
    request<Record<string, string>>("GET", `/labs/${encodeURIComponent(labName)}/fs/startups`),
  fsListOffline: (labName: string, path: string) =>
    request<FsListResponse>("GET", `/labs/${encodeURIComponent(labName)}/fs/list?path=${encodeURIComponent(path)}`),
  fsReadTextOffline: (labName: string, path: string) =>
    request<FsReadTextResponse>("GET", `/labs/${encodeURIComponent(labName)}/fs/text?path=${encodeURIComponent(path)}`),
  fsWriteTextOffline: (labName: string, path: string, content: string) =>
    request<Message>("PUT", `/labs/${encodeURIComponent(labName)}/fs/text`, { path, content }),
  fsMkdirOffline: (labName: string, path: string) =>
    request<Message>("POST", `/labs/${encodeURIComponent(labName)}/fs/mkdir`, { path }),
  fsMoveOffline: (labName: string, sourcePath: string, destinationPath: string) =>
    request<Message>("POST", `/labs/${encodeURIComponent(labName)}/fs/move`, { sourcePath, destinationPath }),
  fsDeleteOffline: (labName: string, path: string, recursive = false) =>
    request<Message>("DELETE", `/labs/${encodeURIComponent(labName)}/fs`, { path, recursive }),
  fsUploadOffline: async (labName: string, path: string, file: File) => {
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    return requestForm<FsUploadResponse>(`/labs/${encodeURIComponent(labName)}/fs/upload`, form);
  },
  fsDownloadOffline: async (labName: string, path: string) => {
    const res = await fetch(
      `${API_BASE}/labs/${encodeURIComponent(labName)}/fs/download?path=${encodeURIComponent(path)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const err = data as Partial<ErrorResponse> | null;
      throw new ApiError(
        err?.detail || res.statusText || `HTTP ${res.status}`,
        err?.error_type || `HTTP ${res.status}`,
        res.status,
      );
    }
    return res.blob();
  },

  copyFiles: (labName: string, machineName: string, files: Record<string, string>) =>
    request<Message>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/files`,
      { files },
    ),
  fsList: (labName: string, machineName: string, path: string) =>
    request<FsListResponse>(
      "GET",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/list?path=${encodeURIComponent(path)}`,
    ),
  fsReadText: (labName: string, machineName: string, path: string) =>
    request<FsReadTextResponse>(
      "GET",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/text?path=${encodeURIComponent(path)}`,
    ),
  fsWriteText: (labName: string, machineName: string, path: string, content: string) =>
    request<Message>(
      "PUT",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/text`,
      { path, content },
    ),
  fsMkdir: (labName: string, machineName: string, path: string) =>
    request<Message>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/mkdir`,
      { path },
    ),
  fsMove: (labName: string, machineName: string, sourcePath: string, destinationPath: string) =>
    request<Message>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/move`,
      { sourcePath, destinationPath },
    ),
  fsDelete: (labName: string, machineName: string, path: string, recursive = false) =>
    request<Message>(
      "DELETE",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs`,
      { path, recursive },
    ),
  fsUpload: async (labName: string, machineName: string, path: string, file: File) => {
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    return requestForm<FsUploadResponse>(
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/upload`,
      form,
    );
  },
  fsDownload: async (labName: string, machineName: string, path: string) => {
    const res = await fetch(
      `${API_BASE}/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/download?path=${encodeURIComponent(path)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      const err = data as Partial<ErrorResponse> | null;
      throw new ApiError(
        err?.detail || res.statusText || `HTTP ${res.status}`,
        err?.error_type || `HTTP ${res.status}`,
        res.status,
      );
    }
    return res.blob();
  },
  // Live boot-time startup log + finished flag for a running device — poll while a node's info
  // panel is open and startup hasn't finished yet (see TopologyGraph's node-info block).
  getStartupStatus: (labName: string, machineName: string) =>
    request<StartupStatus>(
      "GET",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/startup-status`,
    ),
  execCommand: (labName: string, machineName: string, command: string | string[], wait = false) =>
    request<ExecResult>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/exec`,
      { command, wait },
    ),

  // Shells actually available in a running device (for the live-terminal picker).
  listShells: (labName: string, machineName: string) =>
    request<string[]>(
      "GET",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/shells`,
    ),

  ttyWsUrl: (labName: string, machineName: string, shell = "bash") => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${API_BASE}/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/tty/ws?shell=${encodeURIComponent(shell)}`;
  },

  // stats/stream is a GET endpoint, so (unlike exec/stream) the browser's native EventSource
  // can be used directly against this URL.
  statsStreamUrl: (labName: string) => `${API_BASE}/labs/${encodeURIComponent(labName)}/stats/stream`,

  // -- topology mutations (add/remove device or domain, connect/disconnect interfaces) --
  addMachine: (
    labName: string,
    payload: { name: string; image?: string; bridged?: boolean; interfaces?: { link: string; number: number }[] },
  ) => request<MachineDetail>("POST", `/labs/${encodeURIComponent(labName)}/machines`, payload),
  removeMachine: (labName: string, machineName: string) =>
    request<Message>("DELETE", `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}`),
  // Full replace of a stopped device's option set (schemas/machine.py's MachineUpdate) — rejected
  // with 409 while the lab is deployed.
  updateMachine: (labName: string, machineName: string, payload: MachineUpdatePayload) =>
    request<MachineDetail>(
      "PUT",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}`,
      payload,
    ),
  // connect/disconnect take query params on the backend (no request body) — see routers/machines.py.
  // interfaceNumber is only honored for a stopped device (static lab.conf edit); omit it for a
  // running device so the backend/Kathara auto-assigns the next interface number at runtime.
  connectMachine: (labName: string, machineName: string, link: string, interfaceNumber?: number, macAddress?: string) => {
    const q = new URLSearchParams({ link });
    if (interfaceNumber !== undefined) q.set("interface_number", String(interfaceNumber));
    if (macAddress) q.set("mac_address", macAddress);
    return request<MachineDetail>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/connect?${q.toString()}`,
    );
  },
  disconnectMachine: (labName: string, machineName: string, link: string) =>
    request<Message>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/disconnect?link=${encodeURIComponent(link)}`,
    ),
  addLink: (labName: string, name: string, external: string[] = []) =>
    request<LinkDetail>("POST", `/labs/${encodeURIComponent(labName)}/links`, { name, external }),
  removeLink: (labName: string, linkName: string) =>
    request<Message>("DELETE", `/labs/${encodeURIComponent(labName)}/links/${encodeURIComponent(linkName)}`),
};
