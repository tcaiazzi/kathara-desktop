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
  | "view:settings";

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
  showBackendLog: () => ipcRenderer.invoke("shell:show-log"),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),

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
