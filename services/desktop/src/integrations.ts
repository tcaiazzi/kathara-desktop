/**
 * The parts of the UI that only a desktop app can offer: native folder dialogs, revealing a lab
 * in the OS file manager, and opening a real terminal emulator in a lab's directory.
 *
 * Every one of these is exposed to the renderer through preload.ts and used behind a
 * feature check, so the browser build keeps working unchanged.
 */
import { dialog, shell, BrowserWindow } from "electron";
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { log } from "./logger";
import { labsDir } from "./paths";
import { readPrefs } from "./prefs";

/**
 * Electron's dialog functions have separate parented and parentless overloads; passing an
 * explicit `undefined` parent takes the parented one with a bad argument. Branch instead.
 */
function withParent<O, R>(
  fn: { (parent: BrowserWindow, options: O): Promise<R>; (options: O): Promise<R> },
  win: BrowserWindow | null,
  options: O,
): Promise<R> {
  return win ? fn(win, options) : fn(options);
}

/**
 * Let the user pick a new lab storage directory (Settings → "Change…"). Selection only — no
 * side effect here; main.ts's labs:set-dir handler decides whether the pick is actually applied
 * (it may be blocked by deployed labs or by the directory not being writable).
 */
export async function pickLabsDirectory(win: BrowserWindow | null): Promise<string | null> {
  const result = await withParent(dialog.showOpenDialog, win, {
    title: "Choose labs folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * Native picker for the host side of a device's `[volume]` bind mount (the Volumes rows in
 * MachineOptionsFields.tsx).
 *
 * The OS dialog rather than an in-app browser over the API, on every platform: the desktop shell
 * spawns the backend itself, so a directory picked here is by definition a directory on the
 * filesystem that backend will resolve and hand to Docker — and the dialog then gets for free
 * everything an in-app browser has to reinvent per OS, which on Windows means drive letters
 * (there is no single filesystem root to start from), backslash separators, UNC shares and
 * network locations, plus hidden folders and "New folder" everywhere.
 */
export async function pickHostDirectory(
  win: BrowserWindow | null,
  current?: string,
): Promise<string | null> {
  const result = await withParent(dialog.showOpenDialog, win, {
    title: "Choose a host directory to mount",
    properties: ["openDirectory", "createDirectory", "showHiddenFiles"],
    // Re-picking starts where the field already points, when that still exists. Undefined — not
    // "/", which names nothing on Windows — lets
    // the OS reopen wherever the user last was.
    defaultPath: current && fs.existsSync(current) ? current : undefined,
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export function revealPath(target: string): void {
  if (!fs.existsSync(target)) {
    log(`cannot reveal missing path: ${target}`);
    return;
  }
  // showItemInFolder selects the item; for a directory, opening it is what the user means.
  if (fs.statSync(target).isDirectory()) void shell.openPath(target);
  else shell.showItemInFolder(target);
}

export function openLabsDir(): void {
  const dir = labsDir();
  fs.mkdirSync(dir, { recursive: true });
  void shell.openPath(dir);
}

/**
 * Build the argv that opens a terminal window at `cwd`, per platform, optionally running
 * `command` in it. With no command, the emulator just opens with the user's default shell.
 *
 * On Linux there is no single answer, so the first emulator that exists on PATH wins;
 * a user whose emulator isn't listed can override it in preferences.json with
 * `terminalCommand`, where "{cmd}" is substituted with the shell command.
 */
/**
 * spawn() for a detached, "fire and forget" process this app never tracks or waits on (an
 * external terminal emulator). A ChildProcess with no 'error' listener throws its error as an
 * uncaught exception on the main process — reachable here from a bad `terminalCommand` override
 * in preferences.json, a terminal emulator binary that vanished after `linuxTerminalArgv` found
 * it, or a bad path on Windows/macOS — which would otherwise crash the whole app over something
 * as minor as "Open in terminal" failing. There is nothing further to report the error to (the
 * caller has already returned by the time a spawn failure could fire), so this just logs it.
 */
function spawnDetached(command: string, args: string[], options: SpawnOptions = {}): void {
  const proc = spawn(command, args, { ...options, detached: true, stdio: "ignore" });
  proc.on("error", (err) => log(`failed to launch ${command}: ${err.message}`));
  proc.unref();
}

function linuxTerminalArgv(cwd: string, command?: string): string[] | null {
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
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return (
    candidates.find(([bin]) => dirs.some((d) => d && fs.existsSync(path.join(d, bin)))) ?? null
  );
}

/** Open a plain shell in the lab's directory — no command, just `cd` there. */
export async function openTerminalHere(labDir: string): Promise<void> {
  await spawnTerminal(labDir);
}

// `command` has no caller — the only entry point is `openTerminalHere`, which opens a
// plain shell. It is kept, with the per-platform branches that serve it, because it is the whole
// reason `terminalCommand`'s "{cmd}" placeholder exists, and because the macOS throwaway-script
// path (mkdtemp + "wx" + cleanup) is deliberate in every detail and would be worse to re-derive
// from scratch than to leave in place.
async function spawnTerminal(labDir: string, command?: string): Promise<void> {
  if (!fs.existsSync(labDir)) throw new Error(`lab directory does not exist: ${labDir}`);

  const override = readPrefs().terminalCommand;
  if (override?.length) {
    const argv = override.map((part) => part.replace("{cmd}", command ?? ""));
    log(`system terminal (override): ${argv.join(" ")}`);
    spawnDetached(argv[0], argv.slice(1), { cwd: labDir });
    return;
  }

  if (process.platform === "darwin") {
    if (!command) {
      spawnDetached("open", ["-a", "Terminal", labDir]);
      return;
    }
    // Terminal.app takes a file to run, not a command, so hand it a throwaway script — in its
    // own unique directory (mkdtemp, not a predictable `Date.now()` name directly under
    // os.tmpdir()) and opened with `wx` so a pre-existing file/symlink at that path makes this
    // fail loudly instead of writing through it.
    const scriptDir = await fsp.mkdtemp(path.join(os.tmpdir(), "kathara-terminal-"));
    const script = path.join(scriptDir, "run.command");
    const handle = await fsp.open(script, "wx", 0o755);
    try {
      await handle.writeFile(`#!/bin/sh\ncd ${JSON.stringify(labDir)}\n${command}\n`);
    } finally {
      await handle.close();
    }
    spawnDetached("open", ["-a", "Terminal", script]);
    // Terminal.app reads the script right after opening; this process has no way to know when
    // that's done, so best-effort cleanup happens on a generous delay rather than immediately.
    setTimeout(() => {
      fsp.rm(scriptDir, { recursive: true, force: true }).catch(() => {});
    }, 30_000);
    return;
  }

  if (process.platform === "win32") {
    // Windows Terminal when present, the legacy console otherwise.
    const hasWt = fs.existsSync(
      path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/WindowsApps/wt.exe"),
    );
    const argv = command
      ? hasWt
        ? ["wt.exe", "-d", labDir, "cmd", "/k", command]
        : ["cmd.exe", "/c", "start", "cmd", "/k", command]
      : hasWt
        ? ["wt.exe", "-d", labDir]
        : ["cmd.exe", "/c", "start", "cmd"];
    spawnDetached(argv[0], argv.slice(1), { cwd: labDir });
    return;
  }

  const argv = linuxTerminalArgv(labDir, command ? `${command}; exec sh` : undefined);
  if (!argv) {
    throw new Error(
      "No supported terminal emulator was found. Set \"terminalCommand\" in preferences.json " +
        "(use {cmd} where the command should go).",
    );
  }
  log(`system terminal: ${argv.join(" ")}`);
  spawnDetached(argv[0], argv.slice(1), { cwd: labDir });
}
