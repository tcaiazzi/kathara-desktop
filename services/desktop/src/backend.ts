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
import sudoPrompt from "@vscode/sudo-prompt";
import { backendSrcDir, labsDir, logFile } from "./paths";
import { log, logRaw } from "./logger";

export interface BackendHandle {
  port: number;
  baseUrl: string;
}

/** Why an elevated (re)start of the backend didn't produce a running, root-owned backend. */
export type ElevateFailureReason = "wrong-password" | "not-permitted" | "cancelled" | "timeout" | "error";

export type ElevateResult = { ok: true; handle: BackendHandle } | { ok: false; reason: ElevateFailureReason; message: string };

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 250;
const SIGTERM_GRACE_MS = 5_000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 2_000;

let child: ChildProcess | null = null;
let handle: BackendHandle | null = null;
/** Set during an intentional stop, so an exit then isn't reported as a crash. */
let stopping = false;
let exitListener: ((info: { code: number | null; signal: string | null }) => void) | null = null;

/**
 * A backend `stopBackend()` gave up on — still running (root-owned, from a failed elevated
 * stop), but neither signalable (EPERM across the privilege boundary) nor, for the native-prompt
 * path, ever having had a process handle to signal in the first place. Kept so the next backend
 * start retries shutting it down first, instead of silently leaving it running forever while a
 * second backend starts on a different port right alongside it.
 */
let orphanedBackend: { pid: number | null; baseUrl: string } | null = null;
/** Notified once, at the moment a backend is first determined to be such an orphan — not again
 * on every later retry failure, so the caller can surface it to the user without spamming. */
let orphanListener: ((info: { pid: number | null; baseUrl: string }) => void) | null = null;

export function onOrphanedBackend(cb: (info: { pid: number | null; baseUrl: string }) => void): void {
  orphanListener = cb;
}

export function getOrphanedBackend(): { pid: number | null; baseUrl: string } | null {
  return orphanedBackend;
}

/** Records a backend `stopBackend()` couldn't stop, if there's a URL to retry shutting it down
 * against later (an unsignalable process we never even confirmed a URL for isn't worth tracking —
 * there's nothing left to do with it). Always notifies, since even an unrecoverable orphan is
 * worth telling the user about. */
function markOrphaned(pid: number | null | undefined, baseUrl: string | undefined): void {
  const normalizedPid = pid ?? null;
  if (baseUrl) orphanedBackend = { pid: normalizedPid, baseUrl };
  orphanListener?.({ pid: normalizedPid, baseUrl: baseUrl ?? "" });
}

/**
 * Poll `/api/health` until it stops responding (the backend has actually exited) or `deadline`
 * passes. Needed wherever a shutdown is confirmed with no process handle to check `exitCode`
 * against: an HTTP 200 from `/api/system/shutdown` only proves the process *received* the
 * request (it calls `os.kill(os.getpid(), SIGTERM)` and returns immediately) — SIGTERM handling
 * and process teardown still happen asynchronously afterward, so a prompt response is not itself
 * proof the process is actually gone.
 */
async function waitForDeath(baseUrl: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true; // connection refused/reset, or timed out talking to it — it's down.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Retries shutting down a previously orphaned backend before a new one starts on top of it —
 * whatever kept it unsignalable/unresponsive (a stuck operation, elevation still settling) may
 * have resolved since. Never blocks starting the new backend either way: this is best-effort, not
 * a precondition, since the app must not be left without a working backend over an old one that
 * may in fact never come back. */
async function retryOrphanShutdown(): Promise<void> {
  const orphan = orphanedBackend;
  if (!orphan) return;
  log(`retrying shutdown of previously orphaned backend at ${orphan.baseUrl}`);
  try {
    await fetch(`${orphan.baseUrl}/api/system/shutdown`, { method: "POST", signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS) });
    if (await waitForDeath(orphan.baseUrl, Date.now() + SHUTDOWN_HTTP_TIMEOUT_MS * 2)) {
      log(`orphaned backend at ${orphan.baseUrl} is now stopped`);
      orphanedBackend = null;
      return;
    }
  } catch (err) {
    log(`retrying shutdown of orphaned backend failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`orphaned backend at ${orphan.baseUrl} is still running — a new backend will start on a different port`);
}

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

/**
 * `isAlive` defaults to checking the tracked `child` — the normal and Linux-elevated paths always
 * have one. The native (macOS/Windows) elevation path doesn't: `@vscode/sudo-prompt` returns no
 * process handle at all, so its caller passes a substitute liveness check instead.
 */
export async function waitForHealth(
  baseUrl: string,
  deadline: number,
  isAlive: () => boolean = () => !!child && child.exitCode === null,
): Promise<void> {
  let lastError = "no response";
  while (Date.now() < deadline) {
    // A crash during startup means health will never come up; fail immediately with the
    // traceback rather than burning the full timeout on a dead process.
    if (!isAlive()) {
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

interface BackendCommand {
  port: number;
  baseUrl: string;
  labs: string;
  /** Full environment (inherited `process.env` plus `appEnv`) — what a plain, non-elevated
   * `spawn()` gets via its own `options.env`, which Node passes straight to the child. */
  env: NodeJS.ProcessEnv;
  /** Just this app's own overrides, without the inherited spread. `sudo` resets the environment
   * for the command it elevates by default (the near-universal `env_reset` sudoers setting) —
   * setting these on the *sudo* process's own env (via `env` above) does not make them reach the
   * elevated child at all, so the elevated start paths must force them through some other way
   * (an `env VAR=val ...` prefix on Linux, `sudo-prompt`'s own `options.env` on macOS/Windows)
   * using exactly this smaller set, not the full inherited environment. */
  appEnv: Record<string, string>;
  args: string[];
}

/** Everything about *what* to run is shared between the normal and elevated start paths — only
 * *how* it's spawned (plain vs. wrapped in `sudo`) differs. Also the one chokepoint all three
 * spawn paths (startBackend, startBackendElevatedLinux, startBackendElevatedNative) share, so
 * it's where a previously orphaned backend gets one more chance to shut down before a fresh one
 * starts alongside it. */
async function buildBackendCommand(staticDir: string): Promise<BackendCommand> {
  if (orphanedBackend) await retryOrphanShutdown();

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const labs = labsDir();
  fs.mkdirSync(labs, { recursive: true });

  const srcDir = backendSrcDir();
  const appEnv: Record<string, string> = {
    // The app's default is 0.0.0.0 (src/kathara_api/config.py); a desktop app must not put its
    // backend — which can execute commands in containers — on the LAN.
    KATHARA_API_HOST: "127.0.0.1",
    KATHARA_API_PORT: String(port),
    KATHARA_API_STATIC_DIR: staticDir,
    KATHARA_API_LABS_DIR: labs,
    PYTHONUNBUFFERED: "1",
    ...(srcDir ? { PYTHONPATH: [srcDir, process.env.PYTHONPATH].filter(Boolean).join(":") } : {}),
  };
  const env: NodeJS.ProcessEnv = { ...process.env, ...appEnv };

  // Explicit --host/--port as well as the env vars: uvicorn's CLI wins over settings, so the
  // port we probed is the port it binds even if a stray .env sets another one.
  const args = [
    "-m", "uvicorn", "kathara_api.main:create_app",
    "--factory",
    "--host", "127.0.0.1",
    "--port", String(port),
  ];

  return { port, baseUrl, labs, env, appEnv, args };
}

/** Wires the same stdout/stderr logging and exit bookkeeping onto any freshly spawned backend
 * child, elevated or not, and installs it as the tracked `child`. */
function trackChild(proc: ChildProcess): void {
  stopping = false;
  child = proc;
  proc.stdout?.on("data", (c: Buffer) => logRaw(c.toString()));
  proc.stderr?.on("data", (c: Buffer) => logRaw(c.toString()));
  proc.on("exit", (code, signal) => {
    log(`backend exited (code=${code} signal=${signal})`);
    const wasStopping = stopping;
    child = null;
    handle = null;
    if (!wasStopping) exitListener?.({ code, signal });
  });
}

export async function startBackend(python: string, staticDir: string): Promise<BackendHandle> {
  if (handle) return handle;

  const { port, baseUrl, labs, env, args } = await buildBackendCommand(staticDir);
  log(`starting backend: ${python} ${args.join(" ")}`);
  log(`  labs dir: ${labs}`);
  log(`  static dir: ${staticDir}`);

  trackChild(spawn(python, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));

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

// Substrings sudo itself prints to stderr on auth failure (GNU sudo, `-S`/stdin password). Sniffed
// so a bad password can be reported distinctly from any other startup failure instead of just a
// generic timeout — `-S` reads one line from stdin and, since we close stdin after writing it,
// sudo cannot re-prompt and fails fast rather than hanging.
const SUDO_WRONG_PASSWORD_MARKERS = ["Sorry, try again", "incorrect password attempt", "1 incorrect password attempt"];
const SUDO_NOT_PERMITTED_MARKERS = ["is not in the sudoers file", "not allowed to execute"];

/**
 * Linux only: kill the current backend and relaunch it under `sudo`, feeding `password` on
 * stdin. Kathara's own privileged-device gate (`Kathara.utils.is_admin()`) checks the process's
 * *real* UID, so this is the only way to satisfy it — there is no in-place elevation of an
 * already-running process.
 *
 * On any failure this falls back to restarting the normal unprivileged backend, so the app is
 * never left without one just because a password was mistyped.
 */
export async function startBackendElevatedLinux(python: string, staticDir: string, password: string): Promise<ElevateResult> {
  await stopBackend();

  const { port, baseUrl, labs, env, appEnv, args } = await buildBackendCommand(staticDir);

  // `sudo` resets the environment for the command it elevates by default (env_reset) — setting
  // KATHARA_API_STATIC_DIR/LABS_DIR etc. via `options.env` above only reaches the `sudo` process
  // itself, not the `python` it execs as root, so the SPA mount and labs directory would silently
  // fall back to defaults. Force them through explicitly via a coreutils `env` prefix, which sets
  // them directly on the command `sudo` elevates, independent of the system's sudoers env policy.
  const envArgs = Object.entries(appEnv).map(([k, v]) => `${k}=${v}`);
  log(`starting elevated backend: sudo env ${envArgs.join(" ")} ${python} ${args.join(" ")}`);
  log(`  labs dir: ${labs}`);
  log(`  static dir: ${staticDir}`);

  const proc = spawn("sudo", ["-S", "-k", "env", ...envArgs, python, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderrBuf = "";
  proc.stderr?.on("data", (c: Buffer) => {
    stderrBuf += c.toString();
  });
  trackChild(proc);
  proc.stdin?.write(`${password}\n`);
  proc.stdin?.end();

  try {
    await waitForHealth(baseUrl, Date.now() + HEALTH_TIMEOUT_MS);

    // Health-ok only proves *some* process is listening — confirm it's actually the elevated one.
    const info = await fetch(`${baseUrl}/api/system`).then((r) => r.json());
    if (!info.is_admin) {
      throw new Error("backend started but is not running as root");
    }

    log(`elevated backend healthy at ${baseUrl}`);
    handle = { port, baseUrl };
    return { ok: true, handle };
  } catch (err) {
    await stopBackend();
    const message = err instanceof Error ? err.message : String(err);
    let reason: ElevateFailureReason = "error";
    if (SUDO_WRONG_PASSWORD_MARKERS.some((m) => stderrBuf.includes(m))) reason = "wrong-password";
    else if (SUDO_NOT_PERMITTED_MARKERS.some((m) => stderrBuf.includes(m))) reason = "not-permitted";
    else if (message.includes("did not become healthy")) reason = "timeout";
    log(`elevated backend start failed (${reason}): ${message}${stderrBuf ? ` — stderr: ${stderrBuf.trim()}` : ""}`);

    // Never leave the app without a running backend just because elevation failed.
    await startBackend(python, staticDir);
    return { ok: false, reason, message };
  }
}

/** Best-effort double-quoting for the single shell-command-string API `@vscode/sudo-prompt`
 * expects — not a full POSIX/cmd.exe-correct shell parser, but sufficient for the plain
 * filesystem paths and flags this app's own command line is built from. */
function shellQuote(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * macOS/Windows: kill the current backend and relaunch it elevated via the OS's own native
 * admin-password dialog (`@vscode/sudo-prompt`) — unlike Linux, these platforms won't let a
 * custom-styled in-app dialog collect an admin password itself.
 *
 * `sudo-prompt.exec()` returns no process handle (a documented limitation of the library, not
 * something this app can work around) and its callback only fires when the command *completes*
 * (i.e. the backend later exits) or fails to start at all — never on "started successfully" — so
 * success here is detected purely by polling `waitForHealth`, same as the other start paths.
 * Because there's no handle, `stopBackend()`'s HTTP-shutdown-first behavior is the only way this
 * app can later stop a backend started this way.
 */
export async function startBackendElevatedNative(python: string, staticDir: string): Promise<ElevateResult> {
  await stopBackend();

  const { port, baseUrl, labs, appEnv, args } = await buildBackendCommand(staticDir);
  log(`starting elevated backend (native prompt): ${python} ${args.join(" ")}`);
  log(`  labs dir: ${labs}`);
  log(`  static dir: ${staticDir}`);

  const cmd = [python, ...args].map(shellQuote).join(" ");
  stopping = false;
  let execFailure: string | null = null;
  // `appEnv`, not the full inherited environment: `options.env` here is validated against
  // POSIX-only variable-name rules and rejects the whole call on the first violation (a single
  // oddly-named inherited variable, e.g. Windows's `ProgramFiles(x86)`, would abort elevation
  // outright) — `appEnv` is already just this app's own known-safe overrides.
  sudoPrompt.exec(cmd, { name: "Kathara IDE", env: appEnv }, (error) => {
    if (!error) return;
    if (!handle) {
      // Still starting (or the prompt was dismissed/auth failed) — record it for the catch
      // block below to classify, rather than waiting out the full health timeout.
      execFailure = error.message;
    } else if (!stopping) {
      log(`elevated backend (native) exited unexpectedly: ${error.message}`);
      handle = null;
      exitListener?.({ code: null, signal: null });
    }
  });

  try {
    await waitForHealth(baseUrl, Date.now() + HEALTH_TIMEOUT_MS, () => execFailure === null);

    const info = await fetch(`${baseUrl}/api/system`).then((r) => r.json());
    if (!info.is_admin) {
      throw new Error("backend started but is not running as root");
    }

    log(`elevated backend healthy at ${baseUrl}`);
    handle = { port, baseUrl };
    return { ok: true, handle };
  } catch (err) {
    await stopBackend();
    const message = execFailure ?? (err instanceof Error ? err.message : String(err));
    // sudo-prompt doesn't distinguish "user cancelled the OS dialog" from "auth failed" in its
    // error text in a stable, cross-platform way — surfaced as a generic failure the renderer can
    // still offer to retry from, rather than guessing at a more specific reason.
    const reason: ElevateFailureReason = message.includes("did not become healthy") ? "timeout" : "cancelled";
    log(`elevated backend start failed (${reason}): ${message}`);

    await startBackend(python, staticDir);
    return { ok: false, reason, message };
  }
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
  const current = handle;
  if (!proc && !current) {
    child = null;
    handle = null;
    return;
  }
  stopping = true;
  log(`stopping backend${proc ? ` (pid ${proc.pid})` : ""}${current ? ` at ${current.baseUrl}` : ""}`);

  // Prefer asking the backend to shut itself down over HTTP: once a backend has been started
  // elevated (startBackendElevatedLinux/Native), it runs as root and this unprivileged process
  // can no longer deliver it a signal at all (kill() across that privilege boundary fails with
  // EPERM, and the native-prompt path never even has a process handle to try) — but it can still
  // reach the still-listening localhost port regardless of the backend's UID. Tried
  // unconditionally (not just for the elevated case) so there's one shutdown path to maintain;
  // it's effectively a no-op fallback-to-signal for the ordinary unprivileged backend.
  if (current) {
    try {
      await fetch(`${current.baseUrl}/api/system/shutdown`, { method: "POST", signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS) });
      if (proc && proc.exitCode === null) {
        const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
        const exitedInTime = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), SHUTDOWN_HTTP_TIMEOUT_MS)),
        ]);
        if (exitedInTime) {
          child = null;
          handle = null;
          return;
        }
      } else {
        // No local process to confirm exit against (native-elevated start, or already exited) —
        // the HTTP request above was the only lever available. A 200 here only proves the process
        // *received* it (it calls os.kill(getpid(), SIGTERM) and returns immediately), not that
        // it's actually gone yet, so poll health instead of assuming success.
        if (await waitForDeath(current.baseUrl, Date.now() + SHUTDOWN_HTTP_TIMEOUT_MS * 2)) {
          child = null;
          handle = null;
          return;
        }
        log(`backend at ${current.baseUrl} did not go down after a shutdown request`);
        markOrphaned(null, current.baseUrl);
        child = null;
        handle = null;
        return;
      }
    } catch (err) {
      log(`HTTP shutdown request failed, falling back to signal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!proc || proc.exitCode !== null) {
    log("no local backend process to signal — giving up");
    child = null;
    handle = null;
    return;
  }

  const { pid } = proc;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const knownBaseUrl = current?.baseUrl ?? handle?.baseUrl;

  if (process.platform === "win32" && pid) {
    // Windows has no SIGTERM to deliver: signals are emulated and are not delivered to the
    // process tree, so uvicorn (and any worker it spawned) would survive a kill() here.
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  } else if (!proc.kill("SIGTERM")) {
    // A root-owned process can't be signaled by this unprivileged one at all — kill() returns
    // false immediately (EPERM) rather than throwing, so check it instead of waiting out a full
    // SIGTERM_GRACE_MS (and, below, another one after an equally doomed SIGKILL) on a signal that
    // was never delivered in the first place.
    log(`SIGTERM could not be delivered to backend (pid ${pid}) — likely running elevated`);
    markOrphaned(pid, knownBaseUrl);
    child = null;
    handle = null;
    return;
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), SIGTERM_GRACE_MS)),
  ]);
  if (timedOut) {
    log("backend did not exit on SIGTERM; sending SIGKILL");
    proc.kill("SIGKILL");
    // Bounded, not `await exited` unconditionally: a backend this SIGTERM somehow reached but
    // that still won't die shouldn't hang app quit indefinitely waiting for an "exit" that may
    // never come.
    const killed = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), SIGTERM_GRACE_MS)),
    ]);
    if (!killed) {
      log(`backend (pid ${pid}) did not exit after SIGKILL`);
      markOrphaned(pid, knownBaseUrl);
    }
  }

  child = null;
  handle = null;
}

export function backendLogPath(): string {
  return logFile();
}
