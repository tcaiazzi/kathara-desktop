// Typed access to the Electron shell (services/desktop), which injects `window.katharaDesktop`
// via its preload script. Everything here is optional by design: the same build runs in a plain
// browser through Vite's dev server or the nginx reverse proxy, where `desktop()` returns null
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
  | "view:settings";

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
  ): Promise<{ ok: false; reason: string; message: string; restarted: boolean } | { ok: true }>;
  /** Best-effort: if the backend is currently elevated, restart it unprivileged (reloading the
   * window) so it doesn't keep running with more privilege than whatever's deployed right now
   * actually needs. A no-op (no reload) if it wasn't elevated to begin with — call freely after
   * any undeploy, not just ones you know were privileged. `openLab`, if given, is reflected into
   * the post-reload URL so the reload lands back on the lab that was open instead of bare root. */
  dropElevation(openLab?: string): Promise<{ dropped: boolean }>;
  /** Native "Import lab" picker; null when the user cancels. */
  pickLabArchive(): Promise<{ name: string; data: Uint8Array } | null>;
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
