/**
 * Lab folders opened from outside the labs directory, as far as the shell is concerned: which
 * folder a launch asks to open, which folders the backend remembers, and how files an elevated
 * backend left root-owned in them are handed back. Free of any `electron` import, like safety.ts,
 * so it can be checked without an Electron runtime; main.ts does the dialogs and the calls.
 */
import path from "node:path";
import { isPlainAbsolutePath, quoteForShellString } from "./safety";

/** Where the backend keeps the list (src/kathara_api/services/known_labs.py) — keep in step. */
export const KNOWN_LABS_FILENAME = "known_labs.json";

/**
 * The folder a launch was asked to open (`kathara-desktop ~/labs/ospf`), or null.
 *
 * `leading` is how many entries of `argv` are the launcher itself: the executable, plus the app
 * path when running unpackaged (`electron .`). After those, flags — Chromium's own, and whatever a
 * desktop entry adds (`--no-sandbox`) — and kathara:// links are not folders; the last remaining
 * argument is the one, resolved against `cwd` (the *calling* shell's, for a second instance), and
 * only if it really is a directory.
 */
export function folderFromArgv(
  argv: string[],
  cwd: string,
  leading: number,
  isDirectory: (candidate: string) => boolean,
): string | null {
  const candidates = argv.slice(leading).filter((arg) => arg && !arg.startsWith("-") && !arg.includes("://"));
  const last = candidates.at(-1);
  if (last === undefined) return null;
  const resolved = path.resolve(cwd, last);
  return isDirectory(resolved) ? resolved : null;
}

/**
 * The folders listed in the backend's known_labs.json text, or none when it can't be read.
 *
 * Read by the shell directly rather than asked of the backend: the reclaim below runs while the
 * backend is being swapped out, and the file is the same list the backend would answer with.
 * Mirrors the backend's own tolerance (KnownLabs._load): anything malformed is skipped, never
 * fatal.
 */
export function knownLabDirs(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const labs = typeof data === "object" && data !== null ? (data as { labs?: unknown }).labs : undefined;
  if (!Array.isArray(labs)) return [];
  const dirs: string[] = [];
  for (const entry of labs) {
    const dir = typeof entry === "object" && entry !== null ? (entry as { path?: unknown }).path : undefined;
    if (typeof dir === "string" && path.isAbsolute(dir) && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** What a reclaim covers: the labs directory, and the opened folders holding root-owned files. */
export interface ReclaimTargets {
  labsDir: string | null;
  openedDirs: string[];
}

/**
 * The one shell command that hands everything an elevated backend left root-owned back to
 * `uid:gid`, or null when there is nothing to do.
 *
 * The two kinds of folder are treated differently on purpose. The labs directory is this app's
 * own, so `chown -R` it wholesale. An opened folder is the user's, possibly shared with others, so
 * only the files root owns are touched (`find -uid 0`), never a file some other account owns
 * there. `-h`/`-P` so a symbolic link is changed itself and never followed out of the folder.
 *
 * Every path must be plain (safety.ts's isPlainAbsolutePath): it lands in a script run as root.
 * One that isn't is refused here rather than quoted and hoped for.
 */
export function reclaimScript(targets: ReclaimTargets, uid: number, gid: number): string | null {
  const owner = `${uid}:${gid}`;
  const all = [...(targets.labsDir ? [targets.labsDir] : []), ...targets.openedDirs];
  const unsafe = all.find((dir) => !isPlainAbsolutePath(dir));
  if (unsafe !== undefined) throw new Error(`refusing to reclaim ownership of a suspicious path: ${JSON.stringify(unsafe)}`);

  const steps: string[] = [];
  if (targets.labsDir) steps.push(`chown -R ${owner} ${quoteForShellString(targets.labsDir, "linux")}`);
  if (targets.openedDirs.length > 0) {
    const roots = targets.openedDirs.map((dir) => quoteForShellString(dir, "linux")).join(" ");
    steps.push(`find -P ${roots} -uid 0 -exec chown -h ${owner} {} +`);
  }
  return steps.length > 0 ? steps.join(" && ") : null;
}
