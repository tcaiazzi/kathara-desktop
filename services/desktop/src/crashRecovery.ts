/**
 * What the shell does when the backend dies in the middle of a session, and the theme choice the
 * setup page borrows from the SPA. Free of any `electron` import, like safety.ts, so it can be
 * checked without an Electron runtime.
 */

/** How long one automatic restart covers: a backend that dies again within this window is left
 * down, and the crash page says so, rather than being restarted over and over. */
export const AUTO_RESTART_WINDOW_MS = 5 * 60_000;

/** Whether a backend that just died should be restarted without asking: yes, unless the last
 * automatic restart was less than AUTO_RESTART_WINDOW_MS ago — then it is most likely going to
 * die again, and the user gets the crash page with its log and a Restart button instead. */
export function shouldAutoRestart(lastAutoRestartAt: number | null, now: number): boolean {
  return lastAutoRestartAt === null || now - lastAutoRestartAt >= AUTO_RESTART_WINDOW_MS;
}

/** The part of the renderer's URL a restart should land back on (path and query, e.g.
 * `/workspace/<lab id>`), or undefined when the renderer isn't showing the app — the setup or
 * splash page, or a URL that doesn't parse. */
export function resumePathOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const path = `${parsed.pathname}${parsed.search}`;
    return path === "/" ? undefined : path;
  } catch {
    return undefined;
  }
}

export type UiTheme = "light" | "dark";

/** The theme the SPA reports the user picked (ui:set-theme), or null — follow the OS — for
 * anything else: the argument comes over IPC, so its type is only a claim. */
export function parseUiTheme(value: unknown): UiTheme | null {
  return value === "light" || value === "dark" ? value : null;
}
