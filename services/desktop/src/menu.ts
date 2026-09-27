/**
 * The native application menu.
 *
 * Items that act on the UI don't reimplement anything: they send a "menu:action" to the
 * renderer, where DesktopCommandsProvider (frontend src/desktop/DesktopCommands.tsx) fans it out
 * to whichever components registered that action through `useDesktopCommand`.
 * Items that act on the shell itself (logs, labs folder, DevTools) are handled here, and so is
 * Open Lab Folder…, through the callback main.ts passes in: the folder is picked and opened on
 * this side, never by the renderer (see main.ts's openFolderAsLab).
 */
import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { backendLogPath } from "./backend";
import { openLabsDir } from "./integrations";

/** The shell's copy, imported as a type by preload.ts. Kept in sync by hand with the renderer's
 *  own DesktopMenuAction (frontend src/desktop/bridge.ts), which is a separate npm package and so
 *  cannot import this one — see preload.ts's closing comment. */
export type MenuAction =
  | "lab:new"
  | "lab:import"
  | "lab:browse"
  | "lab:save"
  | "lab:deploy"
  | "lab:undeploy"
  | "lab:reload"
  | "view:settings"
  | "view:toggle-theme"
  | "help:tour";

// The renderer keeps its own copies (frontend src/services/constants.ts): the main process shares
// no module graph with it, so the two are kept in step by hand.
const DOCS_URL = "https://www.kathara.org/";
const ISSUES_URL = "https://github.com/KatharaFramework/kathara-desktop/issues/new";

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

export interface MenuHandlers {
  /** File → Open Lab Folder…: main.ts's native dialog and open flow. */
  openLabFolder: () => void;
}

export function buildMenu(handlers: MenuHandlers): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    // macOS requires the first menu to be the application menu.
    ...(isMac
      ? ([{ role: "appMenu" }] satisfies MenuItemConstructorOptions[])
      : []),
    // A bare `role: "editMenu"` would register Cmd/Ctrl+C/X/V/A as *native* accelerators,
    // intercepted by Electron before the keydown ever reaches the renderer — the same reason
    // Save below is registered without one. registerAccelerator: false on Copy/Cut/Paste/
    // SelectAll lets the fs explorer's own scoped keydown listener
    // (useFsClipboardShortcuts) and react-arborist's built-in Ctrl/Cmd+A handle them instead;
    // normal text-field editing still works, since the browser handles those keys natively
    // whenever nothing has intercepted them. Undo/Redo/Delete keep native handling — no
    // renderer feature competes for those keys.
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut", registerAccelerator: false },
        { role: "copy", registerAccelerator: false },
        { role: "paste", registerAccelerator: false },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll", registerAccelerator: false },
      ],
    },
    {
      label: "File",
      submenu: [
        item("New Lab…", "lab:new", "CmdOrCtrl+N"),
        { label: "Open Lab Folder…", accelerator: "CmdOrCtrl+O", click: () => handlers.openLabFolder() },
        item("Import Lab (.zip)…", "lab:import", "CmdOrCtrl+Shift+O"),
        item("Browse Kathara Labs…", "lab:browse"),
        { type: "separator" },
        // registerAccelerator: false — the renderer owns Ctrl/Cmd+S (useSaveShortcut saves
        // whichever editor panel has focus). Registering it natively would swallow the
        // keystroke before the page ever saw it, breaking in-editor saving.
        { ...item("Save", "lab:save", "CmdOrCtrl+S"), registerAccelerator: false },
        { type: "separator" },
        { label: "Show Labs Folder", click: () => openLabsDir() },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    // Acts on the lab open in the focused window; the renderer ignores the ones that don't apply
    // (Deploy on a running lab, anything with no lab open) and says so.
    {
      label: "Lab",
      submenu: [
        item("Deploy Lab", "lab:deploy", "CmdOrCtrl+Shift+D"),
        item("Undeploy Lab", "lab:undeploy", "CmdOrCtrl+Shift+U"),
        { type: "separator" },
        item("Reload Lab", "lab:reload", "CmdOrCtrl+Shift+R"),
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
        item("Toggle Dark Theme", "view:toggle-theme"),
        // Kept in release builds on purpose: the UI drives a local API, and the console is
        // often the fastest way for a user to tell us what went wrong.
        { role: "toggleDevTools" },
      ],
    },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ role: "front" as const }] : [])] },
    {
      role: "help",
      submenu: [
        { label: "Kathará Website", click: () => void shell.openExternal(DOCS_URL) },
        { label: "Show Backend Log", click: () => void shell.openPath(backendLogPath()) },
        item("Show Onboarding Tour", "help:tour"),
        { label: "Report an Issue…", click: () => void shell.openExternal(ISSUES_URL) },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
