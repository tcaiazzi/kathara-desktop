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

// A URL scheme ("kathara:", "file:", "https:") — but not a Windows drive letter ("C:\", "C:/").
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:([\\/]|$)/i;

/**
 * The folder a launch was asked to open (`kathara-desktop ~/labs/ospf`), or null.
 *
 * `argv[0]` is the executable, and `launcher` names the paths that are the launcher itself rather
 * than something to open — the app path when running unpackaged (`electron .`). Those are matched
 * by value, never by position: Chromium puts its own switches ahead of the app path in a second
 * instance's argv, so a fixed count would drop a switch and keep the app's own folder. Flags —
 * Chromium's, and whatever a desktop entry adds (`--no-sandbox`) — are not folders, and neither is
 * anything with a URL
 * scheme. That last rule is a security one, not a nicety: the OS hands the app every `kathara:`
 * link a web page opens, and one without `//` (`kathara:../../../home/u/x`) is neither a deep link
 * (deepLinkRoute.ts wants `kathara://`) nor, once resolved, anything but an attacker-chosen
 * absolute path. The last remaining argument is the one, resolved against `cwd` (the *calling*
 * shell's, for a second instance), and only if it really is a directory.
 */
export function folderFromArgv(
  argv: string[],
  cwd: string,
  launcher: string[],
  isDirectory: (candidate: string) => boolean,
): string | null {
  const own = new Set(launcher.map((p) => path.resolve(p)));
  const candidates = argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith("-") && (!URL_SCHEME_RE.test(arg) || WINDOWS_DRIVE_RE.test(arg)))
    .map((arg) => path.resolve(cwd, arg))
    .filter((resolved) => !own.has(resolved));
  const last = candidates.at(-1);
  if (last === undefined) return null;
  return isDirectory(last) ? last : null;
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
