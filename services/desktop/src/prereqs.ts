/**
 * Startup prerequisite checks.
 *
 * The desktop app deliberately does not bundle Python, Kathara or Docker: it drives whatever
 * is installed on the machine. That trade keeps the installer small, but it means a missing
 * dependency is the single most likely first-run failure — so each check reports a remedy the
 * user can act on, and the shell shows them instead of a blank window.
 */
import { execFile } from "node:child_process";
import { devVenvPython } from "./paths";
import { readPrefs } from "./prefs";
import { log } from "./logger";

export interface Check {
  id: "docker" | "python" | "kathara" | "kathara_api" | "uvicorn" | "frontend";
  label: string;
  ok: boolean;
  /** What was found (a version) or what went wrong. */
  detail: string;
  /** Shown only when !ok: what the user should do about it. */
  remedy?: string;
  docsUrl?: string;
}

export interface Preflight {
  ok: boolean;
  checks: Check[];
  /** The interpreter that satisfied the Python checks, to launch the backend with. */
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

async function checkDocker(): Promise<Check> {
  // `docker info` (not `docker --version`) because it round-trips to the daemon: the CLI being
  // installed says nothing about whether anything can actually be deployed.
  const res = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (res.missing) {
    return {
      id: "docker",
      label: "Docker",
      ok: false,
      detail: "The docker command was not found on PATH.",
      remedy: "Install Docker Engine (Linux) or Docker Desktop (macOS/Windows), then retry.",
      docsUrl: DOCKER_URL,
    };
  }
  if (res.code !== 0) {
    // Installed but unreachable — a different remedy from "not installed", so say which.
    return {
      id: "docker",
      label: "Docker",
      ok: false,
      detail: (res.stderr.trim() || "docker info failed").split("\n")[0],
      remedy:
        "Docker is installed but its daemon is not reachable. Start Docker (or Docker Desktop) " +
        "and make sure your user can access the Docker socket, then retry.",
      docsUrl: DOCKER_URL,
    };
  }
  return { id: "docker", label: "Docker", ok: true, detail: `daemon ${res.stdout.trim()}` };
}

/**
 * One interpreter probe, in one subprocess: version plus the three imports that matter. Doing
 * it in a single spawn keeps startup fast and, more importantly, guarantees every answer comes
 * from the *same* interpreter — probing them separately could mix two Pythons.
 */
const PROBE = `
import json, sys
out = {"python": "%d.%d.%d" % sys.version_info[:3]}
for key, expr in (
    ("kathara_api", "import kathara_api; v = kathara_api.__version__"),
    ("kathara", "from Kathara.version import CURRENT_VERSION as v"),
    ("uvicorn", "import uvicorn; v = uvicorn.__version__"),
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
  kathara_api_error?: string;
  kathara_error?: string;
  uvicorn_error?: string;
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
 * virtualenv, then PATH. `py -3` is omitted because it is a launcher, not an interpreter path,
 * and the backend has to be spawned by path later anyway.
 */
function pythonCandidates(): string[] {
  const candidates = [readPrefs().pythonPath, devVenvPython()].filter(
    (c): c is string => Boolean(c),
  );
  candidates.push(...(process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"]));
  return [...new Set(candidates)];
}

export async function runPreflight(frontendPresent: boolean): Promise<Preflight> {
  const docker = await checkDocker();

  // Prefer an interpreter that has the API package; fall back to reporting the best usable
  // Python we found, so the user is told "Python is fine, kathara-api is missing" rather than
  // the much less useful "no Python found".
  let chosen: { interpreter: string; result: Probe } | null = null;
  let fallback: { interpreter: string; result: Probe } | null = null;

  for (const interpreter of pythonCandidates()) {
    const result = await probe(interpreter);
    if (!result || !atLeast310(result.python)) continue;
    if (result.kathara_api) {
      chosen = { interpreter, result };
      break;
    }
    fallback ??= { interpreter, result };
  }

  const found = chosen ?? fallback;
  const checks: Check[] = [docker];

  if (!found) {
    checks.push({
      id: "python",
      label: "Python 3.10+",
      ok: false,
      detail: `Tried: ${pythonCandidates().join(", ")}`,
      remedy: "Install Python 3.10 or newer, or point the app at an interpreter with " +
        "“Choose Python interpreter…”.",
      docsUrl: "https://www.python.org/downloads/",
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
      // Not on PyPI — it only exists in this checkout, so the fix is running the repo's own
      // install script (scripts/install-<os>.{sh,ps1}), not a pip install of a package name
      // that doesn't exist anywhere to install from.
      remedy: result.kathara_api
        ? undefined
        : "Run this repo's scripts/install-<linux|macos>.sh (or install-windows.ps1) to set up a " +
          "venv with everything this app needs, then point the app at its python.",
    });
    checks.push({
      id: "kathara",
      label: "Kathara",
      ok: Boolean(result.kathara),
      detail: result.kathara ?? result.kathara_error ?? "not importable",
      remedy: result.kathara ? undefined : "Install Kathara, then retry.",
      docsUrl: result.kathara ? undefined : KATHARA_URL,
    });
    checks.push({
      id: "uvicorn",
      label: "uvicorn",
      ok: Boolean(result.uvicorn),
      detail: result.uvicorn ?? result.uvicorn_error ?? "not importable",
      remedy: result.uvicorn ? undefined : `Install it: "${interpreter} -m pip install 'uvicorn[standard]'".`,
    });
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
  log(`preflight ${ok ? "passed" : "failed"}: ${checks.map((c) => `${c.id}=${c.ok}`).join(" ")}`);
  return { ok, checks, python: ok ? found?.interpreter : undefined };
}
