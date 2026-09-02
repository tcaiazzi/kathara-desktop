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
  backendUrl,
  onBackendExit,
  onOrphanedBackend,
  startBackend,
  startBackendElevatedLinux,
  startBackendElevatedNative,
  stopBackend,
  type ElevateResult,
} from "./backend";
import { deepLinkFromArgv, handleDeepLink, registerProtocol } from "./deeplink";
import { fixPathEnv } from "./env";
import { runAutoInstall } from "./install";
import {
  openLabsDir,
  openSystemTerminal,
  pickLabArchive,
  pickLabsDirectory,
  pickPythonInterpreter,
  revealPath,
  saveFile,
} from "./integrations";
import { log, tailLog } from "./logger";
import { buildMenu } from "./menu";
import { defaultLabsDir, labsDir, packagedVenvPython, resolveStaticDir } from "./paths";
import { writePrefs } from "./prefs";
import { runPreflight, type Check, type Preflight } from "./prereqs";
import { createMainWindow, installEditContextMenu, installNavigationPolicy, showSetupPage } from "./windows";

// Electron derives userData's folder name from app.name, which defaults to package.json's
// productName ("Kathara IDE") — a folder with a space and mixed case. Override it to this
// repo's own lowercase-hyphenated convention instead, using a fresh path built from the
// platform-correct base ('appData': %APPDATA% / ~/Library/Application Support / ~/.config)
// so this stays correct on every platform, not just Linux.
//
// Deliberately app.setPath('userData', ...) rather than app.setName('kathara-ide'): setName
// would also rename the macOS menu-bar app label and Dock name, which is not what was asked.
// Must run before requestSingleInstanceLock() below — the single-instance lock file is
// itself written under userData, so calling this any later would leave it in the old folder.
// Existing data already at the old path (labs, preferences.json) is left there untouched,
// not moved — same "leave old data behind, don't migrate silently" choice already made for
// the labs-directory setting itself.
app.setPath("userData", path.join(app.getPath("appData"), "kathara-ide"));

// Bounds every ad-hoc query this file makes against an already-healthy backend (list labs, look
// up a lab's directory) — deliberately more generous than backend.ts's SHUTDOWN_HTTP_TIMEOUT_MS,
// since these can enumerate real state rather than hit one fixed endpoint, but still bounded: an
// unresponsive-but-alive backend (a stuck Kathara/Docker call on its single worker) must not be
// able to hang app quit, or leave a renderer click (Reveal in file manager, Open in terminal)
// spinning forever with nothing to show for it.
const BACKEND_QUERY_TIMEOUT_MS = 5_000;

type Status =
  | { state: "starting"; message: string }
  | { state: "prereq-failed"; checks: Check[] }
  | { state: "backend-failed"; checks: Check[]; error: string; logTail: string }
  | { state: "ready" };

let win: BrowserWindow | null = null;
let status: Status = { state: "starting", message: "Starting…" };
/** A deep link that arrived before the UI was ready, replayed once it is. */
let pendingDeepLink: string | null = null;
/** The most recent preflight result, so status:install knows which system Python to use. */
let lastPreflight: Preflight | null = null;

function setStatus(next: Status): void {
  status = next;
}

/**
 * Run preflight, start the backend, and load the UI. Safe to call again on "Retry".
 *
 * `resumePath`, if given, is appended to the loaded URL (e.g. `/workspace/<lab>` from
 * elevation:drop below) so a backend restart triggered *from inside* an already-open lab lands
 * back there instead of the bare root every other caller of startup() wants.
 */
async function startup(resumePath?: string): Promise<void> {
  if (!win) return;
  setStatus({ state: "starting", message: "Checking prerequisites…" });

  const staticDir = resolveStaticDir();
  const preflight = await runPreflight(staticDir !== null);
  lastPreflight = preflight;
  if (!preflight.ok || !preflight.python || !staticDir) {
    setStatus({ state: "prereq-failed", checks: preflight.checks });
    return;
  }

  setStatus({ state: "starting", message: "Starting the Kathara API…" });
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
    showSetupPage(win);
  }
}

function registerIpc(): void {
  ipcMain.handle("status:get", () => status);

  ipcMain.handle("status:retry", async () => {
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
  ipcMain.handle("elevation:elevate", async (_e, password?: string, resumeLab?: string): Promise<ElevateResult> => {
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
      return result;
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
    return result;
  });

  // Driven after a successful undeploy (see useLabLifecycleActions.ts): least-privilege — an
  // elevated backend shouldn't keep running as root once nothing it's doing needs that. There's
  // no in-place "un-sudo" for a running process, so this is the same stop-and-restart dance as
  // elevating, just back to the plain unprivileged backend; reuses startup() (preflight +
  // startBackend + loadURL + status) rather than duplicating it, same as status:retry above. A
  // cheap no-op — no restart, no reload — when the backend isn't currently elevated at all,
  // which is the common case (most undeploys aren't for a privileged-device lab).
  ipcMain.handle("elevation:drop", async (_e, openLab?: string): Promise<{ dropped: boolean }> => {
    const baseUrl = backendUrl();
    if (!baseUrl) return { dropped: false };
    try {
      const info = await fetch(`${baseUrl}/api/system`).then((r) => r.json());
      if (!info.is_admin) return { dropped: false };
    } catch {
      return { dropped: false };
    }
    log("dropping elevated privileges (lab undeployed)");
    await stopBackend();
    await startup(openLab ? `/workspace/${encodeURIComponent(openLab)}` : undefined);
    return { dropped: true };
  });

  ipcMain.handle("status:pick-python", async () => {
    const chosen = await pickPythonInterpreter(win);
    if (chosen) {
      writePrefs({ pythonPath: chosen });
      log(`python interpreter set to ${chosen}`);
    }
    return chosen;
  });

  // Driven from the setup page's "Install automatically" button: installs kathara-api-rest
  // (and its transitive kathara/uvicorn deps) into a private venv using whatever system Python
  // preflight found, then re-runs startup() so a successful install proceeds straight to "ready".
  ipcMain.handle("status:install", async () => {
    const systemPython = lastPreflight?.systemPython;
    if (!systemPython) return { ok: false, error: "no usable Python interpreter found" };
    log("running automatic install");
    const result = await runAutoInstall(systemPython);
    if (result.ok) {
      // Point the app at the venv install.ts just created — otherwise the next preflight probes
      // the same interpreter as before (which was never installed into) and reports the exact
      // same "missing" checks, as if nothing happened.
      const venvPython = packagedVenvPython();
      if (venvPython) {
        writePrefs({ pythonPath: venvPython });
        log(`python interpreter set to ${venvPython}`);
      }
      await startup();
    } else {
      log(`automatic install failed: ${result.error}`);
    }
    return result;
  });

  ipcMain.handle("shell:show-log", () => shell.openPath(backendLogPath()));

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
  ipcMain.handle("labs:pick-dir", () => pickLabsDirectory(win));
  ipcMain.handle("labs:set-dir", (_e, path: string) => setLabsDir(path));
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
 * deployed-labs prompt (no changes made, nothing to undo). Throws for a directory that isn't
 * writable, so the caller sees the problem immediately instead of after a restart that would
 * then fail.
 */
async function setLabsDir(path: string): Promise<boolean> {
  try {
    // mkdir, not just an access check: the directory may not exist yet — the default one is
    // only ever created lazily by backend.ts right before spawning uvicorn, and the same is true
    // of a fresh custom directory the first time it's chosen. This also validates writability as
    // a side effect (throws EACCES/EROFS/ENOTDIR for a path that can't actually be used).
    fs.mkdirSync(path, { recursive: true });
    fs.accessSync(path, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`"${path}" is not usable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const proceed = await confirmProceedWithDeployedLabs({
    primaryLabel: "Undeploy all and continue",
    secondaryLabel: "Continue anyway",
    detail:
      "Changing the labs folder restarts the backend. Their containers will keep running, but " +
      "won't appear in the app until you undeploy them manually.",
  });
  if (!proceed) return false;

  writePrefs({ labsDir: path === defaultLabsDir() ? undefined : path });
  log(`labs directory set to ${path}`);
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
    const res = await fetch(`${base}/api/labs`, { signal: AbortSignal.timeout(BACKEND_QUERY_TIMEOUT_MS) });
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
        await fetch(`${base}/api/labs/${encodeURIComponent(name)}/undeploy`, { method: "POST" });
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
    log(`Kathara IDE ${app.getVersion()} starting (packaged=${app.isPackaged})`);
    // Before anything that shells out (Docker/Python checks, terminal integration): a
    // double-clicked GUI app doesn't inherit the Terminal's PATH, so Homebrew/Docker Desktop
    // binaries would otherwise be invisible even though they work fine from a shell.
    fixPathEnv();
    registerProtocol();
    registerIpc();
    buildMenu();
    // Before any window exists, so no WebContents is ever created unguarded.
    installNavigationPolicy(backendUrl);
    installEditContextMenu();

    win = createMainWindow();
    win.on("closed", () => {
      win = null;
    });
    showSetupPage(win);

    onBackendExit((info) => {
      // An unexpected exit leaves the renderer pointing at a dead origin; show the log instead.
      if (!win) return;
      setStatus({
        state: "backend-failed",
        checks: [],
        error: `The Kathara API stopped unexpectedly (code ${info.code ?? "unknown"}, signal ${info.signal ?? "none"}).`,
        logTail: tailLog(),
      });
      showSetupPage(win);
    });

    // A backend that couldn't be stopped — most likely one still running as root after a failed
    // elevated shutdown — is otherwise a silent, permanent leak: the app just starts a fresh one
    // on a different port and moves on. Not blocking (fire-and-forget): this is purely
    // informational, so it must never hold up whatever startup/quit/restart triggered it.
    onOrphanedBackend((info) => {
      log(`backend at ${info.baseUrl || "an unknown address"} (pid ${info.pid ?? "unknown"}) could not be stopped and may still be running`);
      void dialog.showMessageBox({
        type: "warning",
        title: "Kathara backend still running",
        message: "The previous Kathara backend could not be stopped and may still be running with administrator privileges.",
        detail:
          `It was running${info.baseUrl ? ` at ${info.baseUrl}` : ""}${info.pid ? ` (pid ${info.pid})` : ""}. ` +
          "A new backend has started normally, but you may need to stop the old one manually — " +
          `for example${info.pid ? `, \`sudo kill ${info.pid}\`` : " via your system's process manager"}.`,
      });
    });

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
