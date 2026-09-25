/**
 * Which terminal emulator opens on Linux, and with what argv. Free of any `electron` import, like
 * safety.ts, so it can be checked without an Electron runtime; integrations.ts supplies the PATH
 * lookup and does the spawning.
 *
 * There is no single answer on Linux, so the first emulator in this list that exists on PATH
 * wins; a user whose emulator isn't listed overrides it with `terminalCommand` in
 * preferences.json.
 */

/** The argv that opens a terminal at `cwd`, optionally running `command` in it through `sh -c`,
 *  for the first listed emulator `isOnPath` reports as installed — or null when none is. */
export function linuxTerminalArgv(
  cwd: string,
  command: string | undefined,
  isOnPath: (binary: string) => boolean,
): string[] | null {
  const run = (...args: string[]) => (command ? args : []);
  const candidates: string[][] = [
    ["x-terminal-emulator", ...run("-e", "sh", "-c", command ?? "")],
    ["gnome-terminal", `--working-directory=${cwd}`, ...run("--", "sh", "-c", command ?? "")],
    ["konsole", "--workdir", cwd, ...run("-e", "sh", "-c", command ?? "")],
    ["xfce4-terminal", `--working-directory=${cwd}`, ...run("-x", "sh", "-c", command ?? "")],
    ["alacritty", "--working-directory", cwd, ...run("-e", "sh", "-c", command ?? "")],
    ["kitty", "-d", cwd, ...run("sh", "-c", command ?? "")],
    ["xterm", ...run("-e", "sh", "-c", command ?? "")],
  ];
  return candidates.find(([bin]) => isOnPath(bin)) ?? null;
}
