import type {
  ErrorResponse,
  ExampleLab,
  GalleryCatalog,
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
  MachineOptionsPayload,
  MachineUpdatePayload,
  Message,
  SettingsUpdate,
  SettingsView,
  StartupStatus,
  SystemInfo,
} from "./types";
import { desktop } from "../desktop/bridge";

// The desktop app's backend requires every request to carry the pairing token backend.ts
// generated for this launch (src/kathara_api/dependencies.py's require_auth_token) — resolved
// once per page load (null outside Electron, or if desktop() is null) and cached here rather
// than round-tripping the IPC bridge on every call. A plain module-scope variable, not just the
// promise, so the synchronous ttyWsUrl/statsStreamUrl below (native WebSocket/EventSource can't
// await) can still read it once it settles — well before either is ever called in practice,
// since both need a lab already loaded first.
let cachedAuthToken: string | null = null;
const authTokenReady: Promise<void> = (async () => {
  const shell = desktop();
  cachedAuthToken = shell ? await shell.getAuthToken() : null;
})();

function authHeaders(): Record<string, string> {
  return cachedAuthToken ? { Authorization: `Bearer ${cachedAuthToken}` } : {};
}

// All backend routes live under /api. In dev this is proxied to the backend by Vite
// (vite.config.ts); in the desktop app the backend serves this SPA itself (spa.py) — so either
// way this is a same-origin, relative call, with no base URL to configure.
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

// The backend always sends `detail` as a string (see errors.py's RequestValidationError
// handler). This is a defensive fallback only, for a response that bypasses that — e.g. a body
// a proxy/gateway generated itself — so a shape change degrades to a readable joined message
// instead of `String(anArray)` -> "[object Object]".
function coerceDetail(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => (entry && typeof entry === "object" && "msg" in entry ? String((entry as { msg: unknown }).msg) : null))
      .filter((msg): msg is string => !!msg);
    if (messages.length) return messages.join("; ");
  }
  return undefined;
}

// Parse an error response body and throw the ApiError it describes — the one place that maps a
// non-2xx response to this client's error type, shared by the JSON helpers and by the blob
// downloads (which can't use those: a binary success body must not be read as text).
async function throwApiError(res: Response): Promise<never> {
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
    coerceDetail(err?.detail) || res.statusText || `HTTP ${res.status}`,
    err?.error_type || `HTTP ${res.status}`,
    res.status,
  );
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  if (!res.ok) await throwApiError(res);
  const text = await res.text();
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  await authTokenReady;
  const init: RequestInit = { method, headers: { ...authHeaders() } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return parseJsonResponse<T>(await fetch(`${API_BASE}${path}`, init));
}

// Multipart POST (file upload). Unlike request<T>, this must NOT set Content-Type: the browser
// sets multipart/form-data plus the boundary itself from the FormData body.
async function requestForm<T>(path: string, form: FormData): Promise<T> {
  await authTokenReady;
  return parseJsonResponse<T>(
    await fetch(`${API_BASE}${path}`, { method: "POST", headers: authHeaders(), body: form }),
  );
}

// GET a binary body (a .zip export, a file download), surfacing a non-2xx as an ApiError the same
// way the JSON paths do.
async function requestBlob(path: string): Promise<Blob> {
  await authTokenReady;
  const res = await fetch(`${API_BASE}${path}`, { method: "GET", headers: authHeaders() });
  if (!res.ok) await throwApiError(res);
  return res.blob();
}

export const api = {
  health: () => request<{ status: string }>("GET", "/health"),
  systemInfo: () => request<SystemInfo>("GET", "/system"),
  getSettings: () => request<SettingsView>("GET", "/settings"),
  updateSettings: (payload: SettingsUpdate) => request<SettingsView>("PUT", "/settings", payload),
  // Force-undeploys every lab kathara-desktop has deployed, not just the currently open one — scopes
  // to labs this backend manages, unlike the Kathara CLI's own `kathara wipe`.
  wipeAll: () => request<Message>("POST", "/system/wipe", {}),
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
  // Bundled example network scenarios (backend package data — src/kathara_api/examples/) shown
  // on the welcome screen's "start from an example" list. An older backend without this route
  // answers 404 — callers should treat a failed list as "no examples section" rather than an
  // error to surface.
  listExampleLabs: () => request<ExampleLab[]>("GET", "/labs/examples"),
  createExampleLab: (id: string, name?: string) =>
    request<LabImportResult>("POST", "/labs/examples", name ? { id, name } : { id }),

  // The upstream Kathara-Labs gallery (backend services/lab_gallery.py) shown in the "Browse
  // Kathara Labs" modal. Cached server-side; `refresh` bypasses that cache (the modal's Refresh
  // button).
  listGalleryLabs: (refresh?: boolean) =>
    request<GalleryCatalog>("GET", refresh ? "/labs/gallery?refresh=true" : "/labs/gallery"),
  createGalleryLab: (id: string, name?: string) =>
    request<LabImportResult>("POST", "/labs/gallery", name ? { id, name } : { id }),

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
  downloadLab: (name: string) => requestBlob(`/labs/${encodeURIComponent(name)}/download`),

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
    request<Message>("POST", `/labs/${encodeURIComponent(labName)}/fs/move`, {
      source_path: sourcePath,
      destination_path: destinationPath,
    }),
  fsCopyOffline: (labName: string, sourcePath: string, destinationPath: string) =>
    request<Message>("POST", `/labs/${encodeURIComponent(labName)}/fs/copy`, {
      source_path: sourcePath,
      destination_path: destinationPath,
    }),
  fsDeleteOffline: (labName: string, path: string, recursive = false) =>
    request<Message>("DELETE", `/labs/${encodeURIComponent(labName)}/fs`, { path, recursive }),
  fsUploadOffline: async (labName: string, path: string, file: File) => {
    const form = new FormData();
    form.append("path", path);
    form.append("file", file);
    return requestForm<FsUploadResponse>(`/labs/${encodeURIComponent(labName)}/fs/upload`, form);
  },
  fsDownloadOffline: (labName: string, path: string) =>
    requestBlob(`/labs/${encodeURIComponent(labName)}/fs/download?path=${encodeURIComponent(path)}`),

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
      { source_path: sourcePath, destination_path: destinationPath },
    ),
  fsCopy: (labName: string, machineName: string, sourcePath: string, destinationPath: string) =>
    request<Message>(
      "POST",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/copy`,
      { source_path: sourcePath, destination_path: destinationPath },
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
  fsDownload: (labName: string, machineName: string, path: string) =>
    requestBlob(
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/fs/download?path=${encodeURIComponent(path)}`,
    ),
  // Live boot-time startup log + finished flag for a running device — poll while a node's info
  // panel is open and startup hasn't finished yet (see TopologyGraph's node-info block).
  getStartupStatus: (labName: string, machineName: string) =>
    request<StartupStatus>(
      "GET",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/startup-status`,
    ),

  // Shells actually available in a running device (for the live-terminal picker).
  listShells: (labName: string, machineName: string) =>
    request<string[]>(
      "GET",
      `/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/shells`,
    ),

  // A native WebSocket/EventSource can't set an Authorization header, so the pairing token (when
  // one is configured — see authHeaders above) travels as `?token=` instead, matching what
  // require_auth_token and the /tty/ws handler both accept.
  ttyWsUrl: (labName: string, machineName: string, shell = "bash") => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const tokenParam = cachedAuthToken ? `&token=${encodeURIComponent(cachedAuthToken)}` : "";
    return `${proto}//${window.location.host}${API_BASE}/labs/${encodeURIComponent(labName)}/machines/${encodeURIComponent(machineName)}/tty/ws?shell=${encodeURIComponent(shell)}${tokenParam}`;
  },

  // stats/stream is a GET endpoint, so (unlike exec/stream) the browser's native EventSource
  // can be used directly against this URL.
  statsStreamUrl: (labName: string) => {
    const tokenParam = cachedAuthToken ? `?token=${encodeURIComponent(cachedAuthToken)}` : "";
    return `${API_BASE}/labs/${encodeURIComponent(labName)}/stats/stream${tokenParam}`;
  },

  // -- topology mutations (add/remove device or domain, connect/disconnect interfaces) --
  addMachine: (
    labName: string,
    payload: Partial<MachineOptionsPayload> & { name: string; interfaces?: { link: string; number: number }[] },
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
