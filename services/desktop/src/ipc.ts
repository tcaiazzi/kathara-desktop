/**
 * The one door every `ipcMain` channel goes through, so that "which page is calling?" is answered
 * in a single place instead of being each handler's own business.
 *
 * Nothing about `ipcMain.handle` says who sent the message. Every handler in main.ts hands out
 * something the renderer could not do for itself: restart the backend as root, move the lab
 * storage root, open a native dialog, reach the shell. The navigation policy in windows.ts keeps
 * the main frame pinned to the app's own origin, but it watches `will-navigate`, which does not
 * fire for a server-side redirect: a navigation that starts on the app's origin and gets 302'd
 * elsewhere lands the top frame on a foreign origin with this preload still attached. This check
 * is what makes that landing harmless, and it is the reason the door exists at all.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { log } from "./logger";
import { setupPage, splashPage } from "./paths";
import { isTrustedRendererUrl } from "./safety";

/** The two local pages this shell loads with `loadFile`; everything else it loads is the SPA over
 * loopback HTTP. Read per call rather than hoisted: `setupPage()`/`splashPage()` derive from
 * `__dirname`, and a module-level constant here would freeze them before `app` is ready. */
function appPages(): string[] {
  return [setupPage(), splashPage()];
}

/**
 * Whether this call came from a page this shell itself put on screen.
 *
 * Two conditions, and the first is the one that carries the weight: the sender must be a **top**
 * frame. No page this app loads is ever a subframe, so anything arriving from one is by
 * definition not the app asking. No route into that branch exists (the frontend embeds no iframe,
 * and a sandboxed preload isn't injected into subframes anyway), which is precisely why the check
 * belongs here rather than in whatever change first adds an iframe or flips
 * `nodeIntegrationInSubFrames`.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  try {
    const frame = event.senderFrame;
    // Null, or an access that throws, means the frame was disposed between the renderer's
    // `invoke` and this handler — a page being torn down by a reload. Refusing is right either
    // way: there is no longer anyone to answer.
    if (!frame || frame !== frame.top) return false;
    return isTrustedRendererUrl(frame.url, appPages());
  } catch {
    return false;
  }
}

/** The sender's URL for the refusal log — clamped, because it is renderer-controlled content
 * going into a file the user is invited to read (same reasoning as `shell:log-renderer-error`). */
function describeSender(event: IpcMainInvokeEvent): string {
  try {
    return event.senderFrame?.url.slice(0, 200) ?? "a disposed frame";
  } catch {
    return "a disposed frame";
  }
}

/**
 * `ipcMain.handle` with the sender checked first. Same signature, so a call site changes only in
 * the name — which is the point: the rule is "every channel", and a handler registered the plain
 * way would silently opt out of it.
 *
 * A refusal throws rather than returning a quiet `null`: the renderer's `invoke` rejects, so a
 * mistake shows up as an error someone can act on instead of a value that happens to be empty.
 * No legitimate caller ever reaches it.
 */
export function handleIpc<A extends unknown[], R>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: A) => R,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      log(`refused ${channel} from ${describeSender(event)}`);
      throw new Error(`refused: ${channel}`);
    }
    return listener(event, ...(args as A));
  });
}
