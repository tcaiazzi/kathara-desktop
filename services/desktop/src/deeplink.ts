/**
 * kathara:// deep links.
 *
 * Only "kathara://lab/<name>" is understood; anything else is ignored rather than guessed at.
 * The URL arrives differently per platform — in argv on Windows/Linux (via the
 * single-instance "second-instance" event, or the initial argv on a cold start) and through
 * "open-url" on macOS — so all three paths funnel into handleDeepLink. Parsing the link into a
 * route lives in deepLinkRoute.ts.
 */
import { app, BrowserWindow } from "electron";
import { DEEP_LINK_PROTOCOL as PROTOCOL, resolveDeepLink } from "./deepLinkRoute";
import { log } from "./logger";

/** A renderer route, or null when the URL isn't one we handle. */
function parseDeepLink(raw: string): string | null {
  const resolved = resolveDeepLink(raw);
  if (resolved.kind === "unparsable") log(`ignoring unparsable deep link: ${raw}`);
  if (resolved.kind === "unrecognised") log(`ignoring unrecognised deep link: ${raw}`);
  return resolved.kind === "route" ? resolved.route : null;
}

export function registerProtocol(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  } else {
    // In dev the executable is Electron itself, so the launcher has to be told which app to run.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [app.getAppPath()]);
  }
}

export function handleDeepLink(win: BrowserWindow | null, raw: string): void {
  const route = parseDeepLink(raw);
  if (!route || !win) return;
  log(`deep link -> ${route}`);
  if (win.isMinimized()) win.restore();
  win.focus();
  // Sent to the renderer so react-router navigates in place; reloading the URL would throw
  // away the dock layout and every open terminal.
  win.webContents.send("deeplink", route);
}
