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
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import sudoPrompt from "@vscode/sudo-prompt";
import { backendSrcDir, bundledSitePackages, labsDir, logFile, pycacheDir, stateDir } from "./paths";
import { log, logRaw } from "./logger";
import { readPrefs, writePrefs } from "./prefs";
import { authorizeDeployWith, type PrivilegedActionResult, type SudoFailureReason } from "./privilegedAction";
import { errorText } from "./errors";
import { reclaimScript, type ReclaimTargets } from "./labFolders";
import { isPlainAbsolutePath, isUsablePort } from "./safety";
import { uploadLimitsEnv } from "./uploadLimits";

export interface BackendHandle {
  port: number;
  baseUrl: string;
  /** Pairing token for this one backend instance — see buildBackendCommand. Sent as
   * `Authorization: Bearer <token>` on every request this module makes to its own backend
   * (stopBackend's shutdown request, openLabFolder, grantDeploy), and handed to the renderer over
   * IPC (main.ts's "auth:get-token") so it can do the same. */
  token: string;
  /** The second per-launch secret, KATHARA_API_SHELL_TOKEN: the only thing `POST /api/labs/open`
   * and `POST /api/labs/{id}/deploy-grant` accept (src/kathara_api/dependencies.py's
   * require_shell_token). Unlike `token`, it never leaves this module — not to main.ts, not over
   * IPC — so nothing the renderer runs can open an arbitrary host folder as a lab, or let a deploy
   * start a privileged device or mount a host directory without the user's password;
   * `openLabFolder` and `grantDeploy` below are its only uses. */
  shellToken: string;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_POLL_MS = 250;
/** Bounds a single health-check request, independent of HEALTH_TIMEOUT_MS above (the budget for
 * the whole polling loop): without this, one request that connects but never answers would block
 * the loop from ever re-checking `deadline`, so the overall timeout would never actually fire. */
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const SIGTERM_GRACE_MS = 5_000;
const SHUTDOWN_HTTP_TIMEOUT_MS = 2_000;
/** Passed to uvicorn as `--timeout-graceful-shutdown` (see `buildBackendCommand`): bounds how
 * long a SIGTERM'd backend will wait for in-flight requests/tasks (e.g. another lab's open
 * stats SSE stream or exec WebSocket) before it force-exits. Without this, uvicorn's default is
 * to wait indefinitely, which lets a backend outlive `stopBackend()`'s poll entirely. */
const GRACEFUL_SHUTDOWN_TIMEOUT_S = 5;
/** Bounds the credentials-only `sudo -v` probe below. Generous — it's a local PAM call that
 * normally answers instantly — but finite, so a wedged PAM module can't hang the IPC call
 * that's holding the password prompt open. */
const SUDO_VERIFY_TIMEOUT_MS = 15_000;
/** Bounds the ownership reclaim, which does real work under sudo — see reclaimOwnershipWithPassword. */
const RECLAIM_TIMEOUT_MS = 120_000;
/** Below this many *consecutive* failed sudo checks, a cooldown never engages — a person mistyping
 * their own password a couple of times pays nothing extra. Past it, `sudo -S -k -v` stops being a
 * free oracle a compromised renderer (e.g. a script injected into the SPA) could otherwise
 * hammer in the background to brute-force the account's real password from the ok/wrong-password
 * split alone. */
const SUDO_RATE_LIMIT_FREE_ATTEMPTS = 5;
const SUDO_RATE_LIMIT_BASE_MS = 30_000;
const SUDO_RATE_LIMIT_MAX_MS = 5 * 60_000;
/** Every sudo-prompt call's options: `name` is the app name its native dialog shows. Shared as
 * is, since sudo-prompt only writes into the object when `name` is missing. */
const SUDO_PROMPT_OPTIONS = { name: "Kathara Desktop" };

let child: ChildProcess | null = null;
let handle: BackendHandle | null = null;
/** Set during an intentional stop, so an exit then isn't reported as a crash. */
let stopping = false;
let exitListener: ((info: { code: number | null; signal: string | null }) => void) | null = null;

/** Consecutive failed sudo checks since the last correct password, and how long from now further
 * checks are refused without even running `sudo` — see SUDO_RATE_LIMIT_* above. Shared across the
 * three IPC channels that can trigger a check (elevation:authorize-deploy, elevation:verify,
 * elevation:reclaim-labs-dir): they all funnel through `withSudoRateLimit`, so switching between
 * them doesn't reset the count either. */
let failedSudoAttempts = 0;
let sudoLockedUntil = 0;

/**
 * Whether anything under `dirPath` is owned by someone other than the current user — the signal
 * that running devices left root-owned files behind in the labs directory (Kathara bind-mounts
 * each lab's `shared/` folder, and a container writes there as root). Recurses, but stops at the
 * first mismatch: this only ever needs a yes/no answer, never a full listing.
 *
 * Best-effort in the safe direction: a subtree this user can't even list (typically because a
 * root-owned *directory* blocks read access to its own contents) counts as "yes" rather than
 * being silently skipped — the whole reason to check in the first place is exactly that failure
 * mode. Windows always answers "no": Docker Desktop's bind mounts there leave no foreign owner
 * to fix up.
 */
export async function hasForeignOwnedFiles(dirPath: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (process.platform === "win32" || uid === undefined) return false;
  return hasFilesOwnedBy(dirPath, (owner) => owner !== uid, true);
}

/**
 * Whether anything under `dirPath` is owned by root — the narrower question asked of a lab folder
 * the user opened from elsewhere, which may legitimately hold other accounts' files (see
 * labFolders.ts's reclaimScript, which only ever touches root's). A subtree that can't be listed
 * is not counted: its own owner was already checked on the way in, and a folder a device created
 * would be root's and so found there.
 */
export async function hasRootOwnedFiles(dirPath: string): Promise<boolean> {
  if (process.platform === "win32") return false;
  return hasFilesOwnedBy(dirPath, (owner) => owner === 0, false);
}

async function hasFilesOwnedBy(
  dirPath: string,
  matches: (owner: number) => boolean,
  unreadableMatches: boolean,
): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return unreadableMatches;
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(full);
    } catch {
      if (unreadableMatches) return true;
      continue;
    }
    if (matches(stat.uid)) return true;
    if (entry.isDirectory() && (await hasFilesOwnedBy(full, matches, unreadableMatches))) return true;
  }
  return false;
}

/** The current user's uid:gid, or why they couldn't be determined. */
function currentOwner(): { ok: true; uid: number; gid: number } | { ok: false; message: string } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return { ok: false, message: "could not determine the current user's id" };
  }
  return { ok: true, uid, gid };
}

/** The reclaim command for `targets`, or why there isn't one — see labFolders.ts's reclaimScript,
 * which also refuses any path that isn't plain, since this is the last point before a string
 * reaches a privileged command. `null` script means there is nothing to reclaim. */
function reclaimCommand(targets: ReclaimTargets): { ok: true; script: string | null } | { ok: false; message: string } {
  const owner = currentOwner();
  if (!owner.ok) return owner;
  try {
    return { ok: true, script: reclaimScript(targets, owner.uid, owner.gid) };
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
}

/**
 * Linux only, the one platform where a bind mount shows a container's files as root's. Runs the
 * reclaim script under `sudo -S -k sh -c` directly, feeding `password` on stdin — authenticating
 * and running the command in the exact same invocation, so unlike a `sudo -n`/cached-ticket
 * approach it doesn't depend on this headless spawn sharing any session/tty state with a previous
 * one. Not `sudo-prompt`: on Linux it shells out to `pkexec`, which needs a running polkit
 * authentication agent that plenty of real setups (headless, minimal window managers, WSL) don't
 * have. Shares `runSudoWithPassword` and the rate limiter with `verifySudoPassword`, so this
 * doesn't open a second password oracle alongside the one SUDO_RATE_LIMIT_FREE_ATTEMPTS closes.
 */
export async function reclaimOwnershipWithPassword(
  password: string,
  targets: ReclaimTargets,
): Promise<PrivilegedActionResult> {
  if (process.platform !== "linux") return { ok: false, reason: "error", message: "not applicable on this platform" };
  const command = reclaimCommand(targets);
  if (!command.ok) return { ok: false, reason: "error", message: command.message };
  const { script } = command;
  if (script === null) return { ok: true };

  // Far longer than a password check: the chown walks the whole labs directory and every opened
  // folder, and a timeout here SIGKILLs sudo with the root chown possibly half done.
  return withSudoRateLimit(() =>
    runSudoWithPassword(["sh", "-c", script], password, "reclaim lab file ownership", { timeoutMs: RECLAIM_TIMEOUT_MS }),
  );
}

/** What `openLabFolder` got back: the lab's id, or why the folder didn't open. `notALab` is the
 * backend's NotALabError — a folder with no lab.conf and no device folders, which the caller may
 * offer to initialize. */
type OpenLabFolderResult = { ok: true; labId: string } | { ok: false; notALab: boolean; message: string };

/** Opening reads the whole folder (bounded by the import caps), so allow for a slow disk. */
const OPEN_LAB_TIMEOUT_MS = 30_000;

/**
 * Open `folder` as a lab on the running backend (`POST /api/labs/open`) — the one request that
 * carries the shell token, see BackendHandle.shellToken. `folder` must come from the shell's own
 * side (a native dialog, the launch argv), never from the renderer.
 */
export async function openLabFolder(folder: string, init: boolean): Promise<OpenLabFolderResult> {
  const current = handle;
  if (!current) return { ok: false, notALab: false, message: "the backend is not running" };
  let res: Response;
  try {
    res = await fetch(`${current.baseUrl}/api/labs/open`, {
      method: "POST",
      headers: {
        ...authHeaders(current.token),
        "Content-Type": "application/json",
        "X-Kathara-Shell-Token": current.shellToken,
      },
      body: JSON.stringify({ path: folder, init }),
      signal: AbortSignal.timeout(OPEN_LAB_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, notALab: false, message: errorText(err) };
  }
  const body = (await res.json().catch(() => null)) as { id?: unknown; detail?: unknown; error_type?: unknown } | null;
  if (res.ok && typeof body?.id === "string") return { ok: true, labId: body.id };
  return {
    ok: false,
    notALab: body?.error_type === "NotALabError",
    message: typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}`,
  };
}

/** What `grantDeploy` got back. */
type GrantDeployResult = { ok: true } | { ok: false; message: string };

const GRANT_DEPLOY_TIMEOUT_MS = 15_000;

/**
 * Let the next deploy of `labId` start its privileged devices and mount its host directories
 * (`POST /api/labs/{id}/deploy-grant`, see src/kathara_api/services/deploy_grants.py) — the
 * other request that carries the shell token. Only ever called after the user's own password was
 * checked (`authorizeDeploy` below): the backend refuses such a deploy without it.
 */
async function grantDeploy(labId: string): Promise<GrantDeployResult> {
  const current = handle;
  if (!current) return { ok: false, message: "the backend is not running" };
  let res: Response;
  try {
    res = await fetch(`${current.baseUrl}/api/labs/${encodeURIComponent(labId)}/deploy-grant`, {
      method: "POST",
      headers: { ...authHeaders(current.token), "X-Kathara-Shell-Token": current.shellToken },
      signal: AbortSignal.timeout(GRANT_DEPLOY_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, message: errorText(err) };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  return { ok: false, message: typeof body?.detail === "string" ? body.detail : `HTTP ${res.status}` };
}

/**
 * Ask the OS for an unused port and hand it to the child. Listening on 0 and reading back the
 * assigned port leaves a gap of seconds — uvicorn binds only once its imports are done — in which
 * another local process can take the port. waitForHealth's pairing proof is what makes losing
 * that race harmless. Still better than hardcoding 8000, which collides with the very common case
 * of a backend the user already has running.
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

/** Origins of every backend that has passed `waitForHealth`'s pairing proof this session — the
 * only loopback origins ipc.ts trusts (see safety.ts's isTrustedRendererUrl). Kept after a backend
 * stops: a page still open on the previous origin during a restart is one this shell loaded. */
const pairedOrigins = new Set<string>();

export function pairedBackendOrigins(): ReadonlySet<string> {
  return pairedOrigins;
}

/** Something other than the backend this shell started answered on its port (see waitForHealth). */
class PortTakenError extends Error {}

/**
 * Poll until the backend at `baseUrl` answers and proves it is the one this shell started: it must
 * return `HMAC-SHA256(token, nonce)` from `/api/pairing/proof` (src/kathara_api/routers/pairing.py).
 * The request carries nothing secret, so a process that took the port before uvicorn bound it (see
 * findFreePort) learns neither token, and its answer fails the check — the port is then abandoned
 * rather than loaded into the window with the preload bridge attached.
 */
async function waitForHealth(baseUrl: string, token: string, deadline: number): Promise<void> {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expected = crypto.createHmac("sha256", token).update(nonce).digest("hex");
  let lastError = "no response";
  while (Date.now() < deadline) {
    // A crash during startup means health will never come up; fail immediately with the
    // traceback rather than burning the full timeout on a dead process.
    if (!child || child.exitCode !== null) {
      throw new Error(`backend exited during startup (code ${child?.exitCode ?? "unknown"})`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/pairing/proof?nonce=${nonce}`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const { proof } = (await res.json()) as { proof?: unknown };
        if (proof !== expected) {
          throw new PortTakenError(`another process answered on ${baseUrl} without this launch's pairing token`);
        }
        pairedOrigins.add(new URL(baseUrl).origin);
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof PortTakenError) throw err;
      lastError = errorText(err);
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  throw new Error(`backend did not become healthy within ${HEALTH_TIMEOUT_MS}ms (${lastError})`);
}

interface BackendCommand {
  port: number;
  baseUrl: string;
  /** Per-launch pairing secret, generated below and forwarded to the child as
   * KATHARA_API_AUTH_TOKEN (see src/kathara_api/dependencies.py's require_auth_token). Every
   * later call this module makes to this exact backend instance must carry it. */
  token: string;
  /** See BackendHandle.shellToken. */
  shellToken: string;
  labs: string;
  /** The inherited `process.env` plus this app's own settings for the backend. */
  env: NodeJS.ProcessEnv;
  args: string[];
}

/**
 * Where the interpreter finds the backend's code, and where it may cache bytecode.
 *
 * Packaged, that's the dependency closure vendored into the app at build time
 * (paths.ts's bundledSitePackages()); in a dev checkout it's the repo's own src/, offered as a
 * fallback for an interpreter the API package isn't pip-installed into. The two never both apply:
 * backendSrcDir() is null when packaged and bundledSitePackages() is null when not.
 *
 * Shared with prereqs.ts, which has to probe an interpreter under exactly this environment —
 * probing a packaged app's interpreter without PYTHONPATH would report every backend import as
 * missing.
 *
 * path.delimiter, not ":" — on Windows the separator is ";", so joining with ":" on a machine
 * that already has a PYTHONPATH set yields one unparseable entry and drops the repo's src/.
 */
export function pythonEnv(): Record<string, string> {
  const roots = [bundledSitePackages(), backendSrcDir()].filter((dir): dir is string => Boolean(dir));
  return {
    PYTHONPYCACHEPREFIX: pycacheDir(),
    ...(roots.length ? { PYTHONPATH: [...roots, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : {}),
  };
}

/** Everything about *what* to run: the port, the two per-launch secrets and the environment. */
async function buildBackendCommand(staticDir: string, port: number): Promise<BackendCommand> {
  const baseUrl = `http://127.0.0.1:${port}`;
  // Random per launch, never persisted (unlike the port in prefs.ts): pairs this one backend
  // instance with this one Electron process, so any other local process/browser tab that finds
  // the port still can't call it without also having read this token from the renderer's own
  // context-isolated preload bridge (see main.ts's "auth:get-token", preload.ts's getAuthToken).
  const token = crypto.randomBytes(32).toString("hex");
  const shellToken = crypto.randomBytes(32).toString("hex");
  const labs = labsDir();
  fs.mkdirSync(labs, { recursive: true });
  // Checked like the labs dir is (paths.ts's labsDir): a path with shell metacharacters has no
  // business in this app's settings. Without a usable one the backend keeps its list of opened
  // folders in memory only.
  const state = stateDir();
  const stateEnv: Record<string, string> = isPlainAbsolutePath(state) ? { KATHARA_API_STATE_DIR: state } : {};
  if (!stateEnv.KATHARA_API_STATE_DIR) log(`not passing the state directory to the backend: ${JSON.stringify(state)}`);

  const limitsEnv = uploadLimitsEnv(readPrefs().uploadLimits);
  if (Object.keys(limitsEnv).length) {
    log(`upload limits from Settings: ${Object.entries(limitsEnv).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }

  const appEnv: Record<string, string> = {
    // src/kathara_api/config.py already defaults to loopback; this pins it regardless of a stray
    // .env, as does --host on uvicorn's CLI below. A desktop app must not put its backend — which
    // can execute commands in containers — on the LAN.
    KATHARA_API_HOST: "127.0.0.1",
    KATHARA_API_PORT: String(port),
    KATHARA_API_STATIC_DIR: staticDir,
    KATHARA_API_LABS_DIR: labs,
    KATHARA_API_AUTH_TOKEN: token,
    KATHARA_API_SHELL_TOKEN: shellToken,
    ...stateEnv,
    // The limits the user saved in Settings, which the backend would otherwise forget on restart.
    ...limitsEnv,
    PYTHONUNBUFFERED: "1",
    ...pythonEnv(),
  };
  const env: NodeJS.ProcessEnv = { ...process.env, ...appEnv };

  // Explicit --host/--port as well as the env vars: uvicorn's CLI wins over settings, so the
  // port we probed is the port it binds even if a stray .env sets another one.
  const args = [
    "-m", "uvicorn", "kathara_api.main:create_app",
    "--factory",
    "--host", "127.0.0.1",
    "--port", String(port),
    // Bounds SIGTERM's graceful-shutdown wait (see GRACEFUL_SHUTDOWN_TIMEOUT_S) so a lingering
    // SSE/WebSocket connection from another open lab can't keep this process alive past
    // stopBackend()'s poll window.
    "--timeout-graceful-shutdown", String(GRACEFUL_SHUTDOWN_TIMEOUT_S),
    // The pairing token (see `token` above) travels as `?token=...` on the TTY WebSocket and the
    // stats EventSource URLs (services/api.ts) — neither can set an Authorization header. With
    // uvicorn's default access log on, every one of those request lines lands in backend.log
    // verbatim, which the app then invites the user to open and share (Help menu, the setup/
    // error page's log tail). This app is a single-user desktop backend with no operational need
    // for an access log; not logging the URLs at all is simpler and more durable than trying to
    // redact just the token out of them (see logger.ts's logRaw for the redaction that still
    // applies if this ever gets re-enabled or a caller logs a raw URL some other way).
    "--no-access-log",
  ];

  return { port, baseUrl, token, shellToken, labs, env, args };
}

/** Wires stdout/stderr logging and exit bookkeeping onto a freshly spawned backend child, and
 * installs it as the tracked `child`. */
function trackChild(proc: ChildProcess): void {
  stopping = false;
  child = proc;
  // Guards against reporting the same failure twice: Node's docs say 'exit' may or may not
  // follow an 'error' for a process that failed to spawn at all, so whichever of the two
  // handlers below fires first reports it, and the other becomes a no-op.
  let reported = false;
  const reportExit = (code: number | null, signal: string | null) => {
    if (reported) return;
    reported = true;
    if (child === proc) {
      child = null;
      handle = null;
    }
    if (!stopping) exitListener?.({ code, signal });
  };
  proc.stdout?.on("data", (c: Buffer) => logRaw(c.toString()));
  proc.stderr?.on("data", (c: Buffer) => logRaw(c.toString()));
  proc.on("exit", (code, signal) => {
    log(`backend exited (code=${code} signal=${signal})`);
    reportExit(code, signal);
  });
  // A ChildProcess with no 'error' listener throws its error as an uncaught exception on the
  // main process (Node special-cases the "error" event on EventEmitter) — reachable in practice
  // from a bad interpreter path (EACCES/ENOENT, or ETXTBSY on some platforms), which would
  // otherwise crash the whole app with no dialog, no log line, no setup page.
  proc.on("error", (err) => {
    log(`backend process error: ${err.message}`);
    reportExit(null, null);
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
    //
    // A port another process answered on (PortTakenError) is retried the same way, remembered or
    // not: that process is not going away, and a fresh port leaves it behind.
    const portTaken = err instanceof PortTakenError;
    const rememberedPortLost =
      remembered !== null && err instanceof Error && err.message.startsWith("backend exited during startup");
    if (!portTaken && !rememberedPortLost) throw err;
    log(portTaken ? errorText(err) : `backend could not use remembered port ${remembered}`);
    log("retrying on a fresh port");
    forgetPort();
    return await spawnBackend(python, staticDir, await findFreePort());
  }
}

async function spawnBackend(python: string, staticDir: string, port: number): Promise<BackendHandle> {
  const { baseUrl, token, shellToken, labs, env, args } = await buildBackendCommand(staticDir, port);
  log(`starting backend: ${python} ${args.join(" ")}`);
  log(`  labs dir: ${labs}`);
  log(`  static dir: ${staticDir}`);

  trackChild(spawn(python, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));

  try {
    await waitForHealth(baseUrl, token, Date.now() + HEALTH_TIMEOUT_MS);
  } catch (err) {
    await stopBackend();
    throw err;
  }

  log(`backend healthy at ${baseUrl}`);
  handle = { port, baseUrl, token, shellToken };
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
 * Deliberately not registered with `trackChild` — it is not a backend, and treating it as one
 * makes a mistyped password present itself as "The Kathara API stopped unexpectedly".
 *
 * Gated by a lockout (see `failedSudoAttempts`/`sudoLockedUntil`): during a cooldown this returns
 * "rate-limited" without spawning `sudo` at all, so the actual check below never doubles as the
 * oracle described at SUDO_RATE_LIMIT_FREE_ATTEMPTS.
 */
async function verifySudoPassword(password: string): Promise<PrivilegedActionResult> {
  return withSudoRateLimit(() => runSudoWithPassword(["-v"], password, "sudo password check", { verifyOnly: true }));
}

/**
 * Shared gate for *every* "test a password against sudo" entry point — `verifySudoPassword`,
 * `reclaimOwnershipWithPassword` and `verifyCanElevate`'s macOS/Windows branch — so adding
 * a new one never opens a second password oracle alongside the one this already closes: they all
 * count against, and are locked out by, the same `failedSudoAttempts`/`sudoLockedUntil`.
 */
async function withSudoRateLimit(
  attempt: () => Promise<PrivilegedActionResult>,
  // Which failure reason counts against the lockout. Defaults to "wrong-password" — correct for
  // every `sudo`-backed attempt, where that distinction actually exists. macOS/Windows's
  // sudo-prompt dialog can't tell a dismissed dialog from a wrong password apart (see
  // `verifyCanElevate` below), so its caller passes a predicate that counts "cancelled" instead —
  // otherwise a renderer could trigger the native admin-password dialog without limit.
  countsAsAttempt: (reason: SudoFailureReason) => boolean = (reason) => reason === "wrong-password",
): Promise<PrivilegedActionResult> {
  const now = Date.now();
  if (now < sudoLockedUntil) {
    const retryInSeconds = Math.ceil((sudoLockedUntil - now) / 1000);
    return { ok: false, reason: "rate-limited", message: `too many failed attempts — try again in ${retryInSeconds}s` };
  }

  const result = await attempt();

  if (result.ok) {
    failedSudoAttempts = 0;
    sudoLockedUntil = 0;
  } else if (countsAsAttempt(result.reason)) {
    // Only a genuine guess counts here — an unrelated failure ("not-permitted"/"timeout"/"error"
    // for a `sudo`-backed attempt) isn't a signal about the password at all (the last of those
    // also covers a real command, like chown, failing for its own reasons after a *correct*
    // password), so counting it would rate-limit a user for something that was never a guessing
    // attempt in the first place.
    failedSudoAttempts += 1;
    if (failedSudoAttempts > SUDO_RATE_LIMIT_FREE_ATTEMPTS) {
      const lockoutMs = Math.min(
        SUDO_RATE_LIMIT_MAX_MS,
        SUDO_RATE_LIMIT_BASE_MS * 2 ** (failedSudoAttempts - SUDO_RATE_LIMIT_FREE_ATTEMPTS - 1),
      );
      sudoLockedUntil = Date.now() + lockoutMs;
    }
  }
  return result;
}

/** `sudo`'s own login-failure text, in the C locale `sudoEnv()` forces — distinct from
 * SUDO_NOT_PERMITTED_MARKERS above (that's "this account can never sudo at all", this is "that
 * password was wrong"). Only consulted for a real command below (`verifyOnly: false`): `-v` runs
 * nothing at all, so for it any remaining non-zero exit is unambiguously an auth failure without
 * needing to match specific text. A real command like `chown` can *also* exit non-zero after a
 * successful login (a bad path, a permissions quirk) — these markers are what tells that apart
 * from a wrong password, so it isn't misreported as one (and, via the shared rate limiter, doesn't
 * even count against the lockout the way an actual wrong password does). */
const SUDO_WRONG_PASSWORD_MARKERS = ["Sorry, try again", "incorrect password attempt", "no password was provided"];

/** Runs `sudo -S -k <argv>`, feeding `password` on stdin. `logLabel` only names the attempt in the
 * log lines below, not a behavior difference; `verifyOnly` says whether `argv` runs no command at
 * all (`-v`) — see SUDO_WRONG_PASSWORD_MARKERS above for why that changes how a non-zero exit is
 * classified. */
function runSudoWithPassword(
  argv: string[],
  password: string,
  logLabel: string,
  { verifyOnly = false, timeoutMs = SUDO_VERIFY_TIMEOUT_MS }: { verifyOnly?: boolean; timeoutMs?: number } = {},
): Promise<PrivilegedActionResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("sudo", ["-S", "-k", ...argv], { env: sudoEnv(), stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, reason: "error", message: `could not run sudo: ${errorText(err)}` });
      return;
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
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    proc.once("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
    proc.once("error", () => {
      clearTimeout(timer);
      finish(null);
    });

    function finish(code: number | null): void {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      const detail = stderrBuf.trim();
      if (SUDO_NOT_PERMITTED_MARKERS.some((m) => stderrBuf.includes(m))) {
        log(`${logLabel} refused: account may not use sudo${detail ? ` — ${detail}` : ""}`);
        resolve({ ok: false, reason: "not-permitted", message: detail || "this account is not allowed to use sudo" });
        return;
      }
      if (code === null) {
        log(`${logLabel} did not finish in time`);
        resolve({ ok: false, reason: "timeout", message: `sudo did not respond within ${timeoutMs}ms` });
        return;
      }
      if (verifyOnly || SUDO_WRONG_PASSWORD_MARKERS.some((m) => stderrBuf.includes(m))) {
        log(`${logLabel} failed (exit ${code})${detail ? ` — ${detail}` : ""}`);
        resolve({ ok: false, reason: "wrong-password", message: detail || "incorrect password" });
        return;
      }
      // Authenticated fine, but the command itself failed (bad path, permissions quirk, …) — not
      // a password problem, so it must not be reported or rate-limited as one.
      log(`${logLabel} failed (exit ${code})${detail ? ` — ${detail}` : ""}`);
      resolve({ ok: false, reason: "error", message: detail || `exited with code ${code}` });
    }
  });
}

/**
 * Verify the user could act as an administrator, running nothing that matters — the proof a
 * privileged device, a host volume or the host home mount asks for before a deploy (see
 * `authorizeDeploy`), and Settings' host home toggle asks for on its own.
 *
 * Linux reuses `verifySudoPassword` unchanged — it already validates without running anything.
 * macOS/Windows have no password field of their own: the only credential-collection UI either
 * has is sudo-prompt's native dialog, which is inherently tied to *running* something elevated —
 * so this runs a throwaway no-op through it. sudo-prompt can't tell "dialog dismissed" from
 * "wrong password" apart in any stable cross-platform way, so both land on "cancelled".
 */
export async function verifyCanElevate(password?: string): Promise<PrivilegedActionResult> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return verifySudoPassword(password ?? "");
  }
  // Through the same rate limiter as the Linux path above — without it, a renderer could trigger
  // this native admin-password dialog an unbounded number of times in a row. "cancelled" is what
  // counts here, not "wrong-password": sudo-prompt can't tell a dismissed dialog from a wrong
  // password apart (see withSudoRateLimit's doc comment), so both must count toward the lockout.
  return withSudoRateLimit(
    () =>
      new Promise((resolve) => {
        const cmd = process.platform === "win32" ? "cmd /c exit /b 0" : "/usr/bin/true";
        sudoPrompt.exec(cmd, SUDO_PROMPT_OPTIONS, (error) => {
          resolve(error ? { ok: false, reason: "cancelled", message: error.message } : { ok: true });
        });
      }),
    (reason) => reason === "cancelled",
  );
}

/**
 * Linux: whether sudo asks this account for a password at all. `-n` fails instead of prompting,
 * and `-k` ignores a cached credential for this one invocation, so `sudo -k -n true` succeeds only
 * where the sudoers policy grants NOPASSWD — where any "password" would pass `sudo -v`, and the
 * prompt has nothing to check. Always true elsewhere: the OS's own dialog asks there.
 */
export async function sudoNeedsPassword(): Promise<boolean> {
  if (process.platform !== "linux") return true;
  return !(await sudoRunsWithoutPassword());
}

function sudoRunsWithoutPassword(): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn("sudo", ["-k", "-n", "true"], { env: sudoEnv(), stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, SUDO_VERIFY_TIMEOUT_MS);
    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Check the user's say-so, then let the next deploy of `labId` start its privileged devices and
 * mount its host directories — privilegedAction.ts's authorizeDeployWith says in what order. */
export async function authorizeDeploy(labId: string, password?: string): Promise<PrivilegedActionResult> {
  const result = await authorizeDeployWith(
    { platform: process.platform, sudoRunsWithoutPassword, verifyPassword: verifyCanElevate, grant: grantDeploy },
    labId,
    password,
  );
  if (!result.ok) log(`deploy of ${labId} not authorized: ${result.reason} — ${result.message}`);
  return result;
}

/** Notified only on an *unexpected* exit, so the shell can show the log instead of a blank page. */
export function onBackendExit(cb: (info: { code: number | null; signal: string | null }) => void): void {
  exitListener = cb;
}

export function backendUrl(): string | null {
  return handle?.baseUrl ?? null;
}

/** The pairing token of the currently running backend, for main.ts's "auth:get-token" IPC
 * handler to hand to the renderer (see preload.ts's getAuthToken). */
export function backendToken(): string | null {
  return handle?.token ?? null;
}

export async function stopBackend(): Promise<void> {
  const proc = child;
  const current = handle;
  // Every way out of here drops both references, whether or not the process was confirmed gone.
  child = null;
  handle = null;
  if (!proc || proc.exitCode !== null) return;
  stopping = true;
  log(`stopping backend (pid ${proc.pid})${current ? ` at ${current.baseUrl}` : ""}`);

  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  const exitsWithin = (ms: number) =>
    Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  // Asked over HTTP first: the backend then stops the way it does on SIGTERM, closing its streams
  // and TTY sessions — the one graceful route on Windows, which has no SIGTERM to deliver (see
  // below). A signal remains the fallback for a backend that doesn't answer.
  if (current) {
    try {
      await fetch(`${current.baseUrl}/api/system/shutdown`, {
        method: "POST",
        headers: authHeaders(current.token),
        signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS),
      });
      if (await exitsWithin(SHUTDOWN_HTTP_TIMEOUT_MS)) return;
    } catch (err) {
      log(`HTTP shutdown request failed, falling back to signal: ${errorText(err)}`);
    }
  }

  const { pid } = proc;
  if (process.platform === "win32" && pid) {
    // Windows has no SIGTERM to deliver: signals are emulated and are not delivered to the
    // process tree, so uvicorn (and any worker it spawned) would survive a kill() here.
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
    return;
  }
  proc.kill("SIGTERM");
  if (await exitsWithin(SIGTERM_GRACE_MS)) return;
  log("backend did not exit on SIGTERM; sending SIGKILL");
  proc.kill("SIGKILL");
  // Bounded, not `await exited` unconditionally: a backend that still won't die shouldn't hang
  // app quit indefinitely waiting for an "exit" that may never come.
  if (!(await exitsWithin(SIGTERM_GRACE_MS))) log(`backend (pid ${pid}) did not exit after SIGKILL`);
}

export function backendLogPath(): string {
  return logFile();
}
