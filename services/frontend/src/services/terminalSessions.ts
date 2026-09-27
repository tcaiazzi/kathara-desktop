// Naming and persistence for the workspace's terminal sessions and the dock panels that show them,
// in one place. A saved layout stores only panel ids and panel params, so a restored session is
// read back from them: the session a detached terminal panel shows comes from its id, and the
// sessions of the Terminals tab, with their split groups, come from that tab's params. The formats
// written here must be the ones parsed here.

import { leafIds, loadTree, saveTree, type SavedSplitNode, type TerminalGroup } from "./terminalSplits";

export interface TerminalSessionInfo {
  /** `<machine>:<n>`, never reused while the workspace is mounted. */
  id: string;
  machine: string;
  /** Per-machine instance number, shown as `<machine> #<n>`. */
  num: number;
}

/** The Terminals tab's dockview panel id, which a saved layout records. */
export const TERMINALS_PANEL_ID = "terminals";

/** The drag payload type of a terminal dragged from the Terminals tab, by its list row or its pane
 *  header (hooks/useTerminalPaneDrop); its value is the session id. Its own type, so the dock
 *  accepts this drag and no other outside one. */
export const TERMINAL_DRAG_TYPE = "application/x-kathara-terminal";

/** Marks a pane of the Terminals tab, where such a drag splits the pane rather than detaching the
 *  terminal: the dock shows no drop overlay of its own over an element carrying it. */
export const TERMINAL_DROP_TARGET_ATTR = "data-terminal-drop-target";

const TERMINAL_PANEL_PREFIX = "terminal:";
// The machine part is greedy, so a device name containing ":" still parses: only the last
// segment is the instance number.
const SESSION_ID_RE = /^(.*):(\d+)$/;

export function terminalSession(machine: string, num: number): TerminalSessionInfo {
  return { id: `${machine}:${num}`, machine, num };
}

/** The dockview panel id showing `sessionId` on its own. */
export function terminalPanelId(sessionId: string): string {
  return `${TERMINAL_PANEL_PREFIX}${sessionId}`;
}

/** The session an id names, or null for a string that is not one. */
export function sessionOfId(id: string): TerminalSessionInfo | null {
  const match = SESSION_ID_RE.exec(id);
  if (!match) return null;
  const [, machine, numStr] = match;
  return terminalSession(machine, Number(numStr));
}

/** The session a terminal panel shows, or null for any other panel. */
export function sessionOfTerminalPanel(panelId: string): TerminalSessionInfo | null {
  return panelId.startsWith(TERMINAL_PANEL_PREFIX) ? sessionOfId(panelId.slice(TERMINAL_PANEL_PREFIX.length)) : null;
}

export function terminalTitle(session: TerminalSessionInfo): string {
  return `${session.machine} #${session.num}`;
}

/** What the Terminals tab keeps in its dockview params: its split groups, in list order, and the
 *  session it shows. */
export interface TerminalsTabParams {
  groups: SavedSplitNode[];
  activeId: string | null;
}

export function terminalsTabParams(groups: TerminalGroup[], activeId: string | null): TerminalsTabParams {
  const describe = (id: string) => {
    const session = sessionOfId(id);
    return session ? { machine: session.machine, num: session.num } : { machine: id, num: 0 };
  };
  return { groups: groups.map((g) => saveTree(g.root, describe)), activeId };
}

/** Reads params back from a saved layout, which may be missing, stale or hand-edited: a leaf that is
 *  not a well-formed session, or names one already placed, is dropped, and an active id naming no
 *  remaining session falls back to the first. Params from before split groups carry a flat
 *  `sessions` list instead; each of those becomes a group of its own. */
export function parseTerminalsTabParams(params: unknown): {
  sessions: TerminalSessionInfo[];
  groups: TerminalGroup[];
  activeId: string | null;
} {
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const accept = (machine: unknown, num: unknown): string | null => {
    if (typeof machine !== "string" || !machine || typeof num !== "number" || !Number.isInteger(num) || num < 1) {
      return null;
    }
    const id = terminalSession(machine, num).id;
    if (seen.has(id)) return null;
    seen.add(id);
    return id;
  };
  const rawGroups = Array.isArray(record.groups) ? record.groups : Array.isArray(record.sessions) ? record.sessions : [];
  const groups: TerminalGroup[] = [];
  for (const raw of rawGroups) {
    const root = loadTree(raw, accept);
    if (root) groups.push({ id: leafIds(root)[0], root });
  }
  const ids = groups.flatMap((g) => leafIds(g.root));
  const sessions = ids.flatMap((id) => sessionOfId(id) ?? []);
  const activeId = typeof record.activeId === "string" && seen.has(record.activeId) ? record.activeId : (ids[0] ?? null);
  return { sessions, groups, activeId };
}

/** A dock panel being dropped, as dockview describes the drop: onto a tab (`targetPanelId` is that
 *  tab's panel), onto a group's content (`activePanelId` is the panel it shows), or elsewhere. */
export interface PanelDrop {
  kind: string;
  position: string;
  targetPanelId?: string;
  activePanelId?: string;
}

/** Whether a drop puts a detached terminal back into the Terminals tab: onto that tab itself, or onto
 *  the middle of its content while it is showing. An edge of its content still splits, as for any
 *  other panel, so a terminal can still be docked beside the tab. */
export function isDropIntoTerminalsTab(drop: PanelDrop): boolean {
  if (drop.kind === "tab") return drop.targetPanelId === TERMINALS_PANEL_ID;
  return drop.kind === "content" && drop.position === "center" && drop.activePanelId === TERMINALS_PANEL_ID;
}

/** The Terminals tab's list width, in pixels: dragged between these bounds, and remembered per
 *  viewer (TerminalsPanel). */
export const LIST_WIDTH = { min: 140, max: 360, initial: 232 };

export function clampListWidth(px: number): number {
  return Math.round(Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, px)));
}

/** A remembered list width read back from storage, which may hold anything, or nothing. */
export function storedListWidth(raw: string | null): number {
  const px = raw === null ? NaN : Number(raw);
  return Number.isFinite(px) ? clampListWidth(px) : LIST_WIDTH.initial;
}
