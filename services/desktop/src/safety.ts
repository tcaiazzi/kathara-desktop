/**
 * Validation for the few values that reach a privileged context — an elevated command line, or
 * the backend's own filesystem root — from somewhere this process doesn't control: the renderer
 * (over IPC) and `preferences.json` (a plain JSON file `readPrefs` parses without validating).
 *
 * Deliberately free of any `electron` import, unlike paths.ts/prefs.ts: these are pure functions
 * shared by main.ts, paths.ts, prereqs.ts and backend.ts, and keeping them importable on their own
 * is what makes them checkable in isolation (services/desktop has no test runner — see the plan's
 * verification notes).
 */
import path from "node:path";

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
