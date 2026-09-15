/**
 * kathara:// deep links.
 *
 * Only "kathara://lab/<name>" is understood today; anything else is ignored rather than
 * guessed at. The URL arrives differently per platform — in argv on Windows/Linux (via the
 * single-instance "second-instance" event, or the initial argv on a cold start) and through
 * "open-url" on macOS — so all three paths funnel into handleDeepLink.
 */
import { app, BrowserWindow } from "electron";
import { log } from "./logger";

export const PROTOCOL = "kathara";

/** A renderer route, or null when the URL isn't one we handle. */
export function parseDeepLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:`) return null;

  try {
    // "kathara://lab/foo" parses with host="lab" and pathname="/foo". decodeURIComponent throws
    // a URIError on a malformed %-escape (e.g. a lone "%" or an invalid UTF-8 sequence) — this
    // must not propagate past here uncaught, since a link like this is reachable from any web
    // page's <a href="kathara://..."> and would otherwise crash the whole main process.
    const segments = [url.hostname, ...url.pathname.split("/")].filter(Boolean).map(decodeURIComponent);
    if (segments.length === 2 && segments[0] === "lab") {
      return `/workspace/${encodeURIComponent(segments[1])}`;
    }
  } catch {
    log(`ignoring unparsable deep link: ${raw}`);
    return null;
  }
  log(`ignoring unrecognised deep link: ${raw}`);
  return null;
}

export function registerProtocol(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  } else {
    // In dev the executable is Electron itself, so the launcher has to be told which app to run.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [app.getAppPath()]);
  }
}

/** Extract a deep link from a process argv (Windows/Linux). */
export function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`)) ?? null;
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
