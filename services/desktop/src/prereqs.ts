/**
 * Startup prerequisite checks.
 *
 * The desktop app deliberately does not bundle Docker: it drives whatever is installed on the
 * machine. Python is the opposite — a packaged build ships a complete, ready-to-run environment:
 * its own interpreter (bundledPythonPath()) plus the entire backend dependency closure installed
 * for that exact platform at build time (bundledSitePackages()). So in a packaged app these
 * checks no longer decide *which* Python to use, and never install anything: there is exactly one
 * interpreter, it needs no network, and a failure here means the installation is damaged rather
 * than incomplete.
 *
 * A dev checkout is the only place any of this is still a search: there the environment is the
 * developer's own (<repo>/.venv, or PATH), a missing package is theirs to install, and each check
 * reports a remedy they can act on instead of a blank window.
 */
import { execFile } from "node:child_process";
import { app } from "electron";
import { pythonEnv } from "./backend";
import { bundledPythonPath, devVenvPython } from "./paths";
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
   * this, not on `ok`: `ok` still means "every check, no exceptions" for the setup page, which
   * cares about the literal all-green state.
   */
  canStart: boolean;
  /** The checks that failed but didn't block startup (severity: "advisory"), for the renderer to
   * warn about once the app is up. Always a subset of `checks`. */
  advisories: Check[];
  /** The interpreter that satisfied the Python checks, to launch the backend with. Set once
   * `canStart`, not only once `ok` — see above. */
  python?: string;
}

const EXEC_TIMEOUT_MS = 15_000;

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the executable itself could not be found — a different problem from a failure. */
  missing: boolean;
}

function run(file: string, args: string[], extraEnv?: Record<string, string>): Promise<ExecResult> {
  return new Promise((resolve) => {
    const options = {
      timeout: EXEC_TIMEOUT_MS,
      windowsHide: true,
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    };
    execFile(file, args, options, (err, stdout, stderr) => {
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

/** A packaged app ships every Python package the backend imports, installed at build time. If one
 * of them is missing at runtime, nothing the user can do from inside the app will conjure it back
 * — there is no install step left to re-run — so every such check points at the same fix. */
const DAMAGED_INSTALL_REMEDY =
  "This app's bundled Python environment is incomplete. Reinstall the app to restore it.";

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
  // Under exactly the environment the backend will get — in a packaged app the modules live on
  // PYTHONPATH (backend.ts's pythonEnv()), not in the interpreter's own site-packages, so a probe
  // without it would report every single backend import as missing.
  const res = await run(interpreter, ["-c", PROBE], pythonEnv());
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
 * Interpreters to try, best first.
 *
 * A packaged app has exactly one and no fallbacks: the interpreter shipped inside it, with the
 * dependency closure shipped beside it. Deliberately not a list — there is nothing to fall back
 * *to* that would be an improvement. A system Python on PATH would be missing the backend's
 * packages; a user-nominated one would be an interpreter whose contents the app cannot vouch for,
 * and pointing at a stale one is exactly how a packaged build ends up dying with a bare
 * ModuleNotFoundError. If the bundled interpreter is gone, the installation is damaged and
 * reinstalling is the honest answer.
 *
 * A dev checkout keeps the search, because there the environment genuinely is the developer's:
 * the repo's own virtualenv first (what scripts/install-<os>.{sh,ps1} create), then PATH. `py -3`
 * is omitted because it is a launcher, not an interpreter path, and the backend has to be spawned
 * by path later anyway.
 */
function pythonCandidates(): string[] {
  if (app.isPackaged) {
    const bundled = bundledPythonPath();
    return bundled ? [bundled] : [];
  }
  const candidates = [devVenvPython()].filter((c): c is string => Boolean(c));
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

  // Three tiers, best first: an interpreter the backend actually imports in; one that has the API
  // package but an incomplete dependency closure; and finally any usable Python at all. The last
  // two are why this isn't a single "has kathara_api" test — an environment that predates a
  // declared dependency must lose to a complete one, and when it's all there is, reporting it
  // lets the checks below name the missing module instead of the much less useful "no Python
  // found". A packaged app only ever has one candidate, so this ladder is really about a dev
  // checkout with more than one environment lying around.
  type Found = { interpreter: string; result: Probe };
  let chosen: Found | null = null;
  let incomplete: Found | null = null;
  let fallback: Found | null = null;

  for (const interpreter of pythonCandidates()) {
    const result = await probe(interpreter);
    if (!result || !atLeast310(result.python)) continue;
    if (result.kathara_api && result.dependencies) {
      chosen = { interpreter, result };
      break;
    }
    if (result.kathara_api) incomplete ??= { interpreter, result };
    else fallback ??= { interpreter, result };
  }

  const found = chosen ?? incomplete ?? fallback;
  const checks: Check[] = [docker];

  if (!found) {
    checks.push({
      id: "python",
      label: "Python 3.10+",
      ok: false,
      detail: `Tried: ${pythonCandidates().join(", ")}`,
      // In a packaged build this only happens if the bundled interpreter itself is missing or
      // corrupted (bundledPythonPath() didn't resolve) — a from-source/PATH Python is the fix on a
      // dev checkout, but a packaged user has no other interpreter to be pointed at: the backend's
      // packages are shipped for this one specifically.
      remedy: app.isPackaged
        ? "The Python environment bundled with this app is missing or damaged. Reinstall the app."
        : "Install Python 3.10 or newer from python.org, then run this repo's " +
          "scripts/install-<linux|macos>.sh (or install-windows.ps1).",
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
      // A packaged build ships this (and kathara/uvicorn, its transitive deps) already installed
      // beside the interpreter, so its absence means a damaged installation rather than a missing
      // step. A dev checkout installs from source instead.
      remedy: result.kathara_api
        ? undefined
        : app.isPackaged
          ? DAMAGED_INSTALL_REMEDY
          : "Run this repo's scripts/install-<linux|macos>.sh (or install-windows.ps1) to set up a " +
            "venv with everything this app needs.",
    });
    checks.push({
      id: "kathara",
      label: "Kathara",
      ok: Boolean(result.kathara),
      detail: result.kathara ?? result.kathara_error ?? "not importable",
      remedy: result.kathara
        ? undefined
        : app.isPackaged
          ? DAMAGED_INSTALL_REMEDY
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
          ? DAMAGED_INSTALL_REMEDY
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
            ? DAMAGED_INSTALL_REMEDY
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
  };
}
