/**
 * Owns the Kathara REST API child process.
 *
 * The renderer loads the backend's own HTTP origin rather than a file:// page, because the
 * frontend's whole transport layer assumes same-origin relative URLs: "/api" fetches, a
 * WebSocket URL built from window.location.host, a relative EventSource, and BrowserRouter
 * deep links. Serving the SPA from the backend (KATHARA_API_STATIC_DIR, see
 * src/kathara_api/spa.py) keeps all of that working untouched.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import { backendSrcDir, labsDir, logFile } from "./paths";
import { log, logRaw } from "./logger";

export interface BackendHandle {
  port: number;
  baseUrl: string;
}

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 250;
const SIGTERM_GRACE_MS = 5_000;

let child: ChildProcess | null = null;
let handle: BackendHandle | null = null;
/** Set during an intentional stop, so an exit then isn't reported as a crash. */
let stopping = false;
let exitListener: ((info: { code: number | null; signal: string | null }) => void) | null = null;

/**
 * Ask the OS for an unused port and hand it to the child. Listening on 0 and reading back the
 * assigned port leaves a tiny race before the child binds it, but it beats hardcoding 8000,
 * which collides with the very common case of a backend the user already has running.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

async function waitForHealth(baseUrl: string, deadline: number): Promise<void> {
  let lastError = "no response";
  while (Date.now() < deadline) {
    // A crash during startup means health will never come up; fail immediately with the
    // traceback rather than burning the full timeout on a dead process.
    if (!child || child.exitCode !== null) {
      throw new Error(`backend exited during startup (code ${child?.exitCode ?? "unknown"})`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`backend did not become healthy within ${HEALTH_TIMEOUT_MS}ms (${lastError})`);
}

export async function startBackend(python: string, staticDir: string): Promise<BackendHandle> {
  if (handle) return handle;

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const labs = labsDir();
  fs.mkdirSync(labs, { recursive: true });

  const srcDir = backendSrcDir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // The app's default is 0.0.0.0 (src/kathara_api/config.py); a desktop app must not put its
    // backend — which can execute commands in containers — on the LAN.
    KATHARA_API_HOST: "127.0.0.1",
    KATHARA_API_PORT: String(port),
    KATHARA_API_STATIC_DIR: staticDir,
    KATHARA_API_LABS_DIR: labs,
    PYTHONUNBUFFERED: "1",
    ...(srcDir ? { PYTHONPATH: [srcDir, process.env.PYTHONPATH].filter(Boolean).join(":") } : {}),
  };

  // Explicit --host/--port as well as the env vars: uvicorn's CLI wins over settings, so the
  // port we probed is the port it binds even if a stray .env sets another one.
  const args = [
    "-m", "uvicorn", "kathara_api.main:create_app",
    "--factory",
    "--host", "127.0.0.1",
    "--port", String(port),
  ];

  log(`starting backend: ${python} ${args.join(" ")}`);
  log(`  labs dir: ${labs}`);
  log(`  static dir: ${staticDir}`);

  stopping = false;
  child = spawn(python, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout?.on("data", (c: Buffer) => logRaw(c.toString()));
  child.stderr?.on("data", (c: Buffer) => logRaw(c.toString()));
  child.on("exit", (code, signal) => {
    log(`backend exited (code=${code} signal=${signal})`);
    const wasStopping = stopping;
    child = null;
    handle = null;
    if (!wasStopping) exitListener?.({ code, signal });
  });

  try {
    await waitForHealth(baseUrl, Date.now() + HEALTH_TIMEOUT_MS);
  } catch (err) {
    await stopBackend();
    throw err;
  }

  log(`backend healthy at ${baseUrl}`);
  handle = { port, baseUrl };
  return handle;
}

/** Notified only on an *unexpected* exit, so the shell can show the log instead of a blank page. */
export function onBackendExit(cb: (info: { code: number | null; signal: string | null }) => void): void {
  exitListener = cb;
}

export function backendUrl(): string | null {
  return handle?.baseUrl ?? null;
}

export async function stopBackend(): Promise<void> {
  const proc = child;
  if (!proc || proc.exitCode !== null) {
    child = null;
    handle = null;
    return;
  }
  stopping = true;
  const { pid } = proc;
  log(`stopping backend (pid ${pid})`);

  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));

  if (process.platform === "win32" && pid) {
    // Windows has no SIGTERM to deliver: signals are emulated and are not delivered to the
    // process tree, so uvicorn (and any worker it spawned) would survive a kill() here.
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  } else {
    proc.kill("SIGTERM");
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), SIGTERM_GRACE_MS)),
  ]);
  if (timedOut) {
    log("backend did not exit on SIGTERM; sending SIGKILL");
    proc.kill("SIGKILL");
    await exited;
  }

  child = null;
  handle = null;
}

export function backendLogPath(): string {
  return logFile();
}
