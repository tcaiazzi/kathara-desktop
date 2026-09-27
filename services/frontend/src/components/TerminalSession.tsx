import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { TerminalStatus } from "../context/TerminalSessionsContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { TerminalToolbar } from "./TerminalToolbar";
import "./TerminalPanel.css";

interface TerminalSessionProps {
  id: string;
  machine: string;
  /** The session's own host element (TerminalSessionsContext), which this renders into and which
   *  moves between the slots that show it. */
  host: HTMLElement;
  /** Where the compact toolbar goes while `inSplit`: the pane header a split group gives each pane. */
  toolbarHost: HTMLElement;
  /** Shown as one pane of a split group, whose header carries this session's toolbar. */
  inSplit: boolean;
  /** Non-zero, and new, each time the registry asks this session to take keyboard focus. */
  focusSeq: number;
  /** Tells the registry this session's connection state, which the Terminals tab's list shows. */
  setStatus: (id: string, status: TerminalStatus) => void;
}

// One live-terminal session in the workspace: a compact control bar and the xterm surface. It is
// mounted by the session registry, not by a dock panel, so it survives the panel that shows it
// changing; lab id and running state come from WorkspaceContext, so it re-renders live as the
// lab's state changes.
export function TerminalSession({ id, machine, host, toolbarHost, inSplit, focusSeq, setStatus }: TerminalSessionProps) {
  const ws = useWorkspace();
  const running = ws.detail.machines.some((m) => m.name === machine && m.running);
  // Scopes auto-focus-on-connect to this session, so a background reconnect can't steal focus (and
  // with it, Ctrl+/Ctrl- zoom) from the editor, the topology graph, or another terminal.
  const focusScopeRef = useRef<HTMLElement | null>(host);

  const session = useTerminalSession(ws.labId, machine, { focusScopeRef, autoConnect: running });
  const { containerRef, terminalRef, connected, connecting, disconnect, fit } = session;

  useEffect(() => {
    setStatus(id, connected ? "connected" : connecting ? "connecting" : "idle");
  }, [id, connected, connecting, setStatus]);

  // Device stopped while the terminal is open — disconnect but keep the session + scrollback so the
  // user can reconnect once it's running again.
  useEffect(() => {
    if (!running) disconnect();
    // `disconnect` is a fresh function every render but only works through useLiveTty's refs, so
    // any render's copy does the same; only `running` decides when to run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Asked for keyboard focus. A frame later, not at once: the slot that shows this session may be a
  // dock panel that dockview mounts in a render of its own, after this one, and focusing a terminal
  // that is not in the page yet does nothing.
  useEffect(() => {
    if (!focusSeq) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
    // `terminalRef` is a ref, stable for the session's life; only a new `focusSeq` asks for focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq]);

  // Neither a dock resize nor a move to another slot fires a window resize, so watch the container
  // and re-fit.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
    // Mount-only: `containerRef` is a ref, and `fit` — a fresh function every render — only works
    // through useLiveTty's refs, so the first render's copy stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toolbar = (
    <TerminalToolbar
      variant={inSplit ? "pane" : "panel"}
      machine={machine}
      running={running}
      onClear={() => terminalRef.current?.clear()}
      {...session}
    />
  );

  return (
    <>
      {inSplit ? createPortal(toolbar, toolbarHost) : toolbar}
      <div ref={containerRef} className="kt-term-screen" onClick={() => terminalRef.current?.focus()} />
    </>
  );
}
