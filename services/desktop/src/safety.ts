/**
 * Validation for the few values that reach a privileged context — an elevated command line, the
 * backend's own filesystem root, or the IPC surface itself — from somewhere this process doesn't
 * control: the renderer (over IPC, including *which page* is calling) and `preferences.json` (a
 * plain JSON file `readPrefs` parses without validating).
 *
 * Deliberately free of any `electron` import, unlike paths.ts/prefs.ts: these are pure functions
 * shared by main.ts, paths.ts and backend.ts, and staying importable without an Electron runtime
 * is what keeps them checkable on their own.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Shell metacharacters, plus the control characters that break a `.bat` line or a shell script.
 *
 * Two characters are deliberately *absent*:
 *   - a space, because "C:\Program Files\Python\python.exe" is an ordinary path and quoting is
 *     what handles it;
 *   - a backslash, because it is Windows' path separator — rejecting it would reject every
 *     Windows path there is. It is safe to allow: `quoteForShellString` single-quotes on POSIX
 *     (where a backslash is then literal), and on Windows it is not an escape character at all.
 */
const SHELL_METACHARACTERS = /["'$`%!^&|<>();{}*?~[\]#\r\n\t\0]/;

/**
 * Whether `value` is an absolute path safe to interpolate into a command string and to hand to an
 * elevated process.
 *
 * The type predicate matters at the IPC boundary: TypeScript's `(path: string)` on an
 * `ipcMain.handle` argument is erased at runtime, so a renderer can send a number, an object, or
 * nothing at all.
 *
 * Rejecting metacharacters outright rather than trying to escape them is the deliberate choice:
 * `@vscode/sudo-prompt` takes a single command *string* (it exposes no argv API) and writes it
 * verbatim into a `/bin/sh` script on macOS and a `.bat` line on Windows, and quoting a `.bat`
 * line correctly — `%` doubling, `^` escaping, how those interact with quotes — is notoriously
 * hard to get right. A path with no metacharacters is safe by construction; `quoteForShellString`
 * below is then the second line of defence, not the only one.
 *
 * `platform` exists so both branches can be exercised from either OS.
 */
export function isPlainAbsolutePath(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (SHELL_METACHARACTERS.test(value)) return false;
  // path.win32/posix rather than the ambient `path`: "C:\labs" is absolute on Windows and not on
  // Linux, and this must answer for the platform the value will actually be used on.
  return platform === "win32" ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
}

/**
 * Whether `value` is a string short enough to pass on, for the arguments where *any* text is
 * legitimate — a password, a lab name — and the only thing to establish is that it is text at
 * all and not unbounded.
 *
 * Deliberately not `isPlainAbsolutePath`: that one rejects shell metacharacters, which a password
 * is entitled to contain. What this rules out is the other half of the same problem — a renderer
 * sending a number, an object or nothing where a string is declared, since the annotation on an
 * `ipcMain.handle` argument is erased at runtime. An object reaching a template literal becomes
 * "[object Object]" rather than failing, which is how a wrong shape turns into a silently wrong
 * value instead of an error.
 *
 * The ceiling is per-call because what counts as absurd differs: a password is short, a path is
 * not. It is a sanity bound, not a policy — the real limits live with whoever consumes the value.
 */
export function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

/**
 * Quote one argument for the single command string `sudo-prompt` requires.
 *
 * POSIX: single quotes, which suppress every expansion, with the standard `'\''` dance for an
 * embedded quote. Windows: double quotes with `""` doubling, the convention `cmd.exe` follows.
 * Both are belt-and-braces over `isPlainAbsolutePath` — callers are expected to have validated
 * already, so in practice this only has to survive spaces.
 */
export function quoteForShellString(
  arg: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return `"${arg.replace(/"/g, '""')}"`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Chromium refuses to load a URL on a handful of ports (ERR_UNSAFE_PORT); ports we assign
 * ourselves via findFreePort() never land there, but a hand-edited preferences.json could. */
export function isUsablePort(port: unknown): port is number {
  return Number.isInteger(port) && (port as number) >= 1024 && (port as number) <= 65535;
}

/**
 * The origin the backend is ever reachable on: loopback, any port.
 *
 * `127.0.0.1` literally and not `localhost`, because that is what backend.ts builds its baseUrl
 * from — a page served from `http://localhost:<port>` is a different origin to Chromium and is
 * not one this shell ever loads.
 *
 * Any port rather than the current one on purpose: the backend restarts on a fresh port for every
 * elevate/drop/labs-dir change, and between `stopBackend()` and the `win.loadURL` that follows it
 * there are seconds of preflight during which the live page is still on the *previous* origin.
 * Pinning to the current origin would reject that page's own legitimate calls — the notification
 * history it saves to survive the very reload in flight, the Docker poll — in exactly the window
 * where they happen. The top-frame check in ipc.ts is the half that carries the weight here: a
 * sender has to be the main frame of a window this shell created, and where that frame may
 * navigate is pinned by the navigation policy in windows.ts.
 */
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/**
 * Whether `url` is a page this shell could actually have loaded into one of its own windows —
 * the SPA the backend serves, or one of the local `appPages` (setup.html, splash.html), which are
 * passed in rather than imported so this file stays free of any `electron` import.
 *
 * `file:` URLs are compared by *path*, not by URL string: Chromium's percent-encoding of a path
 * with a space or a non-ASCII character need not match what `pathToFileURL` would produce, and a
 * mismatch there would lock the user out of the setup page rather than merely being untidy.
 * Case-insensitively on Windows, where two spellings of one path are the same file.
 */
export function isTrustedRendererUrl(
  url: string | undefined,
  appPages: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return LOOPBACK_ORIGIN.test(parsed.origin);

  let filePath: string;
  try {
    // `windows:` explicitly, for the same reason isPlainAbsolutePath reaches for path.win32 /
    // path.posix: without it this follows whatever OS happens to be running, so the Windows
    // branch could never be exercised — or checked — from anywhere else.
    filePath = fileURLToPath(parsed, { windows: platform === "win32" });
  } catch {
    // A `file:` URL that names no path a filesystem could have — nothing this shell loaded.
    return false;
  }
  const normalize = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  return appPages.some((page) => normalize(page) === normalize(filePath));
}
