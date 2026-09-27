import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { TerminalSessionInfo } from "../services/terminalSessions";

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

export interface TerminalRegistry {
  sessions: TerminalSessionInfo[];
  /** Starts a session for `machine`; it connects as soon as it mounts. */
  open: (machine: string) => TerminalSessionInfo;
  /** Ends a session: its socket closes and its scrollback is gone. */
  close: (id: string) => void;
  /** Replaces the whole list, for a layout restored from storage. Seeds the per-machine counters
   *  from it, so a session opened afterwards cannot take a restored session's id. */
  adopt: (sessions: TerminalSessionInfo[]) => void;
  /** The session's host element, created on first request. Only this module and its slots use it. */
  hostFor: (id: string) => HTMLElement;
}

// The registry's state and actions. Called once, by the workspace page, which needs `open` and
// `close` outside the provider; everything under the provider reads the same object through
// useTerminalSessions. Every action is stable, so dockview callbacks registered once can hold them.
export function useTerminalRegistry(): TerminalRegistry {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
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
    const session = { id: `${machine}:${num}`, machine, num };
    setSessions((prev) => [...prev, session]);
    return session;
  }, []);

  const close = useCallback(
    (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      dropHost(id);
    },
    [dropHost],
  );

  const adopt = useCallback(
    (next: TerminalSessionInfo[]) => {
      const keep = new Set(next.map((s) => s.id));
      for (const id of [...hosts.current.keys()]) if (!keep.has(id)) dropHost(id);
      for (const s of next) {
        if (s.num > (counters.current[s.machine] ?? 0)) counters.current[s.machine] = s.num;
      }
      setSessions(next);
    },
    [dropHost],
  );

  return useMemo(() => ({ sessions, open, close, adopt, hostFor }), [sessions, open, close, adopt, hostFor]);
}

const Ctx = createContext<TerminalRegistry | null>(null);

export const TerminalSessionsProvider = Ctx.Provider;

export function useTerminalSessions(): TerminalRegistry {
  const value = useContext(Ctx);
  if (!value) throw new Error("useTerminalSessions must be used within a TerminalSessionsProvider");
  return value;
}
