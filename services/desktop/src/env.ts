/**
 * A GUI app launched by double-click (Finder, Dock, a .desktop file) does not inherit the PATH
 * a Terminal session has — macOS in particular starts it with just /usr/bin:/bin:/usr/sbin:/sbin,
 * so Homebrew (/opt/homebrew/bin, /usr/local/bin) and Docker Desktop's CLI symlink are invisible
 * even though `docker` works fine from a Terminal. That breaks checkDocker() (prereqs.ts) and
 * every PATH-based Python lookup (pythonCandidates()), with no hint that PATH is the culprit.
 *
 * Fix: ask the user's own login shell what its PATH is (sourcing their .zprofile/.profile, where
 * Homebrew's shellenv and similar tools usually live) and merge it in, once at startup. Windows
 * doesn't have this problem — PATH there is a system-wide registry value, inherited regardless of
 * how the app was launched — so this is a no-op there.
 *
 * Asynchronous on purpose. An interactive login shell can take seconds to start (a heavy .zshrc,
 * a shell prompt framework, an NVM/pyenv init), and this used to run synchronously *before* the
 * window existed — so the whole app was a blank screen for as long as the user's dotfiles took,
 * up to the 10s timeout. It is now awaited from startup(), after the window is on screen showing
 * "Reading your shell environment…".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger";

const execFileAsync = promisify(execFile);

const MARKER = "___KATHARA_IDE_PATH___";

/**
 * Resolved once per process: the login shell is expensive and its PATH won't change under us,
 * so a Retry (which re-runs startup) must not pay for it a second time.
 */
let pathEnv: Promise<void> | null = null;

/** Awaited by startup() before anything that shells out. Never rejects. */
export function ensurePathEnv(): Promise<void> {
  return (pathEnv ??= resolvePathEnv());
}

async function resolvePathEnv(): Promise<void> {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", `echo "${MARKER}$PATH"`], {
      timeout: 10_000,
      windowsHide: true,
    });
    const output = stdout.toString();
    const line = output.split("\n").find((l) => l.startsWith(MARKER));
    const shellPath = line?.slice(MARKER.length).trim();
    if (!shellPath) return;

    const merged = [...new Set([...shellPath.split(":"), ...(process.env.PATH ?? "").split(":")])]
      .filter(Boolean)
      .join(":");
    if (merged !== process.env.PATH) {
      log(`PATH extended from login shell (${shell}): ${merged}`);
      process.env.PATH = merged;
    }
  } catch (err) {
    // Best effort: if the login shell can't be queried, fall back to whatever PATH Electron
    // already has — the checks below just report what's missing, same as before this existed.
    log(`could not resolve login shell PATH via ${shell}: ${err instanceof Error ? err.message : err}`);
  }
}
