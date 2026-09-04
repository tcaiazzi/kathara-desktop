/**
 * Auto-installs kathara-api-rest (+ its transitive kathara/uvicorn/fastapi deps), driven from
 * main.ts — automatically when preflight finds nothing missing but packages, and from the setup
 * page's "Install missing packages" button otherwise.
 *
 * **Where they go: into the bundled interpreter itself** (paths.ts's bundledPythonDir()), so the
 * app's Python environment is a single thing that an app update replaces wholesale — packages
 * included. The alternative, a venv under `userData`, *survives* updates, which sounds like a
 * feature and isn't: it kept the previous release's backend around for the new frontend to talk
 * to, and nothing in preflight notices a version skew. It stays as the fallback for the
 * installations where writing into the app is not on: an AppImage's read-only squashfs, a
 * root-owned /opt from the .deb/.rpm, a Program Files directory chosen in the NSIS installer, and
 * every macOS build — there the .app carries an ad-hoc signature (electron-builder.yml's
 * afterPack) whose seal covers Contents/Resources, so adding site-packages to it is what makes
 * Apple Silicon refuse to launch the app at all.
 *
 * Only meaningful for a packaged app: a dev checkout already has scripts/install-<os>.{sh,ps1}
 * for this, and there is no bundled wheel to install from outside a packaged build (see
 * paths.ts's bundledWheelPath()).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bundledPythonDir, bundledPythonPath, bundledWheelPath, packagedVenvDir, packagedVenvPython } from "./paths";
import { log, logRaw } from "./logger";

const STEP_TIMEOUT_MS = 5 * 60_000;

export type InstallStep = "prepare" | "pip" | "wheel";

/** Reported as runAutoInstall proceeds, so the setup page can show more than one static line for
 * an operation that can take several minutes. `line` carries a chunk of the running subprocess's
 * stdout/stderr verbatim, so the setup page can render a live tail of it. */
export interface InstallProgress {
  step: InstallStep;
  line?: string;
}

function run(
  command: string,
  args: string[],
  onOutput?: (chunk: string) => void,
): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolve) => {
    log(`install: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => {
      const chunk = c.toString();
      logRaw(chunk);
      onOutput?.(chunk);
    });
    child.stderr?.on("data", (c: Buffer) => {
      const chunk = c.toString();
      logRaw(chunk);
      onOutput?.(chunk);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, code: null });
    });
  });
}

/**
 * Can this process create files in `dir`? A real write, not fs.access(W_OK): on Windows that
 * only reports the read-only *attribute* and answers "yes" for a Program Files directory whose
 * ACL denies the write, which is precisely the installation this has to detect.
 */
function canWriteInto(dir: string): boolean {
  const probe = path.join(dir, ".kathara-write-probe");
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The interpreter to install into: the bundled one where that's possible (see this module's
 * header), otherwise `<userData>/venv`, created here with `systemPython` if it doesn't exist yet.
 */
async function prepareTarget(
  systemPython: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<{ python: string } | { error: string }> {
  const bundled = bundledPythonPath();
  const bundledDir = bundledPythonDir();
  // darwin is excluded outright rather than probed: /Applications is writable by an admin user,
  // so the probe would pass and the damage (an invalidated ad-hoc bundle seal) would only show
  // up as the app failing to launch afterwards.
  if (bundled && bundledDir && process.platform !== "darwin" && canWriteInto(bundledDir)) {
    // python-build-standalone's install_only builds ship pip, so this is a check, not a step that
    // does work — but it's the one thing the two later steps both assume, and a bundled
    // interpreter without it has to fall through to the venv rather than fail the whole install.
    const pip = await run(bundled, ["-m", "pip", "--version"], (line) => onProgress?.({ step: "prepare", line }));
    if (pip.ok) {
      log(`install: target is the bundled interpreter (${bundled})`);
      return { python: bundled };
    }
    log("install: the bundled interpreter has no usable pip — falling back to a private venv");
  } else {
    log("install: cannot install into the bundled interpreter — falling back to a private venv");
  }

  const venvStep = await run(systemPython, ["-m", "venv", packagedVenvDir()], (line) => onProgress?.({ step: "prepare", line }));
  if (!venvStep.ok) return { error: "could not create a virtual environment" };
  const venvPython = packagedVenvPython();
  if (!venvPython) return { error: "virtual environment was created but its python is missing" };
  log(`install: target is the private venv (${venvPython})`);
  return { python: venvPython };
}

/**
 * Installs the bundled kathara-api-rest wheel into whichever environment prepareTarget picks.
 * Safe to re-run: `venv` is idempotent on an existing directory, and pip install of the same
 * wheel is a no-op beyond re-resolving its dependencies — which is exactly what repairs an
 * environment that predates one of them.
 */
export async function runAutoInstall(
  systemPython: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const wheel = bundledWheelPath();
  if (!wheel || !fs.existsSync(wheel)) {
    return { ok: false, error: "no bundled kathara-api-rest wheel found in this build" };
  }

  onProgress?.({ step: "prepare" });
  const target = await prepareTarget(systemPython, onProgress);
  if ("error" in target) return { ok: false, error: target.error };

  // Not fatal: prepareTarget already established that pip runs, so a failure here is a slow or
  // absent network — and reporting *that* as "could not upgrade pip" would bury the real problem
  // one step before the step that states it plainly.
  onProgress?.({ step: "pip" });
  const upgradePip = await run(target.python, ["-m", "pip", "install", "--upgrade", "pip"], (line) => onProgress?.({ step: "pip", line }));
  if (!upgradePip.ok) log("install: could not upgrade pip — continuing with the one already there");

  // Installs kathara/uvicorn[standard]/fastapi/etc. too — they're already this wheel's own
  // pyproject.toml dependencies, resolved from PyPI as normal.
  onProgress?.({ step: "wheel" });
  const installWheel = await run(target.python, ["-m", "pip", "install", wheel], (line) => onProgress?.({ step: "wheel", line }));
  if (!installWheel.ok) return { ok: false, error: "pip install of kathara-api-rest failed" };

  log("install: kathara-api-rest installed successfully");
  return { ok: true };
}
