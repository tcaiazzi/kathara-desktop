// Naming for the workspace's terminal sessions and the dock panels that show them, in one place: a
// saved layout stores only panel ids, so the session a restored panel belongs to is read back from
// its id, and the two formats must not drift apart.

export interface TerminalSessionInfo {
  /** `<machine>:<n>`, never reused while the workspace is mounted. */
  id: string;
  machine: string;
  /** Per-machine instance number, shown as `<machine> #<n>`. */
  num: number;
}

const TERMINAL_PANEL_PREFIX = "terminal:";
// The machine part is greedy, so a device name containing ":" still parses: only the last
// segment is the instance number.
const TERMINAL_PANEL_ID_RE = /^terminal:(.*):(\d+)$/;

/** The dockview panel id showing `sessionId` on its own. */
export function terminalPanelId(sessionId: string): string {
  return `${TERMINAL_PANEL_PREFIX}${sessionId}`;
}

/** The session a terminal panel shows, or null for any other panel. */
export function sessionOfTerminalPanel(panelId: string): TerminalSessionInfo | null {
  const match = TERMINAL_PANEL_ID_RE.exec(panelId);
  if (!match) return null;
  const [, machine, numStr] = match;
  return { id: panelId.slice(TERMINAL_PANEL_PREFIX.length), machine, num: Number(numStr) };
}

export function terminalTitle(session: TerminalSessionInfo): string {
  return `${session.machine} #${session.num}`;
}
