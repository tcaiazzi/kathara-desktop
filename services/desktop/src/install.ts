/**
 * Auto-installs kathara-api-rest (+ its transitive kathara/uvicorn/fastapi deps) into a private
 * venv, driven from the setup page's "Install automatically" button — see prereqs.ts's
 * kathara_api check and main.ts's "status:install" handler.
 *
 * Only meaningful for a packaged app: a dev checkout already has scripts/install-<os>.{sh,ps1}
 * for this, and there is no bundled wheel to install from outside a packaged build (see
 * paths.ts's bundledWheelPath()).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { packagedVenvDir, packagedVenvPython, bundledWheelPath } from "./paths";
import { log, logRaw } from "./logger";

const STEP_TIMEOUT_MS = 5 * 60_000;

function run(command: string, args: string[]): Promise<{ ok: boolean; code: number | null }> {
  return new Promise((resolve) => {
    log(`install: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), STEP_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => logRaw(c.toString()));
    child.stderr?.on("data", (c: Buffer) => logRaw(c.toString()));
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
 * Creates <userData>/venv with `systemPython`, then pip-installs the bundled kathara-api-rest
 * wheel into it. Safe to re-run: `venv` is idempotent on an existing directory, and pip install
 * of the same wheel is a no-op.
 */
export async function runAutoInstall(systemPython: string): Promise<{ ok: boolean; error?: string }> {
  const wheel = bundledWheelPath();
  if (!wheel || !fs.existsSync(wheel)) {
    return { ok: false, error: "no bundled kathara-api-rest wheel found in this build" };
  }

  const venvStep = await run(systemPython, ["-m", "venv", packagedVenvDir()]);
  if (!venvStep.ok) return { ok: false, error: "could not create a virtual environment" };

  const venvPython = packagedVenvPython();
  if (!venvPython) return { ok: false, error: "virtual environment was created but its python is missing" };

  const upgradePip = await run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  if (!upgradePip.ok) return { ok: false, error: "could not upgrade pip in the virtual environment" };

  // Installs kathara/uvicorn[standard]/fastapi/etc. too — they're already this wheel's own
  // pyproject.toml dependencies, resolved from PyPI as normal.
  const installWheel = await run(venvPython, ["-m", "pip", "install", wheel]);
  if (!installWheel.ok) return { ok: false, error: "pip install of kathara-api-rest failed" };

  log("install: kathara-api-rest installed successfully");
  return { ok: true };
}
