/** Filesystem locations the shell needs, resolved differently in dev and when packaged. */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { readPrefs } from "./prefs";
import { isPlainAbsolutePath } from "./safety";

/**
 * Repo root in dev: app.getAppPath() is services/desktop, so the root is two levels up.
 * A function, not a const: module initialisation can run before `app` is usable.
 */
function repoRoot(): string {
  return path.resolve(app.getAppPath(), "..", "..");
}

/**
 * The built frontend that the backend will serve (`KATHARA_API_STATIC_DIR`, see
 * src/kathara_api/spa.py). Packaged, it is copied in as an extraResource; in dev it is the
 * frontend's own dist/. Returns null when the frontend has not been built yet, so the caller can
 * say so plainly instead of starting a backend that would answer 404 at /.
 */
export function resolveStaticDir(): string | null {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : path.join(repoRoot(), "services", "frontend", "dist");
  return fs.existsSync(path.join(candidate, "index.html")) ? candidate : null;
}

/**
 * In dev the API package may not be pip-installed into the interpreter we pick, so the repo's
 * src/ is offered on PYTHONPATH as a fallback. Never used in a packaged app: there is no repo.
 */
export function backendSrcDir(): string | null {
  if (app.isPackaged) return null;
  const src = path.join(repoRoot(), "src");
  return fs.existsSync(path.join(src, "kathara_api")) ? src : null;
}

/** The built-in lab storage location — per user rather than per checkout, so labs survive an
 * app update. Also the fallback whenever no custom directory is configured or usable.
 *
 * Windows only: bind-mounting anything under `userData` (`%APPDATA%\Roaming\...`) can be denied
 * outright by Docker Desktop — AppData is a location commonly watched/locked by antivirus/EDR
 * tooling, unlike an ordinary user-created folder — so Windows gets a plain folder under the
 * profile root instead. Not Documents\... either: Documents is frequently OneDrive-synced via
 * Known Folder Move, and cloud placeholder files there are at least as likely to break bind
 * mounts as AppData is.
 */
export function defaultLabsDir(): string {
  if (process.platform === "win32") {
    return path.join(app.getPath("home"), "Kathara-Desktop", "labs");
  }
  return path.join(app.getPath("userData"), "labs");
}

/**
 * Lab storage root actually in effect. Prefers a user-chosen directory (Settings → "Change…",
 * services/frontend's SettingsPage) over the default, but only if it still exists — a configured
 * directory that vanished (an unplugged drive, a deleted folder) falls back silently instead of
 * failing backend startup, the same guard idiom as resolveStaticDir() above and iconPath() below.
 *
 * Validated as well as existence-checked, because this value is what becomes
 * KATHARA_API_LABS_DIR, and a path in the labs directory can reach the root `chown` that gives
 * back files devices left owned by root (labFolders.ts's reclaimScript). `preferences.json` is
 * parsed by readPrefs with no schema validation at all, so a hand-edited (or otherwise
 * attacker-written) file is the one way a value can reach here without passing main.ts's
 * `labs:set-dir` checks. Same shape as safety.ts's isUsablePort, which guards prefs.backendPort
 * for the same reason.
 *
 * console.warn rather than logger's log(): logger.ts imports this module for logFile(), so
 * importing it back would be a cycle. The main process's stdout is captured in the app log anyway.
 */
export function labsDir(): string {
  const configured = readPrefs().labsDir;
  if (isPlainAbsolutePath(configured) && fs.existsSync(configured)) return configured;
  if (configured !== undefined) {
    console.warn(`ignoring unusable labsDir in preferences.json: ${JSON.stringify(configured)}`);
  }
  return defaultLabsDir();
}

/**
 * Where the backend keeps state belonging to no single lab (KATHARA_API_STATE_DIR): the list of
 * lab folders opened from outside the labs directory (labFolders.ts's KNOWN_LABS_FILENAME) and
 * the official image list last fetched from Docker Hub. The per-user app data directory, next to
 * preferences.json, rather than the labs directory: that list of folders names *which* folders
 * the app may read and write, so it must not live inside one of them.
 */
export function stateDir(): string {
  return app.getPath("userData");
}

export function logFile(): string {
  return path.join(app.getPath("logs"), "backend.log");
}

/**
 * The application icon, as a real file on disk.
 *
 * electron-builder embeds an icon in the installer and the .desktop entry, but the *window* and
 * taskbar icon comes from BrowserWindow's `icon` option — without it a Linux window shows
 * Electron's default logo, and in a dev checkout there is no packaged icon at all. Shipped as an
 * extraResource (electron-builder.yml) so the packaged path exists too.
 */
export function iconPath(): string | undefined {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(app.getAppPath(), "resources", "icon.png");
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** The status/setup page, copied beside the bundles by scripts/build.mjs. */
export function setupPage(): string {
  return path.join(__dirname, "setup.html");
}

/** The cold-start splash page, copied beside the bundles (with its splash.png) by
 * scripts/build.mjs. */
export function splashPage(): string {
  return path.join(__dirname, "splash.html");
}

/** The interpreter shipped with a dev checkout, tried before anything on PATH. */
export function devVenvPython(): string | null {
  if (app.isPackaged) return null;
  const candidate =
    process.platform === "win32"
      ? path.join(repoRoot(), ".venv", "Scripts", "python.exe")
      : path.join(repoRoot(), ".venv", "bin", "python");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * The Python interpreter shipped inside the app (a python-build-standalone `install_only_stripped`
 * build, fetched at CI build time by scripts/fetch-python.mjs and shipped as an arch-scoped
 * extraResource — see electron-builder.yml).
 *
 * In a packaged app this is the *only* interpreter, on every OS: prereqs.ts's
 * pythonCandidates() offers nothing else, there is no system-Python fallback and no private venv.
 * Its dependencies are shipped beside it (bundledSitePackages()) rather than installed at first
 * launch, so a packaged app needs neither a system Python nor a network. Packaged only: a dev
 * checkout goes on using devVenvPython()/PATH.
 */
export function bundledPythonPath(): string | null {
  const root = bundledPythonDir();
  if (!root) return null;
  const candidate = path.join(root, process.platform === "win32" ? "python.exe" : "bin/python3");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * The root of that bundled interpreter's tree. Nothing may be written into it: the app's Python
 * environment is read-only by design, which is what makes it work identically on an AppImage's
 * squashfs, a root-owned /opt from the .deb/.rpm, a Program Files directory chosen in the NSIS
 * installer, and a signed .app on macOS.
 */
function bundledPythonDir(): string | null {
  if (!app.isPackaged) return null;
  const root = path.join(process.resourcesPath, "python");
  return fs.existsSync(root) ? root : null;
}

/**
 * The backend's entire dependency closure — kathara-api-rest, kathara, uvicorn, fastapi and every
 * transitive dependency — installed for this exact (os, arch) at build time by
 * scripts/vendor-python-deps.mjs and shipped as an arch-scoped extraResource.
 *
 * A plain `pip install --target` tree, not a venv and not the bundled interpreter's own
 * site-packages: it goes on PYTHONPATH when the shell spawns the backend (backend.ts's
 * buildBackendCommand()), which is the one arrangement that needs nothing writable inside the app
 * at runtime and therefore behaves the same on every OS and every kind of installation.
 */
export function bundledSitePackages(): string | null {
  if (!app.isPackaged) return null;
  const dir = path.join(process.resourcesPath, "site-packages");
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Where .pyc files go. vendor-python-deps.mjs installs with `--no-compile` (a .pyc compiled at
 * build time is invalidated the moment electron-builder rewrites the source's mtime, and Python
 * would then try to rewrite it in a read-only directory on every single import), so the cache has
 * to be built at runtime somewhere writable. Not a correctness requirement — Python falls back to
 * re-parsing the source — but the difference between a warm and a cold backend start.
 */
export function pycacheDir(): string {
  return path.join(app.getPath("userData"), "pycache");
}

/** Where Crashpad writes minidumps for a native crash (renderer OOM, V8 crash, GPU process gone —
 * see main.ts's crashReporter.start()). Nothing reads them automatically; they are pure
 * diagnostic infrastructure for whoever investigates a crash report by hand. */
export function crashDumpsDir(): string {
  return path.join(app.getPath("userData"), "crashDumps");
}
