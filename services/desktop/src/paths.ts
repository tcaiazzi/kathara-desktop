/** Filesystem locations the shell needs, resolved differently in dev and when packaged. */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { readPrefs } from "./prefs";

/**
 * Repo root in dev: app.getAppPath() is services/desktop, so the root is two levels up.
 * A function, not a const: module initialisation can run before `app` is usable.
 */
export function repoRoot(): string {
  return path.resolve(app.getAppPath(), "..", "..");
}

/**
 * The built frontend that the backend will serve (see src/kathara_api/spa.py).
 * Packaged, it is copied in as an extraResource; in dev it is the frontend's own dist/.
 * Returns null when the frontend has not been built yet, so the caller can say so plainly
 * instead of starting a backend that would answer 404 at /.
 */
export function frontendDir(): string | null {
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
 * app update. Also the fallback whenever no custom directory is configured or usable. */
export function defaultLabsDir(): string {
  return path.join(app.getPath("userData"), "labs");
}

/**
 * Lab storage root actually in effect. Prefers a user-chosen directory (Settings → "Change…",
 * services/frontend's SettingsPage) over the default, but only if it still exists — a configured
 * directory that vanished (an unplugged drive, a deleted folder) falls back silently instead of
 * failing backend startup, the same guard idiom as frontendDir()/iconPath() above.
 */
export function labsDir(): string {
  const configured = readPrefs().labsDir;
  if (configured && fs.existsSync(configured)) return configured;
  return defaultLabsDir();
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
 * Where a packaged app's auto-installed venv lives: under userData, not inside the installed
 * app bundle (read-only once signed/packaged on most platforms, and wiped on reinstall/update).
 */
export function packagedVenvDir(): string {
  return path.join(app.getPath("userData"), "venv");
}

/** The interpreter inside that venv, once install.ts has created it. */
export function packagedVenvPython(): string | null {
  if (!app.isPackaged) return null;
  const candidate =
    process.platform === "win32"
      ? path.join(packagedVenvDir(), "Scripts", "python.exe")
      : path.join(packagedVenvDir(), "bin", "python");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * kathara-api-rest's own wheel, built by CI and shipped as an extraResource (electron-builder.yml)
 * so install.ts can `pip install` it without a git checkout — pulls in kathara/uvicorn/etc.
 * transitively since they're already its own pyproject.toml dependencies. Packaged only: a dev
 * checkout installs from source instead (scripts/install-<os>.{sh,ps1}).
 */
export function bundledWheelPath(): string | null {
  if (!app.isPackaged) return null;
  const dir = path.join(process.resourcesPath, "vendor");
  const wheel = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith(".whl")) : undefined;
  return wheel ? path.join(dir, wheel) : null;
}
