/**
 * The parts of the UI that only a desktop app can offer: native file dialogs, revealing a lab
 * in the OS file manager, and attaching to a device from a real terminal emulator.
 *
 * Every one of these is exposed to the renderer through preload.ts and used behind a
 * feature check, so the browser build keeps working unchanged.
 */
import { dialog, shell, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
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

export interface PickedFile {
  name: string;
  /** Bytes, so the renderer can wrap them in a File and reuse the existing upload path. */
  data: Uint8Array;
}

/** Native "Import lab" picker. Returns null when the user cancels. */
export async function pickLabArchive(win: BrowserWindow | null): Promise<PickedFile | null> {
  const result = await withParent(dialog.showOpenDialog, win, {
    title: "Import lab",
    properties: ["openFile"],
    filters: [
      { name: "Lab archive", extensions: ["zip"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  const file = result.filePaths[0];
  if (result.canceled || !file) return null;
  return { name: path.basename(file), data: await fsp.readFile(file) };
}

/** Native "Save as…" for a download the renderer already has in memory. */
export async function saveFile(
  win: BrowserWindow | null,
  suggestedName: string,
  data: Uint8Array,
): Promise<string | null> {
  const result = await withParent(dialog.showSaveDialog, win, {
    title: "Save",
    defaultPath: path.join(os.homedir(), suggestedName),
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, data);
  log(`saved ${result.filePath}`);
  return result.filePath;
}

/** Let the user point the app at a specific Python interpreter (the setup screen's escape hatch). */
export async function pickPythonInterpreter(win: BrowserWindow | null): Promise<string | null> {
  const result = await withParent(dialog.showOpenDialog, win, {
    title: "Choose Python interpreter",
    properties: ["openFile", "showHiddenFiles"],
    defaultPath: process.platform === "win32" ? undefined : "/usr",
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
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
    // "/", which names nothing on Windows (same reasoning as pickPythonInterpreter above) — lets
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
 * Build the argv that launches `command` in a terminal window, per platform.
 *
 * On Linux there is no single answer, so the first emulator that exists on PATH wins;
 * a user whose emulator isn't listed can override it in preferences.json with
 * `terminalCommand`, where "{cmd}" is substituted with the shell command.
 */
function linuxTerminalArgv(command: string, cwd: string): string[] | null {
  const candidates: string[][] = [
    ["x-terminal-emulator", "-e", "sh", "-c", command],
    ["gnome-terminal", `--working-directory=${cwd}`, "--", "sh", "-c", command],
    ["konsole", "--workdir", cwd, "-e", "sh", "-c", command],
    ["xfce4-terminal", `--working-directory=${cwd}`, "-x", "sh", "-c", command],
    ["alacritty", "--working-directory", cwd, "-e", "sh", "-c", command],
    ["kitty", "-d", cwd, "sh", "-c", command],
    ["xterm", "-e", "sh", "-c", command],
  ];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return (
    candidates.find(([bin]) => dirs.some((d) => d && fs.existsSync(path.join(d, bin)))) ?? null
  );
}

/**
 * Attach to a running device in the OS's own terminal.
 *
 * `kathara connect` resolves the lab from the working directory, which is why the lab's host
 * path is needed (and why the API grew GET /api/labs/{name}/location to supply it).
 */
export async function openSystemTerminal(labDir: string, machine: string): Promise<void> {
  const safeMachine = /^[A-Za-z0-9_.-]+$/.test(machine) ? machine : null;
  if (!safeMachine) throw new Error(`refusing to open a terminal for suspicious name: ${machine}`);
  if (!fs.existsSync(labDir)) throw new Error(`lab directory does not exist: ${labDir}`);

  const command = `kathara connect ${safeMachine}`;
  const override = readPrefs().terminalCommand;

  if (override?.length) {
    const argv = override.map((part) => part.replace("{cmd}", command));
    log(`system terminal (override): ${argv.join(" ")}`);
    spawn(argv[0], argv.slice(1), { cwd: labDir, detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (process.platform === "darwin") {
    // Terminal.app takes a file to run, not a command, so hand it a throwaway script.
    const script = path.join(os.tmpdir(), `kathara-${safeMachine}-${Date.now()}.command`);
    await fsp.writeFile(script, `#!/bin/sh\ncd ${JSON.stringify(labDir)}\n${command}\n`, {
      mode: 0o755,
    });
    spawn("open", ["-a", "Terminal", script], { detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (process.platform === "win32") {
    // Windows Terminal when present, the legacy console otherwise.
    const argv = fs.existsSync(path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/WindowsApps/wt.exe"))
      ? ["wt.exe", "-d", labDir, "cmd", "/k", command]
      : ["cmd.exe", "/c", "start", "cmd", "/k", command];
    spawn(argv[0], argv.slice(1), { cwd: labDir, detached: true, stdio: "ignore" }).unref();
    return;
  }

  const argv = linuxTerminalArgv(`${command}; exec sh`, labDir);
  if (!argv) {
    throw new Error(
      "No supported terminal emulator was found. Set \"terminalCommand\" in preferences.json " +
        "(use {cmd} where the command should go).",
    );
  }
  log(`system terminal: ${argv.join(" ")}`);
  spawn(argv[0], argv.slice(1), { cwd: labDir, detached: true, stdio: "ignore" }).unref();
}
