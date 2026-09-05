// Typed access to the Electron shell (services/desktop), which injects `window.katharaDesktop`
// via its preload script. Everything here is optional by design: the same build runs in a plain
// browser through Vite's dev server, where `desktop()` returns null
// and every desktop-only affordance is simply not rendered.

/** Menu commands the shell can send. Mirrors MenuAction in services/desktop/src/menu.ts. */
export type DesktopMenuAction =
  | "lab:new"
  | "lab:import"
  | "lab:browse"
  | "lab:save"
  | "lab:deploy"
  | "lab:undeploy"
  | "lab:reload"
  | "view:settings"
  | "help:tour";

/** Mirrors ElevateFailureReason in services/desktop/src/backend.ts. Duplicated by hand, not
 * imported — this package can't import types from services/desktop's — so keep the two in sync. */
type DesktopElevateFailureReason = "wrong-password" | "not-permitted" | "cancelled" | "timeout" | "error" | "rate-limited";

export interface DesktopApi {
  isDesktop: true;
  platform: string;
  /** Window/shell actions behind the app-drawn menu bar (see TitleBar.tsx). */
  getAppInfo(): Promise<{ version: string; platform: string }>;
  zoom(direction: "in" | "out" | "reset"): Promise<void>;
  toggleFullScreen(): Promise<void>;
  toggleDevTools(): Promise<void>;
  quit(): Promise<void>;
  /** Custom caption buttons TitleBar.tsx draws on Windows/Linux (macOS keeps native traffic
   * lights and never calls these). */
  minimizeWindow(): Promise<void>;
  maximizeWindow(): Promise<void>;
  unmaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  showBackendLog(): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** The newer release GitHub has, or null if this build is already current. Cheap to call more
   * than once (see updateCheck.ts) — safe to call again after opening an editor unrelated to it. */
  checkForUpdate(): Promise<{ version: string; url: string } | null>;
  /** The per-launch pairing token backend.ts generated for the currently running backend, or
   * null between backends (e.g. mid-elevation) — see services/api.ts, which attaches it to
   * every request so the backend's require_auth_token dependency accepts them. */
  getAuthToken(): Promise<string | null>;
  /** Carries the notification panel's history (ToastContext.tsx) across a reload the shell
   * itself triggers (elevation, retry, labs-dir change, a backend crash restart) — otherwise
   * that in-memory React state is simply gone once the page reloads. `history` should be plain,
   * IPC-serializable data (no functions — drop any `action` callback before calling this).
   * `load` returns whatever was last saved, or `[]` on a fresh app launch. */
  saveNotificationHistory(history: unknown): Promise<void>;
  loadNotificationHistory(): Promise<unknown>;
  /** `password` is required on Linux (fed to `sudo -S`); ignored on macOS/Windows, where the OS
   * shows its own native admin-password dialog instead. `resumeLab`, if given, is reflected into
   * the post-reload URL so the SPA can continue that lab's deploy on its own once it's back up.
   * On success the window reloads against the newly-elevated backend, tearing this page down
   * before this call typically resolves — do not rely on a success response, only on a failure
   * one. A failure with `restarted: false` (a wrong password, a dismissed OS dialog — the
   * common ones) left the backend running untouched, so this page is still on a live origin
   * and can show the error and offer a retry in place. `restarted: true` means the backend
   * came back on a new port and the shell is already reloading this page onto it. */
  elevateBackend(
    password?: string,
    resumeLab?: string,
  ): Promise<{ ok: false; reason: DesktopElevateFailureReason; message: string; restarted: boolean } | { ok: true }>;
  /** Best-effort: if the backend is currently elevated, restart it unprivileged (reloading the
   * window) so it doesn't keep running with more privilege than whatever's deployed right now
   * actually needs. A no-op (no reload) if it wasn't elevated to begin with — call freely after
   * any undeploy, not just ones you know were privileged. `openLab`, if given, is reflected into
   * the post-reload URL so the reload lands back on the lab that was open instead of bare root. */
  dropElevation(openLab?: string): Promise<{ dropped: boolean }>;
  /** Verifies the user could elevate, without touching the backend — used for a deploy that only
   * mounts a host volume, which (unlike a privileged device) doesn't need this process itself to
   * be root, only proof the user could authorize it. `password` is required on Linux, ignored on
   * macOS/Windows (native OS prompt instead). Unlike elevateBackend, never restarts the backend
   * and never reloads the window — the result always reflects this call directly. */
  verifyCanElevate(
    password?: string,
  ): Promise<{ ok: false; reason: DesktopElevateFailureReason; message: string } | { ok: true }>;
  /** Native "Import lab" picker; null when the user cancels. */
  pickLabArchive(): Promise<{ name: string; data: Uint8Array } | null>;
  /** Native folder picker for the host side of a device's [volume] bind mount; null when the user
   * cancels. Starts at `current` when that directory still exists. The desktop app is the only
   * place this can be offered — the browser build renders the host path as a plain text input. */
  pickHostDirectory(current?: string): Promise<string | null>;
  saveFile(name: string, data: Uint8Array): Promise<string | null>;
  revealLab(labName: string): Promise<void>;
  openLabsFolder(): Promise<void>;
  openSystemTerminal(labName: string, machine: string): Promise<void>;
  /** Lab storage directory (Settings). See SettingsPage.tsx's "Desktop" panel. */
  getLabsDir(): Promise<string>;
  getDefaultLabsDir(): Promise<string>;
  /** Native folder picker; null when the user cancels. Selection only — apply via setLabsDir. */
  pickLabsDir(): Promise<string | null>;
  /** Resolves true if applied (a restart is now in flight), false if the user cancelled at the
   * deployed-labs prompt. Rejects if the directory isn't usable. */
  setLabsDir(path: string): Promise<boolean>;
  resetLabsDir(): Promise<boolean>;
  /** All three return an unsubscribe function. */
  onMenuAction(cb: (action: DesktopMenuAction) => void): () => void;
  onDeepLink(cb: (route: string) => void): () => void;
  onWindowStateChange(cb: (state: { maximized: boolean }) => void): () => void;
}

declare global {
  interface Window {
    katharaDesktop?: DesktopApi;
  }
}

/** The shell API, or null when running in a browser. */
export function desktop(): DesktopApi | null {
  return typeof window !== "undefined" && window.katharaDesktop ? window.katharaDesktop : null;
}

export function isDesktop(): boolean {
  return desktop() !== null;
}
