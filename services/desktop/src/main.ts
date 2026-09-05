/**
 * Electron main process: supervises the Kathara REST API and renders its UI.
 *
 * Startup sequence — the window appears first and reports progress, so a slow or failing
 * prerequisite check is never a blank screen:
 *   1. show the status page
 *   2. preflight (Docker, Python, kathara-api, Kathara, uvicorn, bundled UI)
 *   3. start the backend on a free loopback port, serving the bundled SPA
 *   4. load http://127.0.0.1:<port>/
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

import {
  backendLogPath,
  backendToken,
  backendUrl,
  forceKillOrphan,
  hasForeignOwnedFiles,
  onBackendExit,
  onOrphanedBackend,
  reclaimLabsDirOwnershipWithPassword,
  reclaimLabsDirOwnershipWithPrompt,
  startBackend,
  startBackendElevatedLinux,
  startBackendElevatedNative,
  stopBackend,
  verifyCanElevate,
  toElevateOutcome,
  type ElevateOutcome,
} from "./backend";
import { deepLinkFromArgv, handleDeepLink, registerProtocol } from "./deeplink";
import { ensurePathEnv } from "./env";
import { runAutoInstall, type InstallProgress, type InstallStep } from "./install";
import {
  openLabsDir,
  openSystemTerminal,
  pickHostDirectory,
  pickLabArchive,
  pickLabsDirectory,
  pickPythonInterpreter,
  revealPath,
  saveFile,
} from "./integrations";
import { log, tailLog } from "./logger";
import { buildMenu } from "./menu";
import { defaultLabsDir, labsDir, resolveStaticDir } from "./paths";
import { isPlainAbsolutePath } from "./safety";
import { readPrefs, writePrefs } from "./prefs";
import { runPreflight, type Check, type Preflight, type PreflightProgress } from "./prereqs";
import { checkForUpdate } from "./updateCheck";
import {
  createMainWindow,
  installEditContextMenu,
  installNavigationPolicy,
  showSetupPage,
  showSplashPage,
} from "./windows";

// Chromium's trackpad swipe-to-navigate (macOS two-finger swipe) drives the same
// history.back()/forward() as the mouse side buttons blocked in windows.ts and
// services/frontend/src/main.tsx, but through a separate code path those don't reach. Must be
// set before the app is ready, so it goes right after the imports, before any other app.* call.
app.commandLine.appendSwitch("disable-features", "OverscrollHistoryNavigation");

// Electron derives userData's folder name from app.name, which defaults to package.json's
// productName ("Kathara Desktop") — a folder with a space and mixed case. Override it to this
// repo's own lowercase-hyphenated convention instead, using a fresh path built from the
// platform-correct base ('appData': %APPDATA% / ~/Library/Application Support / ~/.config)
// so this stays correct on every platform, not just Linux.
//
// Deliberately app.setPath('userData', ...) rather than app.setName('kathara-desktop'): setName
// would also rename the macOS menu-bar app label and Dock name, which is not what was asked.
// Must run before requestSingleInstanceLock() below — the single-instance lock file is
// itself written under userData, so calling this any later would leave it in the old folder.
// Existing data already at the old path (labs, preferences.json) is left there untouched,
// not moved — same "leave old data behind, don't migrate silently" choice already made for
// the labs-directory setting itself.
app.setPath("userData", path.join(app.getPath("appData"), "kathara-desktop"));

// Bounds every ad-hoc query this file makes against an already-healthy backend (list labs, look
// up a lab's directory) — deliberately more generous than backend.ts's SHUTDOWN_HTTP_TIMEOUT_MS,
// since these can enumerate real state rather than hit one fixed endpoint, but still bounded: an
// unresponsive-but-alive backend (a stuck Kathara/Docker call on its single worker) must not be
// able to hang app quit, or leave a renderer click (Reveal in file manager, Open in terminal)
// spinning forever with nothing to show for it.
const BACKEND_QUERY_TIMEOUT_MS = 5_000;

/** Every ad-hoc fetch this file makes to its own backend must carry the pairing token
 * (backend.ts generates one per launch — see require_auth_token in src/kathara_api/
 * dependencies.py) or get a 401. `{}` when there's no running backend to have gotten one from
 * (backendToken() is then null anyway), same as an unpaired request would. */
function authHeaders(): HeadersInit {
  const token = backendToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Ordered boot phases. KEEP IN SYNC with the PHASE_COPY table in setup.html. */
export type BootPhase =
  | "environment"     // querying the login shell for PATH
  | "frontend"        // locating (and, under AppImage, copying) the bundled SPA
  | "docker"          // `docker info` round trip to the daemon
  | "python"          // interpreter discovery + the import probe
  | "backend"         // spawning uvicorn and waiting for /api/health
  | "install-prepare"
  | "install-pip"
  | "install-wheel";

type Status =
  | {
      state: "starting";
      phase: BootPhase;
      /** Free-text fallback; the page prefers its own copy for `phase`. */
      message: string;
      /** Epoch ms this attempt began, so the page can render elapsed time between polls. */
      startedAt: number;
      /** Checks decided so far this attempt, in display order. Grows as preflight proceeds. */
      checks: Check[];
      /** A live tail of subprocess output — install phases only. */
      output?: string;
      /** True until the first backend has ever come up healthy on this machine. Shapes the
       * setup page's first-run copy ("Welcome to…" vs. "Starting…"). */
      firstRun: boolean;
    }
  | { state: "prereq-failed"; checks: Check[]; notice?: string }
  | { state: "backend-failed"; checks: Check[]; error: string; logTail: string }
  | { state: "ready" };

let win: BrowserWindow | null = null;
let status: Status = { state: "starting", phase: "environment", message: "Starting…", startedAt: Date.now(), checks: [], firstRun: isFirstRun() };
/** A deep link that arrived before the UI was ready, replayed once it is. */
let pendingDeepLink: string | null = null;
/** The most recent preflight result, so status:install knows which system Python to use. */
let lastPreflight: Preflight | null = null;
/**
 * Directories the *user* actually chose in the native folder dialog during this run, realpath'd.
 * `labs:set-dir` will only apply one of these (or the app's own default), because the renderer is
 * not a trusted source for that path: the backend restarts with its entire filesystem API rooted
 * wherever it points, so an unvalidated value there is an arbitrary-filesystem-root primitive for
 * anything running in the page. Session-scoped on purpose — it is a record of what was offered,
 * not a persisted allowlist.
 */
const pickedLabsDirs = new Set<string>();

function setStatus(next: Status): void {
  status = next;
}

/** No backend has ever come up healthy on this machine — see backend.ts's rememberPort, which is
 * the only writer of launchCount. Read once per boot attempt (startup() below), not live, so an
 * install completing mid-attempt doesn't flip the copy out from under the user half-way through. */
function isFirstRun(): boolean {
  return !(readPrefs().launchCount ?? 0);
}

let bootStartedAt = Date.now();
let bootChecks: Check[] = [];

/**
 * The renderer's notification history (ToastContext.tsx), carried across any reload this shell
 * itself triggers (elevation:elevate/elevation:drop, status:retry, labs:set-dir, an unexpected
 * backend exit) — every one of those calls win.loadURL/loadFile, which wipes the renderer's own
 * in-memory React state. Held here in memory only, not on disk: it only has to survive *this*
 * reload, not a real app relaunch (ToastContext's own history is scoped to "since app startup").
 * Opaque to this process by design — it's just handed back verbatim to whichever page asks next;
 * see notifications:save/notifications:load below and ToastContext.tsx's load-on-mount/save-on-
 * change effects.
 */
let carriedNotifications: unknown[] = [];

/** Sets a "starting" status, carrying forward the checks/output accumulated so far this attempt
 * unless the caller supplies fresh ones. The one place that assembles the "starting" payload, so
 * every call site only has to say what changed. */
function setPhase(phase: BootPhase, message: string, extra?: { checks?: Check[]; output?: string }): void {
  if (extra?.checks) bootChecks = extra.checks;
  setStatus({
    state: "starting",
    phase,
    message,
    startedAt: bootStartedAt,
    checks: bootChecks,
    output: extra?.output,
    firstRun: isFirstRun(),
  });
}

/**
 * True while the main window is showing (or loading) setup.html.
 *
 * Tracked rather than derived from `win.webContents.getURL()`: during an in-flight load that
 * still reports the *previous* URL (or ""), so it would guess wrong in exactly the case that
 * matters — deciding whether a failure needs to navigate back to the setup page. Cleared from
 * did-navigate below, so the elevation handlers' own loadURL calls keep it correct without
 * needing edits inside their control flow.
 */
let onSetupPage = false;

/**
 * Show the setup page, unless it is already the page on screen.
 *
 * The guard is what makes this safe to call from every failure path, including the cold-start
 * one where setup.html is already loaded and mid-poll: reloading it there would restart its
 * polling loop and redraw from scratch for no reason.
 */
function showSetup(target: BrowserWindow): void {
  if (onSetupPage) return;
  onSetupPage = true;
  showSetupPage(target);
}

/** Messages for runPreflight's two incremental phases — see prereqs.ts's PreflightProgress. */
const PREFLIGHT_PHASE_MESSAGE: Record<"docker" | "python", string> = {
  docker: "Contacting Docker…",
  python: "Looking for Python and the Kathara packages…",
};

const INSTALL_PHASE: Record<InstallStep, BootPhase> = {
  prepare: "install-prepare",
  pip: "install-pip",
  wheel: "install-wheel",
};

const INSTALL_MESSAGE: Record<InstallStep, string> = {
  prepare: "Preparing the app's bundled Python environment…",
  pip: "Updating pip…",
  wheel: "Installing Kathara and the Kathara API into the app's bundled Python — this can take several minutes…",
};

/**
 * The checks a bundled-wheel install can actually fix (install.ts). A failure outside this set —
 * Python itself, the bundled UI — is something the app deliberately doesn't install its way out
 * of, and is the difference between "install this automatically" and "ask the user".
 * KEEP IN SYNC with the `installable` list in setup.html, which decides whether the button that
 * runs the same install by hand is offered.
 *
 * Docker is deliberately *not* in this set, but is still special-cased out of the gate below
 * rather than folded into it: unlike these four, the app can never install Docker for the user,
 * so a missing/stopped Docker daemon must never be treated as "installable" — only as a check
 * that's allowed to keep failing while the install proceeds anyway (see startup()).
 */
const INSTALLABLE: ReadonlySet<Check["id"]> = new Set<Check["id"]>([
  "kathara_api",
  "kathara",
  "uvicorn",
  "dependencies",
]);

/** One automatic install per app run. A second attempt would re-download exactly what just
 * failed; past the first, "Install missing packages" on the setup page is the retry. */
let autoInstallAttempted = false;

const INSTALL_TAIL_LINES = 12;

/**
 * pip draws its progress bars with a bare "\r" between redraws, not "\n" — appending each raw
 * chunk would fill the tail with dozens of half-drawn bars instead of the handful of real lines
 * that matter. Splitting on both keeps only the latest state of each redrawn line.
 */
function appendInstallTail(tail: string[], chunk: string): string[] {
  const lines = chunk
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
  return [...tail, ...lines].slice(-INSTALL_TAIL_LINES);
}

/**
 * Runs the bundled-wheel install (install.ts), threading its progress into the status the setup
 * page polls: the phase ladder plus a live tail of pip's own output, since the wheel step can run
 * for minutes on a cold PyPI download.
 *
 * Shared by the two ways an install starts — startup()'s automatic attempt and the setup page's
 * button — so both report identically and both leave the caller to decide what happens next.
 */
async function runInstall(systemPython: string): Promise<{ ok: boolean; error?: string }> {
  bootStartedAt = Date.now();
  // Seeds the checks setPhase carries forward with the full list from the preflight that led
  // here — preflight's own onProgress only ever accumulated up to the docker+python checks, not
  // the later kathara_api/kathara/uvicorn/dependencies/frontend ones, and the page still wants to
  // show the whole list (what's being fixed) alongside the install output.
  bootChecks = lastPreflight?.checks ?? [];
  let tail: string[] = [];
  const result = await runAutoInstall(systemPython, ({ step, line }: InstallProgress) => {
    if (line) tail = appendInstallTail(tail, line);
    setPhase(INSTALL_PHASE[step], INSTALL_MESSAGE[step], { output: tail.join("\n") });
  });
  if (!result.ok) log(`install failed: ${result.error}`);
  // No writePrefs of the interpreter that was just installed into: prereqs.ts's
  // pythonCandidates() already probes both possible targets (the bundled interpreter and the
  // private venv), so the next preflight finds whichever one this filled in — without an
  // automatic action quietly overwriting an interpreter the user chose by hand.
  return result;
}

/** Set for the duration of a `runStartup()` call, so a second trigger arriving while one is
 * already in flight (e.g. two rapid "Check again" clicks, or a retry racing an elevation) waits
 * for and reuses it instead of calling `startBackend()` again — `startBackend()`'s own "already
 * running" check only starts protecting once a *previous* start's health check has finished
 * (backend.ts's `handle` is assigned no earlier than that), so two concurrent callers would
 * otherwise both pass it and each spawn a backend, with the second's `trackChild()` silently
 * overwriting the module-level reference to the first — which then outlives app quit untracked. */
let startupInFlight: Promise<void> | null = null;

/**
 * Run preflight, start the backend, and load the UI. Safe to call again on "Retry".
 *
 * `resumePath`, if given, is appended to the loaded URL (e.g. `/workspace/<lab>` from
 * elevation:drop below) so a backend restart triggered *from inside* an already-open lab lands
 * back there instead of the bare root every other caller of startup() wants.
 *
 * Serializes concurrent callers (see `startupInFlight`) — the actual work is in `runStartup`,
 * called directly (not through this gate) by the auto-install retry below, which is a sequential
 * continuation of the same attempt, not a second concurrent one.
 */
async function startup(resumePath?: string): Promise<void> {
  if (startupInFlight) return startupInFlight;
  startupInFlight = runStartup(resumePath).finally(() => {
    startupInFlight = null;
  });
  return startupInFlight;
}

async function runStartup(resumePath?: string): Promise<void> {
  if (!win) return;
  bootStartedAt = Date.now();
  bootChecks = [];

  // Before anything that shells out (Docker/Python checks, terminal integration): a
  // double-clicked GUI app doesn't inherit the Terminal's PATH, so Homebrew/Docker Desktop
  // binaries would otherwise be invisible even though they work fine from a shell. Awaited here,
  // not at whenReady(), so the window is already up reporting this instead of showing nothing.
  setPhase("environment", "Reading your shell environment…");
  await ensurePathEnv();

  setPhase("frontend", "Preparing the interface…");
  const staticDir = resolveStaticDir();

  const preflight = await runPreflight(staticDir !== null, (p: PreflightProgress) =>
    setPhase(p.phase, PREFLIGHT_PHASE_MESSAGE[p.phase], { checks: p.checks }));
  lastPreflight = preflight;
  if (!preflight.ok || !preflight.python || !staticDir) {
    // Nothing is missing except packages this app ships a wheel for, so install them instead of
    // parking on the setup page waiting for a click. That click used to be the only thing between
    // a fresh machine and a working app, and — now that the packages live inside the bundled
    // interpreter, which an app update replaces wholesale (install.ts) — it would also come back
    // after every update, asking the user to authorise the one thing the app can do by itself.
    //
    // Docker is excluded from this check on purpose: installing the bundled wheel is a plain `pip
    // install` into the app's own Python and needs nothing from Docker, so a missing or stopped
    // Docker daemon must not block it — a user on a fresh machine with neither Docker nor the
    // Python packages yet should still get the packages installed automatically, and land on a
    // failure screen naming only the one thing the app truly can't do for them.
    const nonDocker = preflight.checks.filter((c) => c.id !== "docker");
    if (
      app.isPackaged &&
      staticDir &&
      preflight.systemPython &&
      !autoInstallAttempted &&
      nonDocker.some((c) => !c.ok) &&
      nonDocker.every((c) => c.ok || INSTALLABLE.has(c.id))
    ) {
      autoInstallAttempted = true;
      log("preflight: only installable packages (Docker aside) are missing — installing them automatically");
      // At cold start the splash is still on screen, and this install owns the next few minutes:
      // the setup page is where its ladder and live pip output are visible.
      showSetup(win);
      const result = await runInstall(preflight.systemPython);
      if (result.ok) {
        // Guarded by autoInstallAttempted, so this recursion is one level deep at most. Calls
        // runStartup directly, not startup(): this is a sequential continuation of the attempt
        // already in flight, not a second concurrent one, and startup() would just hand back this
        // same not-yet-settled call's own promise.
        await runStartup(resumePath);
        return;
      }
      setStatus({
        state: "prereq-failed",
        checks: preflight.checks,
        notice: `Kathara Desktop tried to install the missing packages by itself and couldn't: ${result.error ?? "unknown error"}. Open the log for the full output, then try again.`,
      });
      return;
    }
    setStatus({ state: "prereq-failed", checks: preflight.checks });
    // Not just for the cold start (where this page is already up): status:retry, setLabsDir and
    // elevation:drop all reach here after stopBackend(), so without this the window would sit on
    // a dead http://127.0.0.1:<old port> origin with no way back.
    showSetup(win);
    return;
  }

  // The app's own environment works but isn't the backend this build ships — an update replaced
  // the bundled interpreter and left the previous release's private venv standing (see
  // Preflight.stale). Reinstall once, then start; if the install fails, start anyway rather than
  // stranding the user on the setup page over a mismatch they can't act on.
  if (app.isPackaged && preflight.stale && preflight.systemPython && !autoInstallAttempted) {
    autoInstallAttempted = true;
    log("preflight: the environment found predates this build — installing the backend it ships");
    showSetup(win);
    const result = await runInstall(preflight.systemPython);
    if (result.ok) {
      // Same reasoning as the auto-install branch above: a sequential continuation, not a new
      // concurrent caller, so this bypasses the startup() gate on purpose.
      await runStartup(resumePath);
      return;
    }
    log("continuing with the environment already present");
  }

  setPhase("backend", "Starting the local Kathara API…", { checks: preflight.checks });
  try {
    const handle = await startBackend(preflight.python, staticDir);
    setStatus({ state: "ready" });
    await win.loadURL(resumePath ? `${handle.baseUrl}${resumePath}` : handle.baseUrl);
    if (pendingDeepLink) {
      handleDeepLink(win, pendingDeepLink);
      pendingDeepLink = null;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`startup failed: ${error}`);
    setStatus({ state: "backend-failed", checks: preflight.checks, error, logTail: tailLog() });
    showSetup(win);
  }
}

function registerIpc(): void {
  ipcMain.handle("status:get", () => status);

  // See carriedNotifications above. `save` is called on every history change (cheap — this is
  // just a variable assignment), so whatever reload happens next always has the latest snapshot,
  // without either side needing to predict exactly when a reload is about to happen.
  ipcMain.handle("notifications:save", (_e, history: unknown) => {
    carriedNotifications = Array.isArray(history) ? history : [];
  });
  ipcMain.handle("notifications:load", () => carriedNotifications);

  ipcMain.handle("status:retry", async () => {
    if (startupInFlight) {
      // A previous "Check again" (or any other startup trigger) hasn't finished yet. Join it
      // instead of calling stopBackend() here, which — unlike startup() itself — has no gate of
      // its own and would race the in-flight attempt's own startBackend(), quite possibly killing
      // the very process it just spawned.
      await startupInFlight;
      return;
    }
    await stopBackend();
    await startup();
  });

  // Driven from the renderer's elevation prompt (see ElevationContext.tsx), triggered when a
  // deploy needs a privileged device. `password` is required on Linux (fed to `sudo -S`) and
  // ignored elsewhere, where the OS shows its own native admin-password dialog instead.
  // `resumeLab`, if given, is the lab the caller was trying to deploy — reflected into the
  // reload URL below so the SPA can continue that deploy on its own once it's back up, instead
  // of leaving the user to notice the reload finished and click Deploy again.
  //
  // On success this mirrors startup(): the SPA is reloaded against the new (now-elevated)
  // backend's origin, which tears down the calling renderer mid-flight — the invoking IPC call
  // typically never observes this resolution, only a failure one. That's expected; the renderer
  // must not depend on a success response here.
  ipcMain.handle("elevation:elevate", async (_e, password?: string, resumeLab?: string): Promise<ElevateOutcome> => {
    const python = lastPreflight?.python;
    const staticDir = resolveStaticDir();
    if (!python || !staticDir) {
      return { ok: false, reason: "error", message: "backend is not ready to be restarted", restarted: false };
    }
    log("elevation requested");
    const result =
      process.platform === "linux"
        ? await startBackendElevatedLinux(python, staticDir, password ?? "")
        : await startBackendElevatedNative(python, staticDir);

    if (!result.ok) {
      log(`elevation failed: ${result.reason} — ${result.message}`);
      // The common failures (a mistyped password, a dismissed OS dialog) never get as far as
      // stopping anything, so the calling page is still on a live origin: leave it alone and
      // let its elevation prompt show the error and offer a retry in place.
      //
      // A failure that *did* restart the backend is the exception. It came back on a fresh
      // port, so that page is now talking to a dead one and has to be moved — without
      // `resumeDeploy`, since the deploy must not silently retry after a failed elevation.
      const recovered = backendUrl();
      if (result.restarted && win && recovered) {
        setStatus({ state: "ready" });
        const url = new URL(recovered);
        if (resumeLab) url.pathname = `/workspace/${encodeURIComponent(resumeLab)}`;
        await win.loadURL(url.toString());
      }
      return toElevateOutcome(result);
    }

    setStatus({ state: "ready" });
    if (win) {
      const url = new URL(result.handle.baseUrl);
      if (resumeLab) {
        url.pathname = `/workspace/${encodeURIComponent(resumeLab)}`;
        url.searchParams.set("resumeDeploy", "1");
      }
      await win.loadURL(url.toString());
    }
    return toElevateOutcome(result);
  });

  // Driven from the same elevation prompt, but for a deploy that only mounts a host volume — a
  // volume doesn't need this *process* to be root (unlike a privileged device), only proof the
  // user could authorize it. Unlike elevation:elevate above, this never touches the backend: no
  // restart, no new port, no reload — the caller just gets ok/not-ok back synchronously.
  ipcMain.handle(
    "elevation:verify",
    (_e, password?: string): ReturnType<typeof verifyCanElevate> => verifyCanElevate(password),
  );

  // Driven after a successful undeploy (see useLabLifecycleActions.ts): least-privilege — an
  // elevated backend shouldn't keep running as root once nothing it's doing needs that. There's
  // no in-place "un-sudo" for a running process, so this is the same stop-and-restart dance as
  // elevating, just back to the plain unprivileged backend; reuses startup() (preflight +
  // startBackend + loadURL + status) rather than duplicating it, same as status:retry above. A
  // cheap no-op — no restart, no reload — when the backend isn't currently elevated at all,
  // which is the common case (most undeploys aren't for a privileged-device lab).
  ipcMain.handle(
    "elevation:drop",
    async (
      _e,
      openLab?: string,
      skipReclaimCheck?: boolean,
    ): Promise<{ dropped: boolean; needsReclaimPassword?: boolean }> => {
      const baseUrl = backendUrl();
      if (!baseUrl) return { dropped: false };
      try {
        const info = await fetch(`${baseUrl}/api/system`, { headers: authHeaders() }).then((r) => r.json());
        if (!info.is_admin) return { dropped: false };
      } catch {
        return { dropped: false };
      }

      // Checked (and asked about, if needed) *before* stopBackend(): this page — and, on Linux,
      // its own password modal — is still the live one the user can see a prompt on; after the
      // reload below there is no page left to show one on. `skipReclaimCheck` is set on the
      // second call the renderer makes once it has already resolved this one way or another (see
      // bridge.ts's dropElevation and ReclaimLabsDirContext.tsx).
      const labsPath = labsDir();
      if (!skipReclaimCheck && hasForeignOwnedFiles(labsPath)) {
        if (process.platform === "linux") {
          // No native dialog can collect a password on Linux (see
          // reclaimLabsDirOwnershipWithPrompt's doc comment on why sudo-prompt isn't used here
          // either) — tell the renderer to ask instead.
          return { dropped: false, needsReclaimPassword: true };
        }
        // macOS: sudo-prompt's native dialog is reliable here, so a plain confirm first (this
        // isn't a deploy the user just asked for — they only undeployed) is enough.
        const parent = win;
        const messageBox = parent
          ? (o: Electron.MessageBoxOptions) => dialog.showMessageBox(parent, o)
          : (o: Electron.MessageBoxOptions) => dialog.showMessageBox(o);
        const { response } = await messageBox({
          type: "warning",
          buttons: ["Reclaim now", "Leave as is"],
          defaultId: 0,
          cancelId: 1,
          message: "Some lab files are still owned by the administrator account",
          detail:
            "The privileged session that just ended left some files in your labs folder owned " +
            "by the administrator account. Reclaiming them needs one more authorization prompt " +
            "— the app never stores your password, so being asked again here is expected, not a " +
            "bug. If you leave them as is, further edits to the affected lab (or undeploying it) " +
            "may fail until this is fixed, which you can also do yourself later.",
        });
        if (response === 0) {
          const reclaimed = await reclaimLabsDirOwnershipWithPrompt(labsPath);
          if (!reclaimed.ok) log(`could not reclaim ownership of the labs directory: ${reclaimed.message}`);
        } else {
          log("user chose to leave root-owned files in the labs directory as is");
        }
      }

      log("dropping elevated privileges (lab undeployed)");
      await stopBackend();
      await startup(openLab ? `/workspace/${encodeURIComponent(openLab)}` : undefined);
      return { dropped: true };
    },
  );

  // Linux-only companion to elevation:drop above: collects the password its own in-app modal
  // asks for when a quiet/native reclaim isn't available, and runs the actual chown with it. Not
  // gated on is_admin/hasForeignOwnedFiles again — elevation:drop already established both right
  // before returning needsReclaimPassword, and by the time the renderer calls this the backend
  // hasn't been touched since, so nothing here has changed.
  ipcMain.handle(
    "elevation:reclaim-labs-dir",
    (_e, password: string): ReturnType<typeof reclaimLabsDirOwnershipWithPassword> =>
      reclaimLabsDirOwnershipWithPassword(password, labsDir()),
  );

  ipcMain.handle("status:pick-python", async () => {
    const chosen = await pickPythonInterpreter(win);
    if (!chosen) return null;
    // Validated before it is recorded: this preference outranks every other interpreter candidate
    // (prereqs.ts's pythonCandidates) and whatever wins is interpolated into the elevated command
    // string on macOS/Windows (backend.ts's runElevatedNative). The dialog only ever returns a
    // real absolute path, so this refuses the pathological rather than the ordinary.
    if (!isPlainAbsolutePath(chosen)) {
      log(`refused an unsafe interpreter path: ${chosen}`);
      throw new Error(`"${chosen}" is not a usable interpreter path.`);
    }
    writePrefs({ pythonPath: chosen });
    log(`python interpreter set to ${chosen}`);
    return chosen;
  });

  // Driven from the setup page's "Install missing packages" button — the manual entry to the
  // same install startup() runs by itself when everything missing is installable. Reachable when
  // that automatic attempt already ran and failed, or when it was skipped because something the
  // app can't install (Docker) was failing too and has since been fixed.
  ipcMain.handle("status:install", async () => {
    const systemPython = lastPreflight?.systemPython;
    if (!systemPython) return { ok: false, error: "no usable Python interpreter found" };
    log("running install requested from the setup page");
    const result = await runInstall(systemPython);
    if (result.ok) {
      await startup();
    } else {
      // Previously just logged: the page's own static "Install failed: …" line (setup.html) was
      // immediately overwritten by the next poll's refresh(), so the user saw nothing.
      setStatus({
        state: "prereq-failed",
        checks: lastPreflight?.checks ?? [],
        notice: `Installation failed: ${result.error ?? "unknown error"}. Open the log for the full output.`,
      });
    }
    return result;
  });

  ipcMain.handle("shell:show-log", () => shell.openPath(backendLogPath()));

  // The renderer's only way to learn the pairing token backend.ts generated for this launch (see
  // buildBackendCommand) — it can't read it any other way, since it's never written to the page
  // the backend itself serves. Kept off the response even when null (the renderer is between
  // backends, e.g. mid-elevation) rather than a stale one, since sending the wrong token would
  // just present as a confusing 401 instead of "not ready yet".
  ipcMain.handle("auth:get-token", () => backendToken());

  ipcMain.handle("shell:open-external", (_e, url: string) => {
    // Never hand an arbitrary scheme to the OS: file://, and worse, would be a real hole here.
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
    log(`refused shell:open-external for ${url}`);
  });

  // The View/Help menu items the app draws itself act on the window or the shell, not on the
  // page, so they come back here rather than being handled in React.
  ipcMain.handle("shell:app-info", () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  // Pull, not push: checkForUpdate() is memoized and was already kicked off in
  // app.whenReady() below, in parallel with startup() — by the time the renderer has mounted
  // past setup.html and asks, the fetch has often already resolved. A push instead (the shell
  // sending the result unprompted) would race the SPA's own load: this fetch can easily finish
  // before win.loadURL(handle.baseUrl) ever happens, and a message sent to a page that hasn't
  // registered a listener yet is simply lost, not queued.
  ipcMain.handle("update:check", () => checkForUpdate());

  ipcMain.handle("window:zoom", (_e, direction: "in" | "out" | "reset") => {
    const contents = win?.webContents;
    if (!contents) return;
    const current = contents.getZoomLevel();
    contents.setZoomLevel(
      direction === "reset" ? 0 : direction === "in" ? current + 0.5 : current - 0.5,
    );
  });

  ipcMain.handle("window:toggle-full-screen", () => {
    if (win) win.setFullScreen(!win.isFullScreen());
  });

  ipcMain.handle("window:toggle-dev-tools", () => win?.webContents.toggleDevTools());

  ipcMain.handle("window:quit", () => app.quit());

  // Custom caption buttons (TitleBar.tsx draws them on Windows/Linux, replacing the window
  // controls Chromium would otherwise overlay — see createMainWindow's comment in windows.ts).
  // win.close() rather than app.quit(): a red "close" button should behave like the platform's
  // own close control, which on macOS hides the window without quitting the whole app.
  ipcMain.handle("window:minimize", () => win?.minimize());
  ipcMain.handle("window:maximize", () => win?.maximize());
  ipcMain.handle("window:unmaximize", () => win?.unmaximize());
  ipcMain.handle("window:close", () => win?.close());
  ipcMain.handle("window:is-maximized", () => win?.isMaximized() ?? false);

  ipcMain.handle("fs:pick-lab-archive", () => pickLabArchive(win));
  // The host side of a device's [volume] bind mount — see MachineOptionsFields.tsx's Volumes rows.
  ipcMain.handle("fs:pick-host-dir", (_e, current?: string) => pickHostDirectory(win, current));
  ipcMain.handle("fs:save", (_e, name: string, data: Uint8Array) => saveFile(win, name, data));
  ipcMain.handle("fs:open-labs-folder", () => openLabsDir());

  ipcMain.handle("fs:reveal-lab", async (_e, labName: string) => {
    revealPath(await labDirectory(labName));
  });

  ipcMain.handle("terminal:open-system", async (_e, labName: string, machine: string) => {
    await openSystemTerminal(await labDirectory(labName), machine);
  });

  ipcMain.handle("labs:get-dir", () => labsDir());
  ipcMain.handle("labs:default-dir", () => defaultLabsDir());
  // Records what the dialog actually offered, so `labs:set-dir` below can tell a directory the
  // user chose apart from one the renderer made up. realpath'd on the way in so a symlink can't
  // be used to smuggle a different target past the same check.
  ipcMain.handle("labs:pick-dir", async () => {
    const picked = await pickLabsDirectory(win);
    if (picked) {
      try {
        pickedLabsDirs.add(fs.realpathSync(picked));
      } catch {
        // A directory the dialog just returned should always resolve; if it somehow doesn't,
        // leave it unregistered — setLabsDir will refuse it rather than apply something unproven.
      }
    }
    return picked;
  });
  ipcMain.handle("labs:set-dir", (_e, dir: unknown) => setLabsDir(dir));
  ipcMain.handle("labs:reset-dir", () => setLabsDir(defaultLabsDir()));
}

/**
 * Apply a new lab storage root: validated, gated on deployed labs, then a full backend restart
 * (the only safe way to change it — labs_dir is read once at backend process startup, see
 * src/kathara_api/dependencies.py; a live directory swap would leave already-registered labs
 * holding filesystem handles bound to the old root). Existing labs in the old directory are left
 * on disk untouched, by design — this never moves anything.
 *
 * Resolves `true` if the change was applied (a restart is now in flight — startup()'s own
 * win.loadURL/showSetupPage calls take it from here), `false` if the user cancelled at the
 * deployed-labs prompt (no changes made, nothing to undo). Throws for anything it refuses — a
 * path that isn't a plain absolute one, one the folder dialog never offered, or a directory that
 * isn't writable — so the caller sees the problem immediately instead of after a restart that
 * would then fail.
 */
async function setLabsDir(dir: unknown): Promise<boolean> {
  // `unknown`, not `string`: the annotation on an ipcMain handler's argument is erased at runtime,
  // so this is the first place the value's shape is actually established.
  if (!isPlainAbsolutePath(dir)) {
    throw new Error(`${JSON.stringify(dir)} is not a usable directory path.`);
  }

  const isDefault = dir === defaultLabsDir();
  if (!isDefault) {
    // The renderer may only apply a directory the user chose in the native dialog this session
    // (see `labs:pick-dir` above) or the app's own default. Without this the handler is an
    // arbitrary-filesystem-root primitive: the backend comes back with its whole filesystem API
    // rooted here, so `setLabsDir("/home/<user>")` would hand the page read/write over the home
    // directory, `~/.ssh` included. The UI only ever passes a dialog result — but that is a
    // renderer-side convention, and this is the side that has to enforce it.
    let resolved: string;
    try {
      resolved = fs.realpathSync(dir);
    } catch (err) {
      throw new Error(`"${dir}" is not usable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!pickedLabsDirs.has(resolved)) {
      log(`refused labs directory not chosen through the folder dialog: ${dir}`);
      throw new Error(`"${dir}" was not chosen through the folder picker.`);
    }
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch (err) {
      throw new Error(`"${dir}" is not writable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const proceed = await confirmProceedWithDeployedLabs({
    primaryLabel: "Undeploy all and continue",
    secondaryLabel: "Continue anyway",
    detail:
      "Changing the labs folder restarts the backend. Their containers will keep running, but " +
      "won't appear in the app until you undeploy them manually.",
  });
  if (!proceed) return false;

  // Nothing is created here on purpose. This used to `mkdir -p` the target *before* the prompt
  // above, so a call that the user never confirmed — the common case, since that prompt is
  // skipped entirely when no labs are deployed — still left directories behind on disk. It isn't
  // needed either: the dialog creates the folder it returns (`createDirectory`), and backend.ts
  // mkdirs the effective labs dir right before spawning uvicorn regardless.
  writePrefs({ labsDir: isDefault ? undefined : dir });
  log(`labs directory set to ${dir}`);
  await stopBackend();
  await startup();
  return true;
}

/**
 * Ask the backend where a lab lives (GET /api/labs/{name}/location) rather than deriving the
 * path here: only the backend knows its storage root and which names it considers valid, and it
 * refuses an unsafe name instead of returning a path outside that root.
 */
async function labDirectory(labName: string): Promise<string> {
  const base = backendUrl();
  if (!base) throw new Error("the backend is not running");
  const res = await fetch(`${base}/api/labs/${encodeURIComponent(labName)}/location`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(BACKEND_QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`could not resolve lab directory (HTTP ${res.status})`);
  return ((await res.json()) as { path: string }).path;
}

interface DeployedLabsPromptOptions {
  /** Label for the button that undeploys everything and then proceeds. */
  primaryLabel: string;
  /** Label for the button that proceeds without undeploying. */
  secondaryLabel: string;
  /** Second line of the dialog, explaining what proceeding without undeploying costs. */
  detail: string;
}

/**
 * Deployed labs are Docker containers that outlive this process, so an action that would make
 * them inaccessible (quitting, or restarting the backend against a different labs directory)
 * must ask first rather than silently strand them. Shared by confirmQuitWithDeployedLabs and
 * setLabsDir — same GET /api/labs check, same three-way choice, only the wording differs.
 *
 * Resolves `true` if the caller should proceed (undeploying first if the user asked for that),
 * `false` if the user cancelled.
 */
async function confirmProceedWithDeployedLabs(opts: DeployedLabsPromptOptions): Promise<boolean> {
  const base = backendUrl();
  if (!base) return true;

  let deployed: string[] = [];
  try {
    // Bounded: an unresponsive-but-alive backend must not be able to block quit (or a labs-dir
    // change) forever — the `catch` below already fails toward "proceed", which is exactly the
    // right outcome for a timeout too, not just a hard connection failure.
    const res = await fetch(`${base}/api/labs`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(BACKEND_QUERY_TIMEOUT_MS),
    });
    if (!res.ok) return true;
    const labs = (await res.json()) as { name: string | null; deployed: boolean }[];
    deployed = labs.filter((l) => l.deployed).map((l) => l.name ?? "(unnamed)");
  } catch {
    // If we can't tell, don't stand in the way.
    return true;
  }
  if (deployed.length === 0) return true;

  // Captured into a const: `win` is module-level and mutable, so TypeScript can't keep the
  // non-null narrowing across the closure below.
  const parent = win;
  const messageBox = parent
    ? (o: Electron.MessageBoxOptions) => dialog.showMessageBox(parent, o)
    : (o: Electron.MessageBoxOptions) => dialog.showMessageBox(o);
  const { response } = await messageBox({
    type: "warning",
    buttons: [opts.primaryLabel, opts.secondaryLabel, "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: `${deployed.length} lab${deployed.length > 1 ? "s are" : " is"} still deployed`,
    detail: `${deployed.join(", ")}\n\n${opts.detail}`,
  });

  if (response === 2) return false;
  if (response === 0) {
    for (const name of deployed) {
      try {
        log(`undeploying ${name}`);
        // Bounded for the same reason as the GET above: an unresponsive-but-alive backend (or a
        // wedged Docker daemon behind it) must not be able to block quit forever. The catch below
        // already treats a failed undeploy as best-effort, not fatal — a timeout is just another
        // way for this to fail.
        await fetch(`${base}/api/labs/${encodeURIComponent(name)}/undeploy`, {
          method: "POST",
          headers: authHeaders(),
          signal: AbortSignal.timeout(BACKEND_QUERY_TIMEOUT_MS),
        });
      } catch (err) {
        log(`undeploy of ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return true;
}

function confirmQuitWithDeployedLabs(): Promise<boolean> {
  return confirmProceedWithDeployedLabs({
    primaryLabel: "Undeploy all and quit",
    secondaryLabel: "Quit anyway",
    detail: "Their containers keep running after the app closes.",
  });
}

// A second launch must hand its deep link to the running instance instead of starting a rival
// backend on another port.
if (!app.requestSingleInstanceLock()) {
  // Say so before leaving: a silent exit here looks exactly like the app failing to launch.
  // The usual cause is a genuine second launch (whose deep link the running instance handles
  // via "second-instance" below), but a stale SingletonLock in userData — left behind when a
  // previous run was SIGKILLed — produces the same result with no window to focus.
  log("another instance already holds the single-instance lock; exiting");
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) handleDeepLink(win, url);
    else win?.focus();
  });

  // macOS delivers deep links as an event, which can fire before the app is ready.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (status.state === "ready") handleDeepLink(win, url);
    else pendingDeepLink = url;
  });

  app.whenReady().then(async () => {
    log(`Kathara Desktop ${app.getVersion()} starting (packaged=${app.isPackaged})`);

    // Everything before the window is pure in-memory registration — ipcMain.handle,
    // app.on("web-contents-created"), Menu.setApplicationMenu — so nothing here can delay the
    // first paint. Anything that shells out (the login shell's PATH, the Docker and Python
    // probes) now happens inside startup(), below, with the window already up reporting it.
    //
    // registerIpc() first of all: setup.html calls status:get as soon as it loads.
    registerIpc();
    // Started here, not inside startup(): this is a one-shot external network call, unrelated
    // to getting the local backend healthy (startup() re-runs on every retry/elevation/labs-dir
    // change, which would otherwise re-fetch pointlessly). Fire-and-forget in parallel with
    // startup() below — network trouble here must never delay first paint or the backend.
    void checkForUpdate();
    // Before any window exists, so no WebContents is ever created unguarded.
    installNavigationPolicy(backendUrl);
    installEditContextMenu();
    // Binds the keyboard accelerators the window is about to use.
    buildMenu();

    win = createMainWindow();
    win.on("closed", () => {
      win = null;
    });
    // Any navigation away from setup.html is the app itself being loaded (startup() and the
    // elevation handlers are the only callers of loadURL), so this is where showSetup's guard
    // gets reset — no bookkeeping needed at those call sites.
    win.webContents.on("did-navigate", (_e, url) => {
      if (!url.startsWith("file://")) onSetupPage = false;
    });
    // Shown once, this launch only, for exactly the app's actual boot duration — startup() below
    // runs immediately, with the splash still on screen; it only switches to the setup page
    // itself if something needs the user's attention (see its two showSetup(win) calls), or hands
    // off straight to the running app on success. Every later trip through startup() (retry,
    // elevation, labs-dir change, a successful install) is already on the setup page by then, not
    // back through here — it's a first-impression thing, not something to show again.
    showSplashPage(win);

    onBackendExit((info) => {
      // An unexpected exit leaves the renderer pointing at a dead origin; show the log instead.
      if (!win) return;
      setStatus({
        state: "backend-failed",
        checks: [],
        error: `The Kathara API stopped unexpectedly (code ${info.code ?? "unknown"}, signal ${info.signal ?? "none"}).`,
        logTail: tailLog(),
      });
      showSetup(win);
    });

    // A backend that couldn't be stopped — most likely one still running as root after a failed
    // elevated shutdown — is otherwise a silent, permanent leak: the app just starts a fresh one
    // on a different port and moves on. Not blocking (fire-and-forget): this is purely
    // informational, so it must never hold up whatever startup/quit/restart triggered it.
    onOrphanedBackend((info) => {
      log(`backend at ${info.baseUrl || "an unknown address"} (pid ${info.pid ?? "unknown"}) could not be stopped and may still be running`);
      // "Force Stop Now" only offered when a real PID is known: forceKillOrphan has nothing to
      // target otherwise, and offering a button that can't do anything would be worse than not
      // offering one — see forceKillOrphan/resolvePidForPort in backend.ts.
      const buttons = info.pid ? ["OK", "Force Stop Now…"] : ["OK"];
      void dialog
        .showMessageBox({
          type: "warning",
          title: "Kathara backend still running",
          message: "The previous Kathara backend could not be stopped and may still be running with administrator privileges.",
          detail:
            `It was running${info.baseUrl ? ` at ${info.baseUrl}` : ""}${info.pid ? ` (pid ${info.pid})` : ""}. ` +
            "A new backend has started normally, but you may need to stop the old one manually — " +
            `for example${info.pid ? `, \`sudo kill ${info.pid}\`` : " via your system's process manager"}.`,
          buttons,
          defaultId: 0,
          cancelId: 0,
        })
        .then(async (result) => {
          if (!info.pid || result.response !== 1) return;
          log(`user requested force-kill of orphaned backend (pid ${info.pid})`);
          const outcome = await forceKillOrphan();
          if (outcome.ok) {
            log(`orphaned backend (pid ${info.pid}) force-killed`);
          } else {
            log(`force-kill of orphaned backend (pid ${info.pid}) failed: ${outcome.message}`);
            void dialog.showErrorBox("Could not stop backend", outcome.message ?? "Unknown error.");
          }
        });
    });

    // After the window, deliberately: on Linux app.setAsDefaultProtocolClient can shell out to
    // xdg-settings, and nothing during boot depends on the kathara: scheme being registered yet
    // (a deep link that arrives before the UI is ready is buffered in pendingDeepLink anyway).
    registerProtocol();

    pendingDeepLink ??= deepLinkFromArgv(process.argv);
    await startup();
  });

  let quitConfirmed = false;
  app.on("before-quit", (event) => {
    if (quitConfirmed) return;
    event.preventDefault();
    void confirmQuitWithDeployedLabs().then((proceed) => {
      if (!proceed) return;
      quitConfirmed = true;
      app.quit();
    });
  });

  // Last chance to reap the child: an orphaned uvicorn holds the labs directory and a port.
  app.on("will-quit", (event) => {
    event.preventDefault();
    void stopBackend().finally(() => {
      app.exit(0);
    });
  });

  // Electron installs no handler for these, so a terminal Ctrl+C or a session logout would
  // kill the shell and leave uvicorn — and the containers it manages — running. Route them
  // through the normal quit path instead. SIGKILL is unhandleable by definition; the OS
  // reparents the child and there is nothing to be done about that.
  //
  // SIGHUP is deliberately absent: a windowed app should survive its launching terminal going
  // away, and merely installing a handler cancels the SIGHUP-ignore that nohup sets up — which
  // made the app exit silently the moment the shell that started it closed.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`received ${signal}; quitting`);
      app.quit();
    });
  }

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && status.state === "ready") {
      win = createMainWindow();
      const base = backendUrl();
      if (base) void win.loadURL(base);
    }
  });
}
