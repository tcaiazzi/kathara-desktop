/** Window creation and the navigation policy that keeps the renderer pinned to the backend. */
import { app, BrowserWindow, Menu, nativeTheme, shell } from "electron";
import path from "node:path";
import { log } from "./logger";
import { iconPath, setupPage } from "./paths";

const PRELOAD = path.join(__dirname, "preload.js");

/**
 * The colour Chromium paints before the page has any of its own, matched to the theme the page is
 * about to choose: setup.html follows the OS scheme, and so does the SPA when the user has never
 * picked a theme explicitly (services/frontend/index.html). Hardcoding the dark value made every
 * light-theme launch start with a dark rectangle.
 *
 * Read at window-creation time, not tracked: someone who *has* explicitly chosen the theme
 * opposite to their OS still gets one mismatched frame here, because only the renderer knows
 * about that choice (it lives in its localStorage). Not worth a bridge call and a preferences
 * round trip for a single frame of colour.
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#151b23" : "#ffffff";
}

/** The frontend's popup terminal route (services/frontend/src/services/terminalWindow.ts). */
const TERMINAL_ROUTE = /^\/labs\/[^/]+\/terminal\/[^/]+$/;

function sameOrigin(url: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * Anything that isn't the app's own origin is handed to the user's browser rather than opened
 * in a Chromium window with no address bar. That covers the published-port links the topology
 * view builds (services/frontend/src/components/TopologyGraph.tsx), which point at arbitrary
 * host ports and are not part of the app.
 */
function openExternally(url: string): void {
  if (/^https?:\/\//.test(url)) {
    log(`opening externally: ${url}`);
    void shell.openExternal(url);
  } else {
    log(`refused to open non-http(s) URL: ${url}`);
  }
}

/**
 * Applied to *every* WebContents the app ever creates, via web-contents-created — not just the
 * main window. Popups created through the handler below (the terminal windows) are themselves
 * full windows that can call window.open and navigate; wiring the policy per-window left those
 * children unguarded, so an external URL opened from a terminal window bypassed it entirely.
 */
export function installNavigationPolicy(origin: () => string | null): void {
  app.on("web-contents-created", (_event, contents) => {
    log(`navigation policy attached to WebContents ${contents.id} (type=${contents.getType()})`);
    applyNavigationPolicy(contents, origin);
  });
}

function applyNavigationPolicy(contents: Electron.WebContents, origin: () => string | null): void {
  contents.setWindowOpenHandler(({ url }) => {
    log(`window-open request from WebContents ${contents.id}: ${url}`);
    if (!sameOrigin(url, origin())) {
      openExternally(url);
      return { action: "deny" };
    }
    // Created here rather than by returning `action: "allow"`, so the options below are
    // definitely the ones used: an "allow"ed popup is constructed by Chromium from the opener,
    // and it is not clear that it honours every option in overrideBrowserWindowOptions. That
    // matters because the main window sets `titleBarStyle: "hidden"` and draws its own strip,
    // while these windows render only TerminalWindowPage — inheriting a hidden title bar would
    // leave them with no title, no drag region and no close button. Passing no titleBarStyle
    // here means the platform default: a normal framed window showing "Terminal: <device>".
    const isTerminal = TERMINAL_ROUTE.test(new URL(url).pathname);
    const popup = new BrowserWindow({
      width: isTerminal ? 900 : 1100,
      height: isTerminal ? 600 : 800,
      icon: iconPath(),
      backgroundColor: windowBackground(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // The navigation policy reaches it through the app-wide web-contents-created hook.
    void popup.loadURL(url);
    return { action: "deny" };
  });

  // In-page navigation away from the app (a stray link, a redirect) must not replace the UI.
  contents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, origin())) {
      event.preventDefault();
      openExternally(url);
    }
  });
}

/**
 * Native Cut/Copy/Paste for every editable element in every WebContents the app ever creates
 * (the main window and the terminal popups alike) — Electron shows no context menu at all by
 * default, so without this a right-click inside the CodeMirror editor (or any text input) does
 * nothing. Scoped to `params.isEditable` so it never appears over read-only content.
 */
export function installEditContextMenu(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("context-menu", (_e, params) => {
      if (!params.isEditable) return;
      const { editFlags } = params;
      Menu.buildFromTemplate([
        { label: "Cut", role: "cut", enabled: editFlags.canCut },
        { label: "Copy", role: "copy", enabled: editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: editFlags.canPaste },
      ]).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
    });
  });
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: windowBackground(),
    show: false,
    title: "Kathara IDE",
    icon: iconPath(),
    // No native title bar: the app draws its own strip (frontend desktop/TitleBar.tsx) carrying
    // the menu, the title and the drag region, so there is one bar instead of the stacked
    // title-bar-plus-menu-bar pair. On macOS this leaves the native traffic lights in place
    // (nothing more to do there); on Windows/Linux it leaves *no* window controls at all — no
    // titleBarOverlay is requested, because Chromium's overlay buttons only take a background
    // and symbol colour, not a different icon style, which is exactly what looked out of place.
    // TitleBar.tsx draws its own minimize/maximize/close buttons there instead (VS Code's
    // approach), driven by the window:minimize/maximize/unmaximize/close IPC below.
    titleBarStyle: "hidden",
    webPreferences: {
      preload: PRELOAD,
      // The renderer runs the frontend over HTTP; it gets no Node access, and reaches the shell
      // only through the narrow, explicitly-exposed bridge in preload.ts.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (process.platform !== "darwin") {
    // Hide the native menu bar: the strip renders the same menu in HTML. The Menu itself stays
    // registered, because that is what binds the keyboard accelerators. On macOS the menu lives
    // in the system bar and must stay visible.
    win.setMenuBarVisibility(false);
    win.autoHideMenuBar = true;
  }

  // Keeps the custom maximize/restore button in sync with every way the window can actually
  // change state — our own button, a double-click on the drag region, Aero Snap, dragging to a
  // screen edge — not just the one path the button itself drives.
  const pushState = () => win.webContents.send("window:state", { maximized: win.isMaximized() });
  win.on("maximize", pushState);
  win.on("unmaximize", pushState);

  win.once("ready-to-show", () => win.show());
  return win;
}

/** The status page: shown while the backend starts, and when startup fails. */
export function showSetupPage(win: BrowserWindow): void {
  void win.loadFile(setupPage());
}
