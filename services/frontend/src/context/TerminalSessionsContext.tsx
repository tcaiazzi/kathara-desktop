import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { activeAfterClose, terminalSession, type TerminalSessionInfo } from "../services/terminalSessions";

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

/** Where a session is shown: in the Terminals tab's list, or detached into a dock panel of its own
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
  /** The session the Terminals tab shows, always one located there, or null when it has none. */
  activeId: string | null;
  statuses: Record<string, TerminalStatus>;
  /** Starts a session for `machine` in the Terminals tab and makes it the one shown there; it
   *  connects as soon as it mounts. */
  open: (machine: string) => TerminalSessionEntry;
  /** Ends a session: its socket closes and its scrollback is gone. */
  close: (id: string) => void;
  activate: (id: string) => void;
  /** Replaces the whole state, for a layout restored from storage. Seeds the per-machine counters
   *  from it, so a session opened afterwards cannot take a restored session's id. */
  adopt: (sessions: TerminalSessionEntry[], activeId: string | null) => void;
  /** Reported by each session, for the Terminals tab's list. */
  setStatus: (id: string, status: TerminalStatus) => void;
  /** The session's host element, created on first request. Only this module and its slots use it. */
  hostFor: (id: string) => HTMLElement;
}

interface RegistryState {
  sessions: TerminalSessionEntry[];
  activeId: string | null;
}

const tabIds = (sessions: TerminalSessionEntry[]) => sessions.filter((s) => s.location === "tabs").map((s) => s.id);

// The registry's state and actions. Called once, by the workspace page, which needs `open` and
// `close` outside the provider; everything under the provider reads the same object through
// useTerminalSessions. Every action is stable, so dockview callbacks registered once can hold them.
export function useTerminalRegistry(): TerminalRegistry {
  const [state, setState] = useState<RegistryState>({ sessions: [], activeId: null });
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const counters = useRef<Record<string, number>>({});
  const hosts = useRef(new Map<string, HTMLElement>());

  const hostFor = useCallback((id: string) => {
    let host = hosts.current.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "kt-term-panel";
      hosts.current.set(id, host);
    }
    return host;
  }, []);

  const dropHost = useCallback((id: string) => {
    hosts.current.get(id)?.remove();
    hosts.current.delete(id);
  }, []);

  const open = useCallback((machine: string) => {
    const num = (counters.current[machine] ?? 0) + 1;
    counters.current[machine] = num;
    const session: TerminalSessionEntry = { ...terminalSession(machine, num), location: "tabs" };
    setState((prev) => ({ sessions: [...prev.sessions, session], activeId: session.id }));
    return session;
  }, []);

  const close = useCallback(
    (id: string) => {
      setState((prev) => ({
        sessions: prev.sessions.filter((s) => s.id !== id),
        activeId: activeAfterClose(tabIds(prev.sessions), id, prev.activeId),
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

  const activate = useCallback((id: string) => {
    setState((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id }));
  }, []);

  const adopt = useCallback(
    (sessions: TerminalSessionEntry[], activeId: string | null) => {
      const keep = new Set(sessions.map((s) => s.id));
      for (const id of [...hosts.current.keys()]) if (!keep.has(id)) dropHost(id);
      for (const s of sessions) {
        if (s.num > (counters.current[s.machine] ?? 0)) counters.current[s.machine] = s.num;
      }
      const tabs = tabIds(sessions);
      setState({ sessions, activeId: activeId && tabs.includes(activeId) ? activeId : (tabs[0] ?? null) });
      setStatuses({});
    },
    [dropHost],
  );

  const setStatus = useCallback((id: string, status: TerminalStatus) => {
    setStatuses((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
  }, []);

  return useMemo(
    () => ({ ...state, statuses, open, close, activate, adopt, setStatus, hostFor }),
    [state, statuses, open, close, activate, adopt, setStatus, hostFor],
  );
}

const Ctx = createContext<TerminalRegistry | null>(null);

export const TerminalSessionsProvider = Ctx.Provider;

export function useTerminalSessions(): TerminalRegistry {
  const value = useContext(Ctx);
  if (!value) throw new Error("useTerminalSessions must be used within a TerminalSessionsProvider");
  return value;
}
