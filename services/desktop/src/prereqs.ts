/**
 * Startup prerequisite checks.
 *
 * The desktop app deliberately does not bundle Docker: it drives whatever is installed on the
 * machine. Python is different: a packaged build ships its own interpreter (bundledPythonPath(),
 * a python-build-standalone build carrying no packages of its own) plus kathara-api-rest's wheel,
 * and installs kathara/uvicorn/etc. into that interpreter itself (see install.ts, which main.ts
 * runs automatically the moment these checks find nothing missing but packages) — so a packaged
 * app never actually requires a system Python, only Docker. A dev checkout has neither the
 * bundled interpreter nor the wheel, so there a missing package is still the user's to install,
 * and each check reports a remedy they can act on instead of a blank window.
 */
import { execFile } from "node:child_process";
import { app } from "electron";
import { bundledPythonPath, bundledWheelVersion, devVenvPython, packagedVenvPython } from "./paths";
import { readPrefs } from "./prefs";
import { isPlainAbsolutePath } from "./safety";
import { log } from "./logger";

export interface Check {
  id: "docker" | "python" | "kathara" | "kathara_api" | "dependencies" | "uvicorn" | "frontend";
  label: string;
  ok: boolean;
  /** What was found (a version) or what went wrong. */
  detail: string;
  /** Shown only when !ok: what the user should do about it. */
  remedy?: string;
  docsUrl?: string;
  /**
   * Only meaningful when `!ok`. Absent (equivalent to `"blocking"`) for every check except a
   * Docker daemon that is installed but not answering: the app can't fix that for the user, but
   * it also doesn't need Docker to boot — see Preflight.canStart. Everything else that can fail
   * here (Python, the backend's own packages, the bundled UI) really does need to be fixed before
   * there's an app to show.
   */
  severity?: "blocking" | "advisory";
}

/** Reported incrementally as runPreflight proceeds, so the setup page can show something more
 * honest than a single static "Checking prerequisites…" for up to tens of seconds. */
export interface PreflightProgress {
  /** The phase now starting. */
  phase: "docker" | "python";
  /** Every check decided so far, in display order. */
  checks: Check[];
}

export interface Preflight {
  ok: boolean;
  checks: Check[];
  /**
   * Every *blocking* check passed — the app can boot, even if `advisories` below is non-empty
   * (today, only ever a Docker daemon that's installed but not running). main.ts gates startup on
   * this, not on `ok`: `ok` still means "every check, no exceptions" for callers (isStale, the
   * setup page) that care about the literal all-green state.
   */
  canStart: boolean;
  /** The checks that failed but didn't block startup (severity: "advisory"), for the renderer to
   * warn about once the app is up. Always a subset of `checks`. */
  advisories: Check[];
  /** The interpreter that satisfied the Python checks, to launch the backend with. Set once
   * `canStart`, not only once `ok` — see above. */
  python?: string;
  /**
   * The Python 3.10+ interpreter found, if any — set even when kathara_api/kathara/uvicorn are
   * missing (unlike `python` above, which requires every check to pass). This is what install.ts's
   * runAutoInstall installs with (and, on the fallback path, creates its venv with).
   */
  systemPython?: string;
  /**
   * Every check passed, but on an environment the *app itself* owns (the bundled interpreter or
   * its private venv) carrying a different kathara-api-rest version than this build ships.
   *
   * The case this exists for: an app update replaces the bundled interpreter, packages and all,
   * while the private venv beside it survives — so the previous release's backend is sitting
   * there, complete and importable, ready to be picked and paired with the new frontend. Nothing
   * else notices, because "works" and "is the version this app shipped" are different questions.
   * main.ts reinstalls once when this is set, and carries on with what's there if that fails —
   * a version-skewed backend still beats no app. An interpreter the *user* pointed at is never
   * reported stale: that choice is deliberate (a checkout under active development, typically)
   * and outranks the shipped wheel by design.
   */
  stale?: boolean;
  /**
   * `python`/`systemPython` names an environment this app itself manages — the bundled
   * interpreter or its private venv — as opposed to one a user pointed at ("Choose Python
   * interpreter…") or a dev checkout's own venv/PATH Python. main.ts only ever force-reinstalls
   * (on `stale`, or on a rebuilt backend wheel — see prefs.ts's `installedBackendFingerprint`)
   * when this is true: doing so over a user's own chosen interpreter would silently overwrite an
   * environment they're actively developing against.
   */
  appOwned: boolean;
}

const EXEC_TIMEOUT_MS = 15_000;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the executable itself could not be found — a different problem from a failure. */
  missing: boolean;
}

function run(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number"
        ? ((err as { code: number }).code)
        : err
          ? null
          : 0;
      resolve({
        code,
        stdout: String(stdout),
        stderr: String(stderr),
        missing: Boolean(err && (err as { code?: unknown }).code === "ENOENT"),
      });
    });
  });
}

const DOCKER_URL = "https://docs.docker.com/get-docker/";
const KATHARA_URL = "https://www.kathara.org/download.html";

/** "Docker Desktop" on macOS/Windows, "Docker Engine" on Linux — the two are installed and
 * started differently enough that naming both every time (the old wording) just made the reader
 * find the sentence that actually applies to them. */
const DOCKER_PRODUCT_NAME =
  process.platform === "darwin" || process.platform === "win32" ? "Docker Desktop" : "Docker Engine";

/** The three-way answer `docker info` can give — "ok" isn't in `Check`'s vocabulary, so this is
 * the shape the renderer's on-demand recheck (main.ts's "docker:check") hands back too, letting
 * it reuse the exact same remedy copy without re-deriving it from a `Check`. */
export type DockerState = "ok" | "stopped" | "missing";

export interface DockerStatus {
  state: DockerState;
  /** A version when ok; the daemon's/CLI's own first error line otherwise. */
  detail: string;
  /** Set unless state === "ok". */
  remedy?: string;
  docsUrl?: string;
}

export async function checkDockerStatus(): Promise<DockerStatus> {
  // `docker info` (not `docker --version`) because it round-trips to the daemon: the CLI being
  // installed says nothing about whether anything can actually be deployed.
  const res = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (res.missing) {
    return {
      state: "missing",
      detail: "The docker command was not found on PATH.",
      remedy: `Install ${DOCKER_PRODUCT_NAME}, start it, then choose “Check again”.`,
      docsUrl: DOCKER_URL,
    };
  }
  if (res.code !== 0) {
    // Installed but unreachable — a different remedy from "not installed", so say which.
    return {
      state: "stopped",
      detail: (res.stderr.trim() || "docker info failed").split("\n")[0],
      // No "then choose Check again" here — unlike "missing" below, this state never strands the
      // user on a page with only a manual retry button: it's advisory (Preflight.canStart treats
      // it as non-blocking), so the app is already open, and DockerStatusContext.tsx polls this
      // same check in the background and clears the warning on its own once Docker answers.
      remedy:
        process.platform === "darwin" || process.platform === "win32"
          ? `Docker is installed but not running. Open ${DOCKER_PRODUCT_NAME} and wait for it to ` +
            "finish starting — Kathara Desktop will notice automatically."
          : "Docker is installed but not answering. Start it — “sudo systemctl start docker” — " +
            "and make sure your user is in the “docker” group. Kathara Desktop will notice " +
            "automatically once it does.",
      docsUrl: DOCKER_URL,
    };
  }
  return { state: "ok", detail: `daemon ${res.stdout.trim()}` };
}

/** Maps the raw probe onto a `Check` for the preflight ladder. Only `"stopped"` is `"advisory"`:
 * the app can't start Docker for the user either way, but a daemon that's merely not running yet
 * doesn't need to keep the app off-screen the way a genuinely missing install still should (the
 * setup page's install link and docs are the whole value in that case). */
function dockerCheck(status: DockerStatus): Check {
  return {
    id: "docker",
    label: "Docker",
    ok: status.state === "ok",
    detail: status.detail,
    remedy: status.remedy,
    docsUrl: status.docsUrl,
    severity: status.state === "stopped" ? "advisory" : undefined,
  };
}

/**
 * One interpreter probe, in one subprocess: version plus the imports that matter. Doing it in a
 * single spawn keeps startup fast and, more importantly, guarantees every answer comes from the
 * *same* interpreter — probing them separately could mix two Pythons.
 *
 * The last entry is the one that mirrors what the backend really does: `kathara_api` alone only
 * touches src/kathara_api/__init__.py (a version string), while uvicorn imports
 * `kathara_api.main`, which drags in the whole dependency closure — fastapi, Kathara, fs,
 * chardet, httpx. Those two come apart on any environment installed before a dependency was
 * declared: the package imports, the app doesn't, and without this the app passed preflight and
 * then died with a bare ModuleNotFoundError traceback in the log.
 */
const PROBE = `
import json, sys
out = {"python": "%d.%d.%d" % sys.version_info[:3]}
for key, expr in (
    ("kathara_api", "import kathara_api; v = kathara_api.__version__"),
    ("kathara", "from Kathara.version import CURRENT_VERSION as v"),
    ("uvicorn", "import uvicorn; v = uvicorn.__version__"),
    ("dependencies", "import kathara_api.main; v = 'satisfied'"),
):
    scope = {}
    try:
        exec(expr, scope)
        out[key] = str(scope.get("v", "present"))
    except Exception as exc:
        out[key + "_error"] = "%s: %s" % (type(exc).__name__, exc)
print(json.dumps(out))
`.trim();

interface Probe {
  python: string;
  kathara_api?: string;
  kathara?: string;
  uvicorn?: string;
  dependencies?: string;
  kathara_api_error?: string;
  kathara_error?: string;
  uvicorn_error?: string;
  dependencies_error?: string;
}

async function probe(interpreter: string): Promise<Probe | null> {
  const res = await run(interpreter, ["-c", PROBE]);
  if (res.missing || res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop() ?? "") as Probe;
  } catch {
    return null;
  }
}

function atLeast310(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 10);
}

/**
 * Interpreters to try, best first: an explicit user choice always wins, then a dev checkout's
 * virtualenv, then a packaged app's own private venv, then the interpreter bundled with a
 * packaged app (so a packaged app never falls through to PATH in practice), then PATH as a last
 * resort. `py -3` is omitted because it is a launcher, not an interpreter path, and the backend
 * has to be spawned by path later anyway.
 *
 * Both of the app's own install targets are here (`packagedVenvPython()`, `bundledPythonPath()`)
 * and that is now the only thing that points the app at what it installed — main.ts deliberately
 * doesn't record it in `preferences.json`, so an automatic install never overwrites an interpreter
 * the user chose by hand. Before that, the recorded preference was the *only* route to the private
 * venv, and a preference aimed anywhere else (or a reset `preferences.json`) left a perfectly good
 * `<userData>/venv` invisible while the app asked to install what it had already installed. Both
 * come after the preference, so an explicit choice still outranks them — it only has to *work*, or
 * runPreflight falls through to these.
 */
function pythonCandidates(): string[] {
  // The recorded preference is validated, unlike the app-owned paths after it: it is the only
  // entry a hand-edited `preferences.json` controls, it outranks every other candidate, and
  // whatever wins ends up interpolated into the elevated command string on macOS/Windows (see
  // backend.ts's runElevatedNative). main.ts's `status:pick-python` validates on the way in;
  // this covers the file being written some other way.
  const preferred = readPrefs().pythonPath;
  if (preferred !== undefined && !isPlainAbsolutePath(preferred)) {
    log(`ignoring unusable pythonPath in preferences.json: ${JSON.stringify(preferred)}`);
  }
  const candidates = [
    isPlainAbsolutePath(preferred) ? preferred : undefined,
    devVenvPython(),
    packagedVenvPython(),
    bundledPythonPath(),
  ].filter((c): c is string => Boolean(c));
  candidates.push(...(process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]));
  return [...new Set(candidates)];
}

export async function runPreflight(
  frontendPresent: boolean,
  onProgress?: (p: PreflightProgress) => void,
): Promise<Preflight> {
  onProgress?.({ phase: "docker", checks: [] });
  const docker = dockerCheck(await checkDockerStatus());
  onProgress?.({ phase: "python", checks: [docker] });

  // Four tiers, best first: an interpreter the backend actually imports in *and* whose backend is
  // the one this build ships; one it imports in, but from an app-owned environment left behind by
  // an earlier release (see Preflight.stale); one that has the API package but an incomplete
  // dependency closure; and finally any usable Python at all. The last two are why this isn't a
  // single "has kathara_api" test — an interpreter whose environment predates a declared
  // dependency must lose to a complete one, and when it's all there is, reporting it lets the
  // checks below name the missing module instead of the much less useful "no Python found".
  type Found = { interpreter: string; result: Probe };
  let chosen: Found | null = null;
  let stale: Found | null = null;
  let incomplete: Found | null = null;
  let fallback: Found | null = null;

  // The two environments this app installs into itself (install.ts) — the only ones whose version
  // is the app's business — and the version it would install into them. Both empty on a dev
  // checkout, which has neither a bundled interpreter nor a wheel, so nothing is ever stale there.
  const appOwnedCandidates = [packagedVenvPython(), bundledPythonPath()].filter((c): c is string => Boolean(c));
  const shipped = bundledWheelVersion();

  for (const interpreter of pythonCandidates()) {
    const result = await probe(interpreter);
    if (!result || !atLeast310(result.python)) continue;
    if (result.kathara_api && result.dependencies) {
      if (!shipped || !appOwnedCandidates.includes(interpreter) || result.kathara_api === shipped) {
        chosen = { interpreter, result };
        break;
      }
      stale ??= { interpreter, result };
      continue;
    }
    if (result.kathara_api) incomplete ??= { interpreter, result };
    else fallback ??= { interpreter, result };
  }

  const found = chosen ?? stale ?? incomplete ?? fallback;
  const checks: Check[] = [docker];

  if (!found) {
    checks.push({
      id: "python",
      label: "Python 3.10+",
      ok: false,
      detail: `Tried: ${pythonCandidates().join(", ")}`,
      // In a packaged build this only happens if the bundled interpreter itself is missing or
      // corrupted (bundledPythonPath() didn't resolve) — a from-source/PATH Python is the fix on a
      // dev checkout, but a packaged user should reinstall rather than go hunting for python.org.
      remedy: app.isPackaged
        ? "The bundled Python interpreter is missing or damaged. Reinstall the app, or choose " +
          "“Choose Python interpreter…” to point at one already on this machine."
        : "Install Python 3.10 or newer from python.org. If you already have one " +
          "somewhere unusual, choose “Choose Python interpreter…” instead.",
      docsUrl: app.isPackaged ? undefined : "https://www.python.org/downloads/",
    });
  } else {
    const { interpreter, result } = found;
    checks.push({
      id: "python",
      label: "Python 3.10+",
      ok: true,
      detail: `${result.python} (${interpreter})`,
    });
    checks.push({
      id: "kathara_api",
      label: "kathara-api-rest",
      ok: Boolean(result.kathara_api),
      detail: result.kathara_api ?? result.kathara_api_error ?? "not importable",
      // Not on PyPI. A packaged build ships its own wheel and can install it (plus kathara/
      // uvicorn, its transitive deps) automatically — see the "Install automatically" button.
      // A dev checkout has no bundled wheel, so the fix there is still the repo's install script.
      remedy: result.kathara_api
        ? undefined
        : app.isPackaged
          ? "Choose “Install missing packages” below."
          : "Run this repo's scripts/install-<linux|macos>.sh (or install-windows.ps1) to set up a " +
            "venv with everything this app needs, then point the app at its python.",
    });
    checks.push({
      id: "kathara",
      label: "Kathara",
      ok: Boolean(result.kathara),
      detail: result.kathara ?? result.kathara_error ?? "not importable",
      remedy: result.kathara
        ? undefined
        : app.isPackaged
          ? "Choose “Install missing packages” below."
          : "Install Kathara, then retry.",
      docsUrl: result.kathara || app.isPackaged ? undefined : KATHARA_URL,
    });
    checks.push({
      id: "uvicorn",
      label: "uvicorn",
      ok: Boolean(result.uvicorn),
      detail: result.uvicorn ?? result.uvicorn_error ?? "not importable",
      remedy: result.uvicorn
        ? undefined
        : app.isPackaged
          ? "Choose “Install missing packages” below."
          : `Install it: "${interpreter} -m pip install 'uvicorn[standard]'".`,
    });
    // Only worth reporting once the three named packages are there: until then `import
    // kathara_api.main` fails on one of *them*, and this check would just repeat whichever one
    // is already marked ✕ above. Past that point it's the catch-all for every other import the
    // backend needs (fastapi, fs, chardet, httpx, …) — the ones no check names individually.
    if (result.kathara_api && result.kathara && result.uvicorn) {
      checks.push({
        id: "dependencies",
        label: "Backend dependencies",
        ok: Boolean(result.dependencies),
        detail: result.dependencies ?? result.dependencies_error ?? "not importable",
        remedy: result.dependencies
          ? undefined
          : app.isPackaged
            ? "Choose “Install missing packages” below."
            : `This interpreter's environment is missing something the backend imports. ` +
              `Reinstall the backend with its current dependencies: ` +
              `"${interpreter} -m pip install -e ." from this checkout.`,
      });
    }
  }

  checks.push({
    id: "frontend",
    label: "Bundled UI",
    ok: frontendPresent,
    detail: frontendPresent ? "present" : "services/frontend/dist not found",
    // Only reachable in a dev checkout: a packaged app always ships the build.
    remedy: frontendPresent ? undefined : "Build the frontend: npm --prefix services/frontend run build",
  });

  const ok = checks.every((c) => c.ok);
  const advisories = checks.filter((c) => !c.ok && c.severity === "advisory");
  const canStart = checks.every((c) => c.ok || c.severity === "advisory");
  const isStale = canStart && !chosen && found !== null && found === stale;
  if (isStale) {
    log(`preflight: ${found?.interpreter} carries kathara-api-rest ${found?.result.kathara_api}, this build ships ${shipped}`);
  }
  log(
    `preflight ${canStart ? "passed" : "failed"}${advisories.length ? ` (${advisories.length} advisory)` : ""}: ` +
      checks.map((c) => `${c.id}=${c.ok}`).join(" "),
  );
  return {
    ok,
    canStart,
    advisories,
    checks,
    python: canStart ? found?.interpreter : undefined,
    systemPython: found?.interpreter,
    stale: isStale,
    appOwned: found !== null && appOwnedCandidates.includes(found.interpreter),
  };
}
