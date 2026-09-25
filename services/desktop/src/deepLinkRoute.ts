/**
 * Turning a kathara:// deep link into a renderer route. Free of any `electron` import, like
 * safety.ts, so it can be checked without an Electron runtime; deeplink.ts does the registering,
 * the logging and the navigation.
 *
 * Only "kathara://lab/<name>" is understood; anything else is ignored rather than guessed at.
 * A link names the lab the way a person would, but the Workspace route takes the lab's id — which
 * only the backend can derive, from the lab directory's path — so the name travels as the
 * `?lab=` query instead and the renderer resolves it (DesktopCommands.tsx).
 */

export const DEEP_LINK_PROTOCOL = "kathara";

/** What a raw deep link resolves to. `unparsable` and `unrecognised` are kathara:// links worth a
 *  log line; `foreign` is anything else (not a URL, or another scheme) and is dropped silently. */
export type DeepLinkResolution =
  | { kind: "route"; route: string }
  | { kind: "unparsable" }
  | { kind: "unrecognised" }
  | { kind: "foreign" };

export function resolveDeepLink(raw: string): DeepLinkResolution {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "foreign" };
  }
  if (url.protocol !== `${DEEP_LINK_PROTOCOL}:`) return { kind: "foreign" };

  try {
    // "kathara://lab/foo" parses with host="lab" and pathname="/foo". decodeURIComponent throws
    // a URIError on a malformed %-escape (e.g. a lone "%" or an invalid UTF-8 sequence) — this
    // must not propagate past here uncaught, since a link like this is reachable from any web
    // page's <a href="kathara://..."> and would otherwise crash the whole main process.
    const segments = [url.hostname, ...url.pathname.split("/")].filter(Boolean).map(decodeURIComponent);
    if (segments.length === 2 && segments[0] === "lab") {
      return { kind: "route", route: `/workspace?lab=${encodeURIComponent(segments[1])}` };
    }
  } catch {
    return { kind: "unparsable" };
  }
  return { kind: "unrecognised" };
}

/** Extract a deep link from a process argv (Windows/Linux). */
export function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_PROTOCOL}://`)) ?? null;
}
