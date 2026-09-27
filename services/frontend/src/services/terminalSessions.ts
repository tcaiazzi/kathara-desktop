// Naming and persistence for the workspace's terminal sessions and the dock panels that show them,
// in one place. A saved layout stores only panel ids and panel params, so a restored session is
// read back from them: the session a detached terminal panel shows comes from its id, and the
// sessions of the Terminals tab come from that tab's params. The formats written here must be the
// ones parsed here.

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

export function terminalSession(machine: string, num: number): TerminalSessionInfo {
  return { id: `${machine}:${num}`, machine, num };
}

/** The dockview panel id showing `sessionId` on its own. */
export function terminalPanelId(sessionId: string): string {
  return `${TERMINAL_PANEL_PREFIX}${sessionId}`;
}

/** The session a terminal panel shows, or null for any other panel. */
export function sessionOfTerminalPanel(panelId: string): TerminalSessionInfo | null {
  const match = TERMINAL_PANEL_ID_RE.exec(panelId);
  if (!match) return null;
  const [, machine, numStr] = match;
  return terminalSession(machine, Number(numStr));
}

export function terminalTitle(session: TerminalSessionInfo): string {
  return `${session.machine} #${session.num}`;
}

/** What the Terminals tab keeps in its dockview params: its sessions, in list order, and the one
 *  it shows. */
export interface TerminalsTabParams {
  sessions: { machine: string; num: number }[];
  activeId: string | null;
}

export function terminalsTabParams(sessions: TerminalSessionInfo[], activeId: string | null): TerminalsTabParams {
  return { sessions: sessions.map(({ machine, num }) => ({ machine, num })), activeId };
}

/** Reads params back from a saved layout, which may be missing, stale or hand-edited: anything that
 *  is not a well-formed session is dropped, and an active id naming no remaining session is too. */
export function parseTerminalsTabParams(params: unknown): { sessions: TerminalSessionInfo[]; activeId: string | null } {
  if (typeof params !== "object" || params === null) return { sessions: [], activeId: null };
  const { sessions: rawSessions, activeId: rawActive } = params as Record<string, unknown>;
  const sessions: TerminalSessionInfo[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(rawSessions) ? rawSessions : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const { machine, num } = raw as Record<string, unknown>;
    if (typeof machine !== "string" || !machine || typeof num !== "number" || !Number.isInteger(num) || num < 1) {
      continue;
    }
    const session = terminalSession(machine, num);
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  const activeId = typeof rawActive === "string" && seen.has(rawActive) ? rawActive : (sessions[0]?.id ?? null);
  return { sessions, activeId };
}

/** The session a list shows after `closedId` leaves it: unchanged unless the closed one was the
 *  active one, in which case the one that took its place, else the one before it — the way closing
 *  an editor tab lands on its neighbour. `ids` is the list before the close. */
export function activeAfterClose(ids: string[], closedId: string, activeId: string | null): string | null {
  if (activeId !== closedId) return activeId;
  const index = ids.indexOf(closedId);
  const rest = ids.filter((id) => id !== closedId);
  if (!rest.length) return null;
  return rest[Math.min(index, rest.length - 1)] ?? rest[0];
}
