/**
 * The native application menu.
 *
 * Items that act on the UI don't reimplement anything: they send a "menu:action" to the
 * renderer, where useDesktopMenu maps each action onto the command the toolbar already runs.
 * Items that act on the shell itself (logs, labs folder, DevTools) are handled here.
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { backendLogPath } from "./backend";
import { openLabsDir } from "./integrations";

/** Kept in sync with the renderer's DesktopMenuAction union (frontend src/desktop/bridge.ts). */
export type MenuAction =
  | "lab:new"
  | "lab:import"
  | "lab:save"
  | "lab:deploy"
  | "lab:undeploy"
  | "lab:reload"
  | "view:settings";

const DOCS_URL = "https://www.kathara.org/";

function send(action: MenuAction): void {
  // Fall back to the first window: getFocusedWindow() is null whenever the OS focus sits
  // outside the app, and on macOS the menu bar is usable in exactly that state — without the
  // fallback those menu items would silently do nothing.
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  target?.webContents.send("menu:action", action);
}

function item(label: string, action: MenuAction, accelerator?: string): MenuItemConstructorOptions {
  return { label, accelerator, click: () => send(action) };
}

export function buildMenu(): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    // macOS requires the first menu to be the application menu.
    ...(isMac
      ? ([{ role: "appMenu" }] satisfies MenuItemConstructorOptions[])
      : []),
    // Without this, macOS has no key-equivalents to route Cmd+C/V/X/Z/A to, so clipboard and
    // undo shortcuts silently do nothing anywhere in the app (not just in editable fields).
    { role: "editMenu" },
    {
      label: "File",
      submenu: [
        item("New Lab…", "lab:new", "CmdOrCtrl+N"),
        item("Import Lab…", "lab:import", "CmdOrCtrl+O"),
        { type: "separator" },
        // registerAccelerator: false — the renderer owns Ctrl/Cmd+S (useSaveShortcut saves
        // whichever editor panel has focus). Registering it natively would swallow the
        // keystroke before the page ever saw it, breaking in-editor saving.
        { ...item("Save", "lab:save", "CmdOrCtrl+S"), registerAccelerator: false },
        { type: "separator" },
        { label: "Open Labs Folder", click: () => openLabsDir() },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        // Electron's default zoomIn accelerator is "CmdOrCtrl+Plus", but "+" is a shifted
        // character on standard keyboard layouts, so it only fires as Ctrl+Shift+=. Overriding
        // to the bare "=" key (which is what physically sits under Ctrl++ /-) makes Ctrl++ work
        // on its own, matching Ctrl+- right below it.
        { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        // Kept in release builds on purpose: the UI drives a local API, and the console is
        // often the fastest way for a user to tell us what went wrong.
        { role: "toggleDevTools" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ role: "front" as const }] : [])] },
    {
      role: "help",
      submenu: [
        { label: "Kathara Documentation", click: () => void shell.openExternal(DOCS_URL) },
        { label: "Show Backend Log", click: () => void shell.openPath(backendLogPath()) },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
