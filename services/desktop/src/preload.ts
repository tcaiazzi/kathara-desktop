/**
 * The only channel between the renderer and the shell.
 *
 * The renderer is a sandboxed, context-isolated page loaded over HTTP: it has no Node access,
 * and everything it can ask the shell to do is listed here. Keep this surface small — each
 * entry is attack surface for a page that renders lab content.
 */
import { contextBridge, ipcRenderer } from "electron";

export type MenuAction =
  | "lab:new"
  | "lab:import"
  | "lab:save"
  | "lab:deploy"
  | "lab:undeploy"
  | "lab:reload"
  | "view:settings"
  | "help:tour";

/** Subscribe and return an unsubscribe, so React effects can clean up properly. */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  isDesktop: true as const,
  platform: process.platform,

  // -- status/setup page --
  getStatus: () => ipcRenderer.invoke("status:get"),
  retryStartup: () => ipcRenderer.invoke("status:retry"),
  pickPython: () => ipcRenderer.invoke("status:pick-python"),
  install: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("status:install"),
  showBackendLog: () => ipcRenderer.invoke("shell:show-log"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),

  // Resolves to the newer release GitHub has, or null if the app is already current (or the
  // check failed/hasn't got an answer — see updateCheck.ts). Pull rather than push: the main
  // process starts the fetch at launch and caches it, so this either returns instantly or waits
  // out whatever's left of it — see main.ts's "update:check" handler for why not a push.
  checkForUpdate: (): Promise<{ version: string; url: string } | null> =>
    ipcRenderer.invoke("update:check"),

  // The pairing token backend.ts generated for the currently running backend (or null between
  // backends), so the renderer's api.ts can attach it to every request instead of an arbitrary
  // other localhost process/tab being able to talk to the same backend (see main.ts's
  // "auth:get-token", src/kathara_api/dependencies.py's require_auth_token).
  getAuthToken: (): Promise<string | null> => ipcRenderer.invoke("auth:get-token"),

  // -- privileged-device elevation (see ElevationContext.tsx) --
  /** `password` is required on Linux, ignored on macOS/Windows (native OS prompt instead).
   * `resumeLab`, if given, is reflected into the post-reload URL so the SPA can continue that
   * lab's deploy on its own once it's back up. On success the window reloads against the
   * newly-elevated backend, tearing this page down before this call typically resolves —
   * callers must not rely on a success response. */
  elevateBackend: (
    password?: string,
    resumeLab?: string,
  ): Promise<{ ok: false; reason: string; message: string } | { ok: true }> =>
    ipcRenderer.invoke("elevation:elevate", password, resumeLab),
  /** Best-effort: if the backend is currently elevated, restart it unprivileged (reloading the
   * window against the new instance) so it doesn't keep running with more privilege than
   * whatever's deployed right now actually needs. A no-op (resolves `{ dropped: false }`,
   * no reload) if it wasn't elevated to begin with. `openLab`, if given, is reflected into the
   * post-reload URL so the reload lands back on the lab that was open instead of the bare root. */
  dropElevation: (openLab?: string): Promise<{ dropped: boolean }> =>
    ipcRenderer.invoke("elevation:drop", openLab),

  // -- window / shell actions behind the app-drawn menu bar --
  getAppInfo: (): Promise<{ version: string; platform: string }> =>
    ipcRenderer.invoke("shell:app-info"),
  zoom: (direction: "in" | "out" | "reset") => ipcRenderer.invoke("window:zoom", direction),
  toggleFullScreen: () => ipcRenderer.invoke("window:toggle-full-screen"),
  toggleDevTools: () => ipcRenderer.invoke("window:toggle-dev-tools"),
  quit: () => ipcRenderer.invoke("window:quit"),

  // -- custom caption buttons (TitleBar.tsx, Windows/Linux only) --
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  unmaximizeWindow: () => ipcRenderer.invoke("window:unmaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),

  // -- native filesystem --
  pickLabArchive: (): Promise<{ name: string; data: Uint8Array } | null> =>
    ipcRenderer.invoke("fs:pick-lab-archive"),
  saveFile: (name: string, data: Uint8Array): Promise<string | null> =>
    ipcRenderer.invoke("fs:save", name, data),
  revealLab: (labName: string) => ipcRenderer.invoke("fs:reveal-lab", labName),
  openLabsFolder: () => ipcRenderer.invoke("fs:open-labs-folder"),

  // -- device terminal in the OS's own emulator --
  openSystemTerminal: (labName: string, machine: string) =>
    ipcRenderer.invoke("terminal:open-system", labName, machine),

  // -- lab storage directory (Settings) --
  getLabsDir: (): Promise<string> => ipcRenderer.invoke("labs:get-dir"),
  getDefaultLabsDir: (): Promise<string> => ipcRenderer.invoke("labs:default-dir"),
  pickLabsDir: (): Promise<string | null> => ipcRenderer.invoke("labs:pick-dir"),
  /** Resolves true if applied (a restart is now in flight), false if the user cancelled. */
  setLabsDir: (path: string): Promise<boolean> => ipcRenderer.invoke("labs:set-dir", path),
  resetLabsDir: (): Promise<boolean> => ipcRenderer.invoke("labs:reset-dir"),

  // -- events pushed from the shell --
  onMenuAction: (cb: (action: MenuAction) => void) => subscribe<MenuAction>("menu:action", cb),
  onDeepLink: (cb: (route: string) => void) => subscribe<string>("deeplink", cb),
  onWindowStateChange: (cb: (state: { maximized: boolean }) => void) =>
    subscribe<{ maximized: boolean }>("window:state", cb),
};

export type KatharaDesktopApi = typeof api;

contextBridge.exposeInMainWorld("katharaDesktop", api);
