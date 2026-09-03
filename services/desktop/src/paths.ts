/** Filesystem locations the shell needs, resolved differently in dev and when packaged. */
import { app } from "electron";
import crypto from "node:crypto";
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
 * `frontendDir()`, but safe to hand to a backend that might run as a *different* user (i.e. a
 * `sudo`-elevated backend — see backend.ts's startBackendElevatedLinux/Native).
 *
 * An AppImage doesn't run its contents directly: its own runtime FUSE-mounts itself under
 * `/tmp/.mountXXXXXX/` as the launching user first, and `frontendDir()`'s packaged candidate
 * resolves inside that mount. FUSE mounts are only readable by the mounting user unless made
 * with `allow_other` — unlike a real filesystem, root does *not* automatically bypass this — so
 * an elevated backend gets `PermissionError` trying to read it. Detected via `$APPIMAGE`, which
 * the AppImage runtime sets to the AppImage's own path — the standard way an app tells it's
 * running from one. Not an issue for a dev checkout or a .deb/.rpm install: both resolve to a
 * real directory on disk that any UID can read.
 *
 * Copies the frontend out to a stable, real on-disk location once (cached across launches) and
 * returns that instead. Keyed on a hash of `index.html`'s own content, not `app.getVersion()`:
 * Vite fingerprints every asset's filename into the script/link tags `index.html` references, so
 * any real change to the build changes this file's bytes too — a version bump reliably causes
 * one anyway, but keying on content instead also self-invalidates a rebuild that ships under the
 * *same* version (e.g. a local dev/test cycle), which version-only keying silently kept serving
 * a stale copy for.
 */
export function resolveStaticDir(): string | null {
  const candidate = frontendDir();
  if (!candidate || !process.env.APPIMAGE) return candidate;

  const indexHtml = fs.readFileSync(path.join(candidate, "index.html"));
  const key = crypto.createHash("sha256").update(indexHtml).digest("hex").slice(0, 16);

  const cacheRoot = path.join(app.getPath("userData"), "frontend-cache");
  const cached = path.join(cacheRoot, key);
  if (!fs.existsSync(path.join(cached, "index.html"))) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.rmSync(cached, { recursive: true, force: true });
    fs.cpSync(candidate, cached, { recursive: true });

    // Drop every other cached copy — there's normally at most one (the previous build's), never
    // worth keeping once this launch has a fresh one of its own.
    for (const entry of fs.readdirSync(cacheRoot)) {
      if (entry !== key) fs.rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
    }
  }
  return cached;
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

/** The cold-start splash animation, copied beside the bundles (with its splash.gif) by
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
 * The Python interpreter shipped inside the app (a python-build-standalone `install_only_stripped`
 * build, fetched at CI build time by scripts/fetch-python.mjs and shipped as an arch-scoped
 * extraResource — see electron-builder.yml). Has no packages installed; it only exists so
 * prereqs.ts's pythonCandidates() always finds *some* usable ≥3.10 interpreter to seed
 * `<userData>/venv` with (install.ts), without requiring the user to have Python at all. Packaged
 * only: a dev checkout keeps using devVenvPython()/PATH, same as before.
 */
export function bundledPythonPath(): string | null {
  if (!app.isPackaged) return null;
  const candidate = path.join(
    process.resourcesPath,
    "python",
    process.platform === "win32" ? "python.exe" : "bin/python3",
  );
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
