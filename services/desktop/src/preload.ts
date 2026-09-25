/**
 * The only channel between the renderer and the shell.
 *
 * The renderer is a sandboxed, context-isolated page loaded over HTTP: it has no Node access,
 * and everything it can ask the shell to do is listed here. Keep this surface small — each
 * entry is attack surface for a page that renders lab content.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { ElevateFailureReason, ElevateOutcome } from "./elevateOutcome";
import type { MenuAction } from "./menu";
import type { DockerStatus } from "./prereqs";

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
  showBackendLog: () => ipcRenderer.invoke("shell:show-log"),
  logRendererError: (message: string) => ipcRenderer.invoke("shell:log-renderer-error", message),
  /** The last `limit` lines of backend.log (default 200, capped at 2000) — used by the
   * ErrorBoundary crash fallback to show/copy what just happened, since it has no other view
   * into the log the way setup.html's backend-failed screen already does via `status`. */
  getLogTail: (limit?: number): Promise<string> => ipcRenderer.invoke("shell:get-log-tail", limit),
  /** Writes to the OS clipboard, so a crash screen's "Copy log" button works the same in a
   * packaged build as it does in dev, without leaning on the renderer's own clipboard API. */
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke("shell:copy-text", text),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),

  // Resolves to the newer release GitHub has, or null if the app is already current (or the
  // check failed/hasn't got an answer — see updateCheck.ts). Pull rather than push: the main
  // process starts the fetch at launch and caches it, so this either returns instantly or waits
  // out whatever's left of it — see main.ts's "update:check" handler for why not a push.
  checkForUpdate: (): Promise<{ version: string; url: string } | null> =>
    ipcRenderer.invoke("update:check"),

  // Re-runs the `docker info` probe preflight uses, on demand — how DockerStatusContext.tsx
  // notices a stopped daemon coming back (or going down mid-session) without a restart. Cheap to
  // poll: main.ts's dockerStatus() de-dupes concurrent calls and caches briefly.
  checkDocker: (): Promise<DockerStatus> => ipcRenderer.invoke("docker:check"),

  // The pairing token backend.ts generated for the currently running backend (or null between
  // backends), so the renderer's api.ts can attach it to every request instead of an arbitrary
  // other localhost process/tab being able to talk to the same backend (see main.ts's
  // "auth:get-token", src/kathara_api/dependencies.py's require_auth_token).
  getAuthToken: (): Promise<string | null> => ipcRenderer.invoke("auth:get-token"),

  // -- notification history (ToastContext.tsx) --
  // Carries the notification panel's history across a reload this shell itself triggers
  // (elevation, retry, labs-dir change, a backend crash restart) — see main.ts's
  // carriedNotifications. Opaque payload: the shell doesn't interpret it, just hands it back.
  saveNotificationHistory: (history: unknown): Promise<void> =>
    ipcRenderer.invoke("notifications:save", history),
  loadNotificationHistory: (): Promise<unknown> => ipcRenderer.invoke("notifications:load"),

  // -- privileged-device elevation (see ElevationContext.tsx) --
  /** `password` is required on Linux, ignored on macOS/Windows (native OS prompt instead).
   * `resumeLab`, if given, is reflected into the post-reload URL so the SPA can continue that
   * lab's deploy on its own once it's back up. On success the window reloads against the
   * newly-elevated backend, tearing this page down before this call typically resolves — callers
   * must not rely on a success response, only on a failure one. A failure with `restarted: false`
   * (a wrong password, a dismissed OS dialog — the common ones) left the backend running
   * untouched, so the page is still on a live origin and can show the error and offer a retry in
   * place; `restarted: true` means the backend came back on a new port and the shell is already
   * reloading the page onto it. */
  elevateBackend: (
    password?: string,
    resumeLab?: string,
  ): Promise<ElevateOutcome> =>
    ipcRenderer.invoke("elevation:elevate", password, resumeLab),
  /** Best-effort: if the backend is currently elevated, restart it unprivileged (reloading the
   * window against the new instance) so it doesn't keep running with more privilege than
   * whatever's deployed right now actually needs. A no-op (resolves `{ dropped: false }`,
   * no reload) if it wasn't elevated to begin with — call freely after any undeploy, not just
   * ones you know were privileged. `openLab`, if given, is reflected into the
   * post-reload URL so the reload lands back on the lab that was open instead of the bare root.
   * `needsReclaimPassword: true` (Linux only) means files the elevated session left root-owned
   * need a password to reclaim, collected via ReclaimLabsDirContext.tsx's modal and sent through
   * `reclaimLabsDirOwnership` below — the backend hasn't been touched yet in that case, so the
   * caller must call this again with `skipReclaimCheck: true` once that's resolved one way or
   * another, to actually drop the elevation. */
  dropElevation: (
    openLab?: string,
    skipReclaimCheck?: boolean,
  ): Promise<{ dropped: boolean; needsReclaimPassword?: boolean }> =>
    ipcRenderer.invoke("elevation:drop", openLab, skipReclaimCheck),
  /** Linux companion to a `dropElevation` that came back with `needsReclaimPassword: true`: runs
   * the actual `chown` with this password (fed straight to `sudo -S`, never stored). Shares its
   * rate limit with elevateBackend/verifyCanElevate — see backend.ts's withSudoRateLimit. */
  reclaimLabsDirOwnership: (
    password: string,
  ): Promise<{ ok: false; reason: ElevateFailureReason; message: string } | { ok: true }> =>
    ipcRenderer.invoke("elevation:reclaim-labs-dir", password),
  /** Verifies the user could elevate, without touching the backend — used for a deploy that only
   * mounts a host volume, which (unlike a privileged device) doesn't need this process itself to
   * be root. `password` is required on Linux, ignored on macOS/Windows (native OS prompt
   * instead). Never restarts anything and never reloads the window, unlike elevateBackend. */
  verifyCanElevate: (
    password?: string,
  ): Promise<{ ok: false; reason: ElevateFailureReason; message: string } | { ok: true }> =>
    ipcRenderer.invoke("elevation:verify", password),

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
  isWindowFullScreen: (): Promise<boolean> => ipcRenderer.invoke("window:is-fullscreen"),

  // -- native filesystem --
  /** Folder picker for a device volume's host path. Grants the renderer no filesystem *read*
   * capability of its own: `current` only seeds the dialog's starting directory (its existence
   * check is never reported back), and the path returned is whatever the user themselves picked
   * in an OS-modal dialog. */
  pickHostDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke("fs:pick-host-dir", current),
  revealLab: (labName: string) => ipcRenderer.invoke("fs:reveal-lab", labName),
  openLabsFolder: () => ipcRenderer.invoke("fs:open-labs-folder"),

  // -- device terminal in the lab's directory --
  openTerminalHere: (labName: string) => ipcRenderer.invoke("terminal:open-here", labName),

  // -- lab storage directory (Settings) --
  getLabsDir: (): Promise<string> => ipcRenderer.invoke("labs:get-dir"),
  getDefaultLabsDir: (): Promise<string> => ipcRenderer.invoke("labs:default-dir"),
  pickLabsDir: (): Promise<string | null> => ipcRenderer.invoke("labs:pick-dir"),
  /** Resolves true if applied (a restart is now in flight), false if the user cancelled. */
  setLabsDir: (path: string): Promise<boolean> => ipcRenderer.invoke("labs:set-dir", path),
  resetLabsDir: (): Promise<boolean> => ipcRenderer.invoke("labs:reset-dir"),
  /** Dismisses the setup page's first-run labs-directory prompt (the "keep the default" case —
   * see promptForLabsDir() in main.ts); a no-op if that prompt isn't currently showing. */
  confirmLabsDir: (): Promise<void> => ipcRenderer.invoke("labs:confirm-dir"),

  // -- events pushed from the shell --
  onMenuAction: (cb: (action: MenuAction) => void) => subscribe<MenuAction>("menu:action", cb),
  onDeepLink: (cb: (route: string) => void) => subscribe<string>("deeplink", cb),
  onWindowStateChange: (cb: (state: { maximized: boolean; fullscreen: boolean }) => void) =>
    subscribe<{ maximized: boolean; fullscreen: boolean }>("window:state", cb),
};

// No exported type for `api` on purpose: the renderer is a separate npm package and cannot import
// from here, so `services/frontend/src/desktop/bridge.ts` declares the same shape by hand. An
// export here would have no possible consumer.

contextBridge.exposeInMainWorld("katharaDesktop", api);
