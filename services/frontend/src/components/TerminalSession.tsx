import { useEffect, useRef } from "react";
import { useWorkspace } from "../context/WorkspaceContext";
import { useTerminalSession } from "../hooks/useTerminalSession";
import { TerminalToolbar } from "./TerminalToolbar";
import "./TerminalPanel.css";

interface TerminalSessionProps {
  machine: string;
  /** The session's own host element (TerminalSessionsContext), which this renders into and which
   *  moves between the slots that show it. */
  host: HTMLElement;
}

// One live-terminal session in the workspace: a compact control bar and the xterm surface. It is
// mounted by the session registry, not by a dock panel, so it survives the panel that shows it
// changing; lab id and running state come from WorkspaceContext, so it re-renders live as the
// lab's state changes.
export function TerminalSession({ machine, host }: TerminalSessionProps) {
  const ws = useWorkspace();
  const running = ws.detail.machines.some((m) => m.name === machine && m.running);
  // Scopes auto-focus-on-connect to this session, so a background reconnect can't steal focus (and
  // with it, Ctrl+/Ctrl- zoom) from the editor, the topology graph, or another terminal.
  const focusScopeRef = useRef<HTMLElement | null>(host);

  const session = useTerminalSession(ws.labId, machine, { focusScopeRef, autoConnect: running });
  const { containerRef, terminalRef, disconnect, fit } = session;

  // Device stopped while the terminal is open — disconnect but keep the session + scrollback so the
  // user can reconnect once it's running again.
  useEffect(() => {
    if (!running) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Neither a dock resize nor a move to another slot fires a window resize, so watch the container
  // and re-fit.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <TerminalToolbar
        variant="panel"
        machine={machine}
        running={running}
        onClear={() => terminalRef.current?.clear()}
        {...session}
      />
      <div ref={containerRef} className="kt-term-screen" onClick={() => terminalRef.current?.focus()} />
    </>
  );
}
