// Typed access to the Electron shell (services/desktop), which injects `window.katharaDesktop`
// via its preload script. Everything here is optional by design: the same build runs in a plain
// browser through Vite's dev server, where `desktop()` returns null
// and every desktop-only affordance is simply not rendered.

/** Menu commands the shell can send. Mirrors MenuAction in services/desktop/src/menu.ts, which
 *  this package cannot import (separate npm package), so the two are kept in sync by hand. */
export type DesktopMenuAction =
  | "lab:new"
  | "lab:import"
  | "lab:browse"
  | "lab:save"
  | "lab:deploy"
  | "lab:undeploy"
  | "lab:reload"
  | "view:settings"
  | "view:toggle-theme"
  | "help:tour";

/** Mirrors PrivilegedActionResult in services/desktop/src/privilegedAction.ts. Duplicated by
 * hand, not imported — this package can't import types from services/desktop's — so keep the two
 * in sync. */
type DesktopSudoFailureReason = "wrong-password" | "not-permitted" | "cancelled" | "timeout" | "error" | "rate-limited";
type DesktopPrivilegedActionResult = { ok: false; reason: DesktopSudoFailureReason; message: string } | { ok: true };

/** Mirrors DockerStatus in services/desktop/src/prereqs.ts. Duplicated by hand for the same
 * reason as DesktopSudoFailureReason above — keep the two in sync. */
export interface DesktopDockerStatus {
  state: "ok" | "stopped" | "missing";
  detail: string;
  remedy?: string;
  docsUrl?: string;
}

export interface DesktopApi {
  isDesktop: true;
  platform: string;
  /** The theme the user picked, or null when the app follows the OS (hooks/useTheme.ts): the
   * shell's own pages (setup, crash) and new windows match it, since they can't read this page's
   * localStorage. */
  setUiTheme(theme: "light" | "dark" | null): Promise<void>;
  /** Window/shell actions behind the app-drawn menu bar (see TitleBar.tsx). */
  getAppInfo(): Promise<{ version: string; platform: string; home: string }>;
  zoom(direction: "in" | "out" | "reset"): Promise<void>;
  toggleFullScreen(): Promise<void>;
  toggleDevTools(): Promise<void>;
  quit(): Promise<void>;
  /** Custom caption buttons TitleBar.tsx draws on Windows/Linux (macOS keeps native traffic
   * lights and never calls these) — except `isWindowFullScreen`, which macOS *does* need: the
   * strip reserves space for those traffic lights, and the system hides them in fullscreen. */
  minimizeWindow(): Promise<void>;
  maximizeWindow(): Promise<void>;
  unmaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  isWindowFullScreen(): Promise<boolean>;
  showBackendLog(): Promise<void>;
  /** Keeps the upload & import limits (keyed as in GET /settings) in the shell's preferences, which
   * passes them to every backend it starts: the backend itself only holds them until it exits. */
  setUploadLimits(limits: { max_files_per_lab?: number; max_bytes_per_file?: number; max_bytes_per_lab?: number }): Promise<void>;
  /** Best-effort trail for a renderer crash ErrorBoundary.tsx caught, appended to the same
   * backend.log "Help -> Show backend log" opens — a packaged app's renderer console isn't
   * normally visible, so this is otherwise a diagnostic dead end. Fire-and-forget. */
  logRendererError(message: string): Promise<void>;
  /** The last `limit` lines of backend.log (default 200, capped at 2000 shell-side) — lets
   * ErrorBoundary's crash fallback show/copy what just happened. */
  getLogTail(limit?: number): Promise<string>;
  /** Writes text to the OS clipboard, so a crash screen's "Copy log" button can share the log
   * without relying on the renderer's own clipboard permissions. */
  copyToClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** The newer release GitHub has, or null if this build is already current. Cheap to call more
   * than once (see updateCheck.ts) — safe to call again after opening an editor unrelated to it. */
  checkForUpdate(): Promise<{ version: string; url: string } | null>;
  /** Re-runs the same `docker info` probe preflight uses, on demand — how
   * DockerStatusContext.tsx notices a stopped daemon coming back (or going down mid-session)
   * without a restart. Cheap to poll: the shell de-dupes concurrent calls and caches briefly. */
  checkDocker(): Promise<DesktopDockerStatus>;
  /** The per-launch pairing token backend.ts generated for the currently running backend, or
   * null between backends (e.g. mid-restart) — see services/api.ts, which attaches it to
   * every request so the backend's require_auth_token dependency accepts them. */
  getAuthToken(): Promise<string | null>;
  /** Carries the notification panel's history (ToastContext.tsx) across a reload the shell
   * itself triggers (retry, labs-dir change, a backend crash restart) — otherwise
   * that in-memory React state is simply gone once the page reloads. `history` should be plain,
   * IPC-serializable data (no functions — drop any `action` callback before calling this).
   * `load` returns whatever was last saved, or `[]` on a fresh app launch. */
  saveNotificationHistory(history: unknown): Promise<void>;
  loadNotificationHistory(): Promise<unknown>;
  /** Checks the user's password, then lets the backend run the next deploy of `labId` with the
   * privileged devices and host mounts its devices ask for right now — the backend refuses such a
   * deploy without it. `password` is required on Linux (fed to `sudo -S`) unless
   * `sudoPasswordRequired` said false; ignored on macOS/Windows, where the OS shows its own
   * native admin-password dialog instead. Never restarts or reloads anything. */
  authorizeDeploy(labId: string, password?: string): Promise<DesktopPrivilegedActionResult>;
  /** False only on Linux where sudo asks this account for no password (NOPASSWD): the deploy
   * prompt then asks for a confirmation instead of a password it couldn't check. */
  sudoPasswordRequired(): Promise<boolean>;
  /** Checks the user's password with no deploy to grant — Settings' host home toggle.
   * `password` is required on Linux, ignored on macOS/Windows (native OS prompt instead). */
  verifyCanElevate(password?: string): Promise<DesktopPrivilegedActionResult>;
  /** Linux only: gives the user back the lab files running devices left owned by root (the
   * folders `reclaimLabFilePaths` lists), running the `chown` with this password (never stored,
   * fed straight to `sudo -S`). */
  reclaimLabsDirOwnership(password: string): Promise<DesktopPrivilegedActionResult>;
  /** The folders `reclaimLabsDirOwnership` would fix: those holding files another account owns,
   * such as the ones running devices write as root into a lab's shared/ folder. Linux only; `[]`
   * elsewhere, or when there is nothing to reclaim. */
  reclaimLabFilePaths(): Promise<string[]>;
  /** Native folder picker for the host side of a device's [volume] bind mount; null when the user
   * cancels. Starts at `current` when that directory still exists. The desktop app is the only
   * place this can be offered — the browser build renders the host path as a plain text input. */
  pickHostDirectory(current?: string): Promise<string | null>;
  revealLab(labId: string): Promise<void>;
  openLabsFolder(): Promise<void>;
  /** File → Open Lab Folder…: the shell picks a folder in its own dialog, opens it as a lab and
   * navigates the window there. The renderer never names the folder — see main.ts's
   * openFolderAsLab. */
  openLabFolder(): Promise<void>;
  /** Open a plain shell in the lab's directory — no `kathara connect`, just `cd` there. */
  openTerminalHere(labId: string): Promise<void>;
  /** Lab storage directory (Settings). See SettingsPage.tsx's "Desktop" panel. */
  getLabsDir(): Promise<string>;
  getDefaultLabsDir(): Promise<string>;
  /** Native folder picker; null when the user cancels. Selection only — apply via setLabsDir. */
  pickLabsDir(): Promise<string | null>;
  /** Resolves true if applied (a restart is now in flight), false if the user cancelled at the
   * deployed-labs prompt. Rejects if the directory isn't usable. */
  setLabsDir(path: string): Promise<boolean>;
  resetLabsDir(): Promise<boolean>;
  /** These subscriptions all return an unsubscribe function. */
  onMenuAction(cb: (action: DesktopMenuAction) => void): () => void;
  onDeepLink(cb: (route: string) => void): () => void;
  onWindowStateChange(cb: (state: { maximized: boolean; fullscreen: boolean }) => void): () => void;
  /** The window is about to close (its close button, Quit, the OS), or the shell is about to load
   * another page in it (the crash page, the backend at a new address): resolve true to let it. The
   * shell waits for the answer — see context/UnsavedChangesContext.tsx. */
  onCloseRequest(handler: () => Promise<boolean>): () => void;
  /** The backend stopped while this page is on screen, and what happened next — parse with
   *  services/backendState.ts's parseBackendState. */
  onBackendState(cb: (notice: unknown) => void): () => void;
  /** Stop whatever backend is left and start the app over (the setup page's "Check again"). */
  retryStartup(): Promise<void>;
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

// Opens an external URL via the desktop shell when available, else a plain new tab — so links
// behave the same in the Electron and browser builds.
export function openLink(url: string): void {
  const shell = desktop();
  if (shell) {
    void shell.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
