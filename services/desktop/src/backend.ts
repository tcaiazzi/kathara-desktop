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
import { readPrefs, writePrefs } from "./prefs";

export interface BackendHandle {
  port: number;
  baseUrl: string;
}

/** Why an elevated (re)start of the backend didn't produce a running, root-owned backend. */
export type ElevateFailureReason = "wrong-password" | "not-permitted" | "cancelled" | "timeout" | "error";

/** `restarted` says whether the attempt got far enough to stop the backend it was replacing.
 * When false — a password rejected before anything was torn down, or a native attempt that
 * failed alongside a still-running backend — the caller's page is still on a live origin and
 * must be left alone, so its elevation prompt can show the error and offer a retry in place.
 * When true, the backend was restarted on a *new* port and the caller has to be sent there. */
export type ElevateResult =
  | { ok: true; handle: BackendHandle }
  | { ok: false; reason: ElevateFailureReason; message: string; restarted: boolean };

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 250;
const SIGTERM_GRACE_MS = 5_000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 2_000;
/** Bounds the credentials-only `sudo -v` probe below. Generous — it's a local PAM call that
 * normally answers instantly — but finite, so a wedged PAM module can't hang the IPC call
 * that's holding the elevation prompt open. */
const SUDO_VERIFY_TIMEOUT_MS = 15_000;

let child: ChildProcess | null = null;
let handle: BackendHandle | null = null;
/** Set during an intentional stop, so an exit then isn't reported as a crash. */
let stopping = false;
/** Set while an elevated (re)start is in flight. An exit during that window is the *attempt*
 * failing — whose own catch block restarts a plain backend — not the crash of a backend that
 * was up and running, so it must not reach `exitListener` and be reported to the user as one.
 * Read at exit time, not captured, so a genuine crash of a successfully elevated backend
 * later on still reports normally. */
let elevating = false;
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

/**
 * Ask whatever is listening at `baseUrl` to shut itself down, and confirm it actually did.
 * Purely address-based — no process handle, no module state — which is what makes it usable
 * both for a previously orphaned backend and for a *candidate* backend that failed its
 * elevation checks while the real one is still running (where `stopBackend()` would stop
 * precisely the wrong process). Returns whether it's confirmed gone.
 */
async function shutdownAt(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/api/system/shutdown`, { method: "POST", signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS) });
    return await waitForDeath(baseUrl, Date.now() + SHUTDOWN_HTTP_TIMEOUT_MS * 2);
  } catch (err) {
    log(`shutdown request to ${baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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
  if (await shutdownAt(orphan.baseUrl)) {
    log(`orphaned backend at ${orphan.baseUrl} is now stopped`);
    orphanedBackend = null;
    return;
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

/** Chromium refuses to load a URL on a handful of ports (ERR_UNSAFE_PORT); ports we assign
 * ourselves via findFreePort() never land there, but a hand-edited preferences.json could. */
function isUsablePort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535;
}

/** Bind-test a specific port on the loopback interface. Racy by nature — something can take it
 * between this check and the child's own bind — which is exactly the race findFreePort() already
 * lives with; startBackend()'s retry below covers the rare loss. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

/** The port remembered from a previous successful launch, if it's still usable — otherwise null,
 * meaning "pick a fresh one". */
async function rememberedPort(): Promise<number | null> {
  const saved = readPrefs().backendPort;
  if (!isUsablePort(saved)) return null;
  if (!(await isPortFree(saved))) {
    log(`remembered port ${saved} is in use; taking a fresh one`);
    return null;
  }
  return saved;
}

/** Written only after a health check has passed — never before — and only when it changed, so a
 * normal launch that reuses the same port performs no preferences write at all. */
function rememberPort(port: number): void {
  const prefs = readPrefs();
  if (prefs.backendPort === port && (prefs.launchCount ?? 0) > 0) return;
  writePrefs({ backendPort: port, launchCount: (prefs.launchCount ?? 0) + 1 });
}

/** The remembered port turned out to be unusable after all (spawnBackend's retry path) — drop it
 * so the next launch doesn't try it again first. */
function forgetPort(): void {
  if (readPrefs().backendPort !== undefined) writePrefs({ backendPort: undefined });
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
async function buildBackendCommand(staticDir: string, preferredPort?: number): Promise<BackendCommand> {
  if (orphanedBackend) await retryOrphanShutdown();

  const port = preferredPort ?? (await findFreePort());
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
    if (!wasStopping && !elevating) exitListener?.({ code, signal });
  });
}

export async function startBackend(python: string, staticDir: string): Promise<BackendHandle> {
  if (handle) return handle;

  const remembered = await rememberedPort();
  try {
    return await spawnBackend(python, staticDir, remembered ?? (await findFreePort()));
  } catch (err) {
    // Only retry for a remembered port that turned out to be taken after all — uvicorn exits
    // immediately on EADDRINUSE, so waitForHealth's isAlive() check fails fast with this exact
    // message rather than burning the full health timeout, and this costs a fraction of a second
    // rather than 45s. Any other failure (Docker down, a bad interpreter, …) would fail again on
    // a fresh port too, so it's simply rethrown.
    if (remembered === null || !(err instanceof Error && err.message.startsWith("backend exited during startup"))) {
      throw err;
    }
    log(`backend could not use remembered port ${remembered}; retrying on a fresh port`);
    forgetPort();
    return await spawnBackend(python, staticDir, await findFreePort());
  }
}

async function spawnBackend(python: string, staticDir: string, port: number): Promise<BackendHandle> {
  const { baseUrl, labs, env, args } = await buildBackendCommand(staticDir, port);
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
  // Only after a real health check, so a port that never actually worked is never remembered.
  rememberPort(port);
  return handle;
}

// Substrings sudo itself prints to stderr when it refuses. Only used to tell "this account may
// not use sudo at all" apart from "that password was wrong" — the *fact* of a failure is taken
// from sudo's exit status, which needs no string matching. Both spawn sites force `LC_ALL=C`,
// since sudo's diagnostics are translated and these are the English ones.
const SUDO_NOT_PERMITTED_MARKERS = ["is not in the sudoers file", "not allowed to execute", "may not run sudo"];

/** `sudo`'s own messages are localized; classification below reads them, so pin them to C.
 * `SUDO_ASKPASS`/`DISPLAY` are cleared too so sudo can't decide to pop its own GUI askpass
 * dialog instead of reading the password we're feeding it on stdin. */
function sudoEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: "C", LANGUAGE: "" };
  delete env.SUDO_ASKPASS;
  delete env.DISPLAY;
  return env;
}

/**
 * Check `password` against sudo *without* running anything: `-v` only validates credentials.
 *
 * This exists so a mistyped password can be settled while the current backend is still running
 * and healthy. Elevating means stopping the backend and starting a new one on a new port — do
 * that first and a wrong password costs the user their whole session (the page ends up on a
 * dead origin, and the failed `sudo` child's exit looks exactly like a backend crash). Checking
 * first makes the overwhelmingly common failure a no-op: nothing is stopped, nothing moves, and
 * the prompt can just say the password was wrong.
 *
 * Deliberately not registered with `trackChild` — it is not a backend, and treating it as one is
 * what made a typo present itself as "The Kathara API stopped unexpectedly".
 */
async function verifySudoPassword(password: string): Promise<{ ok: true } | { ok: false; reason: ElevateFailureReason; message: string }> {
  let proc: ChildProcess;
  try {
    proc = spawn("sudo", ["-S", "-k", "-v"], { env: sudoEnv(), stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  } catch (err) {
    return { ok: false, reason: "error", message: `could not run sudo: ${err instanceof Error ? err.message : String(err)}` };
  }

  let stderrBuf = "";
  proc.stderr?.on("data", (c: Buffer) => {
    stderrBuf += c.toString();
  });
  proc.stdin?.on("error", () => {
    /* sudo can exit before the write lands (e.g. not in sudoers) — EPIPE here is not the error
     * worth reporting, the exit status below is. */
  });
  proc.stdin?.write(`${password}\n`);
  proc.stdin?.end();

  // "close", not "exit": stderr must be drained before it's classified, otherwise a genuine
  // refusal can be read while `stderrBuf` is still empty and get misfiled as a generic error.
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, SUDO_VERIFY_TIMEOUT_MS);
    proc.once("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (code === 0) return { ok: true };

  const detail = stderrBuf.trim();
  if (SUDO_NOT_PERMITTED_MARKERS.some((m) => stderrBuf.includes(m))) {
    log(`sudo password check refused: account may not use sudo${detail ? ` — ${detail}` : ""}`);
    return { ok: false, reason: "not-permitted", message: detail || "this account is not allowed to use sudo" };
  }
  if (code === null) {
    log("sudo password check did not finish in time");
    return { ok: false, reason: "timeout", message: `sudo did not respond within ${SUDO_VERIFY_TIMEOUT_MS}ms` };
  }
  // Any other non-zero exit from `sudo -v` is an authentication failure: it runs no command, so
  // there is nothing else that could have failed.
  log(`sudo password check failed (exit ${code})${detail ? ` — ${detail}` : ""}`);
  return { ok: false, reason: "wrong-password", message: detail || "incorrect password" };
}

/**
 * Linux only: kill the current backend and relaunch it under `sudo`, feeding `password` on
 * stdin. Kathara's own privileged-device gate (`Kathara.utils.is_admin()`) checks the process's
 * *real* UID, so this is the only way to satisfy it — there is no in-place elevation of an
 * already-running process.
 *
 * The password is checked with `verifySudoPassword` *before* anything is stopped, so the
 * common failure — a mistyped password — costs nothing: no restart, no port change, and the
 * caller's page stays live to offer a retry. Only a failure past that point restarts the
 * plain unprivileged backend, so the app is never left without one.
 */
export async function startBackendElevatedLinux(python: string, staticDir: string, password: string): Promise<ElevateResult> {
  // Before stopBackend(), never after: a rejected password must leave the running backend
  // exactly where it was, so the prompt can offer a retry against a still-live origin.
  const check = await verifySudoPassword(password);
  if (!check.ok) return { ...check, restarted: false };

  elevating = true;
  try {
    return await runElevatedLinux(python, staticDir, password);
  } finally {
    // Only after the catch below has restarted a plain backend, so neither the failed attempt
    // nor its recovery is reported to the user as a backend crash.
    elevating = false;
  }
}

async function runElevatedLinux(python: string, staticDir: string, password: string): Promise<ElevateResult> {
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

  const proc = spawn("sudo", ["-S", "-k", "env", ...envArgs, python, ...args], { env: sudoEnv(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
    // The password already passed `verifySudoPassword`, so this is the backend itself failing to
    // come up as root, not an auth problem — except for the sudoers case, which `-v` does not
    // cover: `-v` only asks "may this user sudo *at all*", while running a command additionally
    // consults the per-command rules, so a user allowed to sudo but not to run this one is only
    // discovered here.
    let reason: ElevateFailureReason = "error";
    if (SUDO_NOT_PERMITTED_MARKERS.some((m) => stderrBuf.includes(m))) reason = "not-permitted";
    else if (message.includes("did not become healthy")) reason = "timeout";
    log(`elevated backend start failed (${reason}): ${message}${stderrBuf ? ` — stderr: ${stderrBuf.trim()}` : ""}`);

    // Never leave the app without a running backend just because elevation failed. This binds a
    // *new* port, so the caller has to send the renderer there — hence `restarted: true`.
    await startBackend(python, staticDir);
    return { ok: false, reason, message, restarted: true };
  }
}

/** Best-effort double-quoting for the single shell-command-string API `@vscode/sudo-prompt`
 * expects — not a full POSIX/cmd.exe-correct shell parser, but sufficient for the plain
 * filesystem paths and flags this app's own command line is built from. */
function shellQuote(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * macOS/Windows: relaunch the backend elevated via the OS's own native admin-password dialog
 * (`@vscode/sudo-prompt`) — unlike Linux, these platforms won't let a custom-styled in-app
 * dialog collect an admin password itself, which also means there is no password here to check
 * up front. Instead the elevated backend is started *alongside* the current one and only
 * replaces it once it's proven healthy and root; see `runElevatedNative` for why.
 *
 * `sudo-prompt.exec()` returns no process handle (a documented limitation of the library, not
 * something this app can work around) and its callback only fires when the command *completes*
 * (i.e. the backend later exits) or fails to start at all — never on "started successfully" — so
 * success here is detected purely by polling `waitForHealth`, same as the other start paths.
 * Because there's no handle, `stopBackend()`'s HTTP-shutdown-first behavior is the only way this
 * app can later stop a backend started this way.
 */
export async function startBackendElevatedNative(python: string, staticDir: string): Promise<ElevateResult> {
  elevating = true;
  try {
    return await runElevatedNative(python, staticDir);
  } finally {
    elevating = false;
  }
}

async function runElevatedNative(python: string, staticDir: string): Promise<ElevateResult> {
  // Note the order, opposite to the Linux path: the current backend keeps running until the
  // elevated one has proved itself. The password never passes through this process — the OS
  // owns that dialog — so there is nothing to pre-check the way `verifySudoPassword` does, and
  // testing the credentials with a throwaway elevated command would cost the user a *second*
  // OS prompt for the real one. Starting first gets the same guarantee for free: a dismissed
  // dialog, a rejected password or a backend that won't boot all leave the original backend
  // untouched and still serving the renderer, so there is nothing to recover and no new port.
  //
  // Two backends therefore overlap for the duration of the health wait. They're both idle: the
  // lab whose privileged devices prompted this hasn't been deployed yet — deploying it is what
  // the elevation is *for* — so neither is touching Docker or the labs directory.
  //
  // This is only viable here because this path never calls `trackChild` (sudo-prompt hands back
  // no process handle), so it isn't competing for the single `child` slot that still refers to
  // the live backend. The Linux path does, which is why it pre-checks instead.
  const { port, baseUrl, labs, appEnv, args } = await buildBackendCommand(staticDir);
  log(`starting elevated backend (native prompt): ${python} ${args.join(" ")}`);
  log(`  labs dir: ${labs}`);
  log(`  static dir: ${staticDir}`);

  const cmd = [python, ...args].map(shellQuote).join(" ");
  // Not `handle`: that still points at the backend this one is trying to replace, so it can't
  // stand in for "the elevated one is up" the way it could when this path stopped it first.
  let started = false;
  let execFailure: string | null = null;
  // `appEnv`, not the full inherited environment: `options.env` here is validated against
  // POSIX-only variable-name rules and rejects the whole call on the first violation (a single
  // oddly-named inherited variable, e.g. Windows's `ProgramFiles(x86)`, would abort elevation
  // outright) — `appEnv` is already just this app's own known-safe overrides.
  sudoPrompt.exec(cmd, { name: "Kathara IDE", env: appEnv }, (error) => {
    if (!error) return;
    if (!started) {
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
    // Only now is the old backend expendable. `stopBackend()` clears `handle`/`stopping`, so
    // the swap has to follow it, not precede it.
    await stopBackend();
    stopping = false;
    started = true;
    handle = { port, baseUrl };
    return { ok: true, handle };
  } catch (err) {
    // Both read *before* the cleanup below: shutting the candidate down makes its own exec
    // callback fire and set `execFailure`, which would otherwise rewrite the diagnosis of why
    // this attempt failed into "the elevated command failed to launch".
    const failedToLaunch = execFailure !== null;
    const message = execFailure ?? (err instanceof Error ? err.message : String(err));

    // Emphatically not `stopBackend()`, which would stop the healthy backend that is still
    // serving the renderer. Only the candidate needs cleaning up, and only if it got as far as
    // listening at all — addressed by URL, since there's no handle for it.
    if (!failedToLaunch && !(await shutdownAt(baseUrl))) {
      log(`elevated backend at ${baseUrl} did not go down after a failed elevation`);
      markOrphaned(null, baseUrl);
    }

    // Only a failure of the `sudoPrompt.exec` call itself is an auth outcome. sudo-prompt does
    // not distinguish "user dismissed the dialog" from "password rejected" in its error text in
    // any stable, cross-platform way, so both land on "cancelled" — but a backend that *did*
    // start and then failed its checks is neither, and calling it "cancelled" would tell the
    // user they clicked Cancel when they didn't.
    let reason: ElevateFailureReason = "error";
    if (failedToLaunch) reason = "cancelled";
    else if (message.includes("did not become healthy")) reason = "timeout";
    log(`elevated backend start failed (${reason}): ${message}`);

    // No recovery start: the backend that was running before this attempt still is, on the same
    // port, so the renderer's origin is untouched.
    return { ok: false, reason, message, restarted: false };
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
