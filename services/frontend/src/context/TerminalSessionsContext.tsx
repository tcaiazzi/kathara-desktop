import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { terminalSession, type TerminalSessionInfo } from "../services/terminalSessions";
import {
  activeAfterRemoval,
  addGroup,
  moveBeside,
  removeFrom,
  resizeIn,
  splitIn,
  type DropSide,
  type SplitDirection,
  type TerminalGroup,
} from "../services/terminalSplits";

// The single source of truth for the workspace's live terminal sessions. A session — its xterm,
// its WebSocket, its scrollback — belongs to this registry, not to the dock panel that shows it:
// the panels are only slots (hooks/useTerminalSlot) that borrow the session's host element. That
// is what lets a session change panel without being torn down, which a panel-owned session could
// never do, since a different panel means a different React subtree.
//
// Each session renders once, through components/TerminalSessionHosts, into a host element created
// for it and kept for its whole life. The portal target therefore never changes and React never
// remounts the session; moving it is just moving that host between slots in the DOM. Only this
// registry creates or drops a host, and only a slot attaches one.
//
// The sessions in the Terminals tab are also arranged in split groups (services/terminalSplits):
// every such session is a leaf of exactly one group, and every leaf is such a session.

/** Where a session is shown: in the Terminals tab, or detached into a dock panel of its own
 *  (`terminal:<machine>:<n>`). */
export type TerminalLocation = "tabs" | "panel";

export interface TerminalSessionEntry extends TerminalSessionInfo {
  location: TerminalLocation;
}

/** "idle" is neither connected nor dialling: never connected, disconnected, or the device stopped. */
export type TerminalStatus = "connected" | "connecting" | "idle";

export interface TerminalRegistry {
  /** Every session, in the order they were opened. */
  sessions: TerminalSessionEntry[];
  /** The Terminals tab's split groups, in list order. */
  groups: TerminalGroup[];
  /** The session selected in the Terminals tab, always one located there, or null when it has none.
   *  The tab shows the group holding it. */
  activeId: string | null;
  statuses: Record<string, TerminalStatus>;
  /** The latest request for a session to take keyboard focus; `seq` makes a repeat for the same
   *  session a new value. Opening, splitting, moving and a deliberate selection make one: the
   *  terminal the user just asked for is the one they are about to type into. */
  focusRequest: { id: string; seq: number } | null;
  /** Starts a session for `machine` in a new group of the Terminals tab and selects it; it connects
   *  as soon as it mounts. */
  open: (machine: string) => TerminalSessionEntry;
  /** Starts a session for `machine` beside `targetId`, in its group, and selects it. */
  split: (targetId: string, machine: string, direction: SplitDirection) => void;
  /** Moves a session of the Terminals tab beside another one there, against its `side`, and
   *  selects it: a terminal dragged onto a pane. The session itself is untouched. */
  place: (sourceId: string, targetId: string, side: DropSide) => void;
  /** Ends a session: its socket closes and its scrollback is gone. */
  close: (id: string) => void;
  /** Selects a session; with `focus`, it also takes keyboard focus. A click inside a pane selects
   *  without it, or picking the pane's shell from its dropdown would hand focus to the terminal and
   *  close the dropdown. */
  activate: (id: string, options?: { focus?: boolean }) => void;
  /** Moves a session between the Terminals tab, where it gets a group of its own, and a panel of
   *  its own, without touching the session itself. Moving into the tab selects it there; moving out
   *  selects its neighbour. The caller adds or closes the dock panel; this only records where the
   *  session belongs. */
  move: (id: string, location: TerminalLocation) => void;
  /** The split at `path` in group `groupId` gets `sizes`. */
  resize: (groupId: string, path: number[], sizes: number[]) => void;
  /** Replaces the whole state, for a layout restored from storage. Seeds the per-machine counters
   *  from it, so a session opened afterwards cannot take a restored session's id. */
  adopt: (sessions: TerminalSessionEntry[], groups: TerminalGroup[], activeId: string | null) => void;
  /** Reported by each session, for the Terminals tab's list. */
  setStatus: (id: string, status: TerminalStatus) => void;
  /** The session's host element, created on first request. Only this module and its slots use it. */
  hostFor: (id: string) => HTMLElement;
  /** A second element per session, for its compact toolbar in a pane header of a split group, where
   *  the toolbar sits outside the session's own host. Created and dropped with the host. */
  toolbarHostFor: (id: string) => HTMLElement;
}

interface RegistryState {
  sessions: TerminalSessionEntry[];
  groups: TerminalGroup[];
  activeId: string | null;
}

// The element `map` keeps for `id`, created on first request.
function elementIn(map: Map<string, HTMLElement>, id: string, className: string): HTMLElement {
  let el = map.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = className;
    map.set(id, el);
  }
  return el;
}

// The registry's state and actions. Called once, by the workspace page, which needs `open` and
// `close` outside the provider; everything under the provider reads the same object through
// useTerminalSessions. Every action is stable, so dockview callbacks registered once can hold them.
export function useTerminalRegistry(): TerminalRegistry {
  const [state, setState] = useState<RegistryState>({ sessions: [], groups: [], activeId: null });
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const [focusRequest, setFocusRequest] = useState<{ id: string; seq: number } | null>(null);
  const counters = useRef<Record<string, number>>({});
  const hosts = useRef(new Map<string, HTMLElement>());
  const toolbarHosts = useRef(new Map<string, HTMLElement>());

  const hostFor = useCallback((id: string) => elementIn(hosts.current, id, "kt-term-panel"), []);
  const toolbarHostFor = useCallback((id: string) => elementIn(toolbarHosts.current, id, "kt-term-toolbar-host"), []);

  const dropHost = useCallback((id: string) => {
    for (const map of [hosts.current, toolbarHosts.current]) {
      map.get(id)?.remove();
      map.delete(id);
    }
  }, []);

  const requestFocus = useCallback((id: string) => {
    setFocusRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const mint = useCallback((machine: string): TerminalSessionEntry => {
    const num = (counters.current[machine] ?? 0) + 1;
    counters.current[machine] = num;
    return { ...terminalSession(machine, num), location: "tabs" };
  }, []);

  const open = useCallback(
    (machine: string) => {
      const session = mint(machine);
      setState((prev) => ({
        sessions: [...prev.sessions, session],
        groups: addGroup(prev.groups, session.id),
        activeId: session.id,
      }));
      requestFocus(session.id);
      return session;
    },
    [mint, requestFocus],
  );

  const split = useCallback(
    (targetId: string, machine: string, direction: SplitDirection) => {
      const session = mint(machine);
      setState((prev) => {
        if (!prev.sessions.some((s) => s.id === targetId && s.location === "tabs")) return prev;
        return {
          sessions: [...prev.sessions, session],
          groups: splitIn(prev.groups, targetId, session.id, direction),
          activeId: session.id,
        };
      });
      requestFocus(session.id);
    },
    [mint, requestFocus],
  );

  const place = useCallback(
    (sourceId: string, targetId: string, side: DropSide) => {
      setState((prev) => {
        const inTabs = (id: string) => prev.sessions.some((s) => s.id === id && s.location === "tabs");
        if (!inTabs(sourceId) || !inTabs(targetId)) return prev;
        const groups = moveBeside(prev.groups, sourceId, targetId, side);
        return groups === prev.groups ? prev : { ...prev, groups, activeId: sourceId };
      });
      requestFocus(sourceId);
    },
    [requestFocus],
  );

  const close = useCallback(
    (id: string) => {
      setState((prev) => ({
        sessions: prev.sessions.filter((s) => s.id !== id),
        groups: removeFrom(prev.groups, id),
        activeId: activeAfterRemoval(prev.groups, id, prev.activeId),
      }));
      setStatuses((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      dropHost(id);
    },
    [dropHost],
  );

  const activate = useCallback(
    (id: string, options?: { focus?: boolean }) => {
      setState((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id }));
      if (options?.focus) requestFocus(id);
    },
    [requestFocus],
  );

  const move = useCallback(
    (id: string, location: TerminalLocation) => {
      setState((prev) => {
        if (!prev.sessions.some((s) => s.id === id && s.location !== location)) return prev;
        const sessions = prev.sessions.map((s) => (s.id === id ? { ...s, location } : s));
        return location === "tabs"
          ? { sessions, groups: addGroup(prev.groups, id), activeId: id }
          : {
              sessions,
              groups: removeFrom(prev.groups, id),
              activeId: activeAfterRemoval(prev.groups, id, prev.activeId),
            };
      });
      requestFocus(id);
    },
    [requestFocus],
  );

  const resize = useCallback((groupId: string, path: number[], sizes: number[]) => {
    setState((prev) => ({ ...prev, groups: resizeIn(prev.groups, groupId, path, sizes) }));
  }, []);

  const adopt = useCallback(
    (sessions: TerminalSessionEntry[], groups: TerminalGroup[], activeId: string | null) => {
      const keep = new Set(sessions.map((s) => s.id));
      for (const id of [...hosts.current.keys()]) if (!keep.has(id)) dropHost(id);
      for (const s of sessions) {
        if (s.num > (counters.current[s.machine] ?? 0)) counters.current[s.machine] = s.num;
      }
      const tabs = sessions.filter((s) => s.location === "tabs").map((s) => s.id);
      setState({ sessions, groups, activeId: activeId && tabs.includes(activeId) ? activeId : (tabs[0] ?? null) });
      setStatuses({});
    },
    [dropHost],
  );

  const setStatus = useCallback((id: string, status: TerminalStatus) => {
    setStatuses((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }, []);

  return useMemo(
    () => ({
      ...state,
      statuses,
      focusRequest,
      open,
      split,
      place,
      close,
      activate,
      move,
      resize,
      adopt,
      setStatus,
      hostFor,
      toolbarHostFor,
    }),
    [state, statuses, focusRequest, open, split, place, close, activate, move, resize, adopt, setStatus, hostFor, toolbarHostFor],
  );
}

const Ctx = createContext<TerminalRegistry | null>(null);

export const TerminalSessionsProvider = Ctx.Provider;

export function useTerminalSessions(): TerminalRegistry {
  const value = useContext(Ctx);
  if (!value) throw new Error("useTerminalSessions must be used within a TerminalSessionsProvider");
  return value;
}
