/** Filesystem locations the shell needs, resolved differently in dev and when packaged. */
import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readPrefs } from "./prefs";
import { isPlainAbsolutePath } from "./safety";

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
 * a stale copy for. Recomputed on every launch.
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
 * app update. Also the fallback whenever no custom directory is configured or usable.
 *
 * Windows only: bind-mounting anything under `userData` (`%APPDATA%\Roaming\...`) can be denied
 * outright by Docker Desktop — AppData is a location commonly watched/locked by antivirus/EDR
 * tooling, unlike an ordinary user-created folder — so Windows gets a plain folder under the
 * profile root instead. No legacy fallback: the app has no real installed base yet (only test
 * releases), so there's no existing AppData folder that needs preserving. Not Documents\...
 * either: Documents is
 * frequently OneDrive-synced via Known Folder Move, and cloud placeholder files there are at
 * least as likely to break bind mounts as AppData is.
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
 * failing backend startup, the same guard idiom as frontendDir()/iconPath() above.
 *
 * Validated as well as existence-checked, because this value is what becomes
 * KATHARA_API_LABS_DIR: on the elevated macOS path sudo-prompt writes every env value into
 * `export KEY="value"` in a script that runs as root, escaping only `"`. `preferences.json` is
 * parsed by readPrefs with no schema validation at all, so a hand-edited (or otherwise
 * attacker-written) file is the one way a value can reach here without passing main.ts's
 * `labs:set-dir` checks. Same shape as backend.ts's isUsablePort, which guards prefs.backendPort
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
 * In a packaged app this is now the *only* interpreter, on every OS: prereqs.ts's
 * pythonCandidates() offers nothing else, there is no system-Python fallback and no private venv.
 * Its dependencies are shipped beside it (bundledSitePackages()) rather than installed at first
 * launch, so a packaged app needs neither a system Python nor a network. Packaged only: a dev
 * checkout keeps using devVenvPython()/PATH, same as before.
 */
export function bundledPythonPath(): string | null {
  const root = bundledPythonDir();
  if (!root) return null;
  const candidate = path.join(root, process.platform === "win32" ? "python.exe" : "bin/python3");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * The root of that bundled interpreter's tree. Separate from the interpreter path because the
 * whole tree is what appImagePythonCache() has to copy out, and because nothing may be written
 * into it: the app's Python environment is read-only by design, which is what makes it work
 * identically on an AppImage's squashfs, a root-owned /opt from the .deb/.rpm, a Program Files
 * directory chosen in the NSIS installer, and a signed .app on macOS.
 */
export function bundledPythonDir(): string | null {
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

/**
 * The bundled Python environment as a *root-readable* pair of paths, for the elevated backend
 * (backend.ts's startBackendElevatedLinux/Native). Returns null when the ordinary paths already
 * work, which is every case except one.
 *
 * That case is the AppImage, and it is the same trap resolveStaticDir() documents above: the
 * AppImage runtime FUSE-mounts itself under `/tmp/.mountXXXXXX/` as the launching user, and root
 * does *not* bypass a FUSE mount's ownership the way it bypasses ordinary file permissions. An
 * elevated backend started from those paths cannot exec the interpreter or read a single module.
 *
 * So copy both halves out to a stable, real on-disk location under `userData` and hand those back
 * instead. Deliberately lazy — called only from the elevated start paths, never during a normal
 * launch: elevation is an explicit user action already behind a password prompt, where a one-off
 * copy is unnoticeable, while doing it on every launch would cost every user ~200 MB of disk for
 * a feature most never use.
 *
 * Keyed on the content of the vendored dependency manifest rather than app.getVersion(), for the
 * same reason resolveStaticDir() keys on index.html's bytes: it also self-invalidates a rebuild
 * shipping under a version that has not been bumped.
 */
export function appImagePythonCache(): { python: string; sitePackages: string } | null {
  if (!process.env.APPIMAGE) return null;
  const pythonDir = bundledPythonDir();
  const sitePackages = bundledSitePackages();
  if (!pythonDir || !sitePackages) return null;

  // The manifest is only cache-key material, never a correctness requirement — a build that
  // somehow shipped without it must still be able to elevate, so fall back to the app version
  // rather than throwing out of a path the user reached by typing their password.
  let keyMaterial: Buffer | string;
  try {
    keyMaterial = fs.readFileSync(path.join(sitePackages, "vendor-manifest.json"));
  } catch {
    console.warn("no vendor-manifest.json beside the bundled site-packages — keying the AppImage python cache on the app version instead");
    keyMaterial = app.getVersion();
  }
  const key = crypto.createHash("sha256").update(keyMaterial).digest("hex").slice(0, 16);

  const cacheRoot = path.join(app.getPath("userData"), "python-cache");
  const cached = path.join(cacheRoot, key);
  // Written last, so a copy interrupted half-way (a crash, a kill) is never mistaken for a
  // finished one on the next launch — unlike resolveStaticDir(), whose marker is the copied
  // index.html itself, this tree has no single file that means "all of it arrived".
  const complete = path.join(cached, ".complete");

  if (!fs.existsSync(complete)) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.rmSync(cached, { recursive: true, force: true });
    // verbatimSymlinks: python-build-standalone ships bin/python3 as a relative symlink to
    // python3.12; dereferencing it would silently double the copy and break nothing visibly.
    fs.cpSync(pythonDir, path.join(cached, "python"), { recursive: true, verbatimSymlinks: true });
    fs.cpSync(sitePackages, path.join(cached, "site-packages"), { recursive: true, verbatimSymlinks: true });
    fs.writeFileSync(complete, "");

    for (const entry of fs.readdirSync(cacheRoot)) {
      if (entry !== key) fs.rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
    }
  }

  return {
    python: path.join(cached, "python", process.platform === "win32" ? "python.exe" : "bin/python3"),
    sitePackages: path.join(cached, "site-packages"),
  };
}
