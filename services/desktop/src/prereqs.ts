/**
 * Startup prerequisite checks.
 *
 * The desktop app deliberately does not bundle Python or Docker: it drives whatever is installed
 * on the machine. Kathara/uvicorn/kathara-api-rest are different — a packaged build ships
 * kathara-api-rest's own wheel and can install all three into a private venv itself (see
 * install.ts, driven from the setup page's "Install automatically" button); only Python and
 * Docker remain things the user installs. A missing dependency is still the most likely first-run
 * failure, so each check reports a remedy the user can act on instead of a blank window.
 */
import { execFile } from "node:child_process";
import { app } from "electron";
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
  /** The interpreter that satisfied the Python checks, to launch the backend with. */
  python?: string;
  /**
   * The Python 3.10+ interpreter found, if any — set even when kathara_api/kathara/uvicorn are
   * missing (unlike `python` above, which requires every check to pass). This is what a packaged
   * app's "Install automatically" button (install.ts's runAutoInstall) creates a venv with.
   */
  systemPython?: string;
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
      remedy: "Install Docker Desktop (macOS, Windows) or Docker Engine (Linux), start it, " +
        "then choose “Check again”.",
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
        "Docker is installed but not answering. Start Docker Desktop — on Linux, run " +
        "“sudo systemctl start docker” — and make sure your user is in the “docker” group. " +
        "Then choose “Check again”.",
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

export async function runPreflight(
  frontendPresent: boolean,
  onProgress?: (p: PreflightProgress) => void,
): Promise<Preflight> {
  onProgress?.({ phase: "docker", checks: [] });
  const docker = await checkDocker();
  onProgress?.({ phase: "python", checks: [docker] });

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
      remedy: "Install Python 3.10 or newer from python.org. If you already have one " +
        "somewhere unusual, choose “Choose Python interpreter…” instead.",
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
  return { ok, checks, python: ok ? found?.interpreter : undefined, systemPython: found?.interpreter };
}
