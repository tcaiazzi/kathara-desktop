import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Form } from "react-bootstrap";
import { useWorkspace } from "../context/WorkspaceContext";
import { useLiveTty } from "../hooks/useLiveTty";
import { api } from "../services/api";
import "./TerminalPanel.css";

// One live-terminal session rendered as its own dockview panel. dockview owns the tab (title +
// close), drag-between-groups, splitting/tiling, and group-maximize — so this component only carries
// a compact control bar + the xterm surface (no custom drag/wide/fullscreen chrome). The target
// device is passed as a dockview panel param; lab name + running state come from WorkspaceContext,
// so the panel re-renders live as the lab's state changes.
export function TerminalPanel(props: IDockviewPanelProps<{ machine: string }>) {
  const machine = props.params.machine;
  const ws = useWorkspace();
  const running = ws.detail.machines.some((m) => m.name === machine && m.running);
  // `shell` drives the picker UI; `shellRef` drives the actual connection URL — connect() reads the
  // URL when it fires, which can be right after we pick a shell (before a state re-render lands), so a
  // ref avoids using a stale value.
  const [shells, setShells] = useState<string[]>([]);
  const [shell, setShell] = useState("bash");
  const shellRef = useRef("bash");
  const chooseShell = (value: string) => {
    shellRef.current = value;
    setShell(value);
  };

  const { containerRef, terminalRef, connected, connecting, connect, disconnect, fit } = useLiveTty(true, {
    wsUrl: () => api.ttyWsUrl(ws.labName, machine, shellRef.current),
    terminalOptions: {
      cursorBlink: true,
      convertEol: false,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      scrollback: 8000,
      theme: {
        background: "#0d1117",
        foreground: "#d6deeb",
        cursor: "#7ee787",
        selectionBackground: "#264f78",
      },
    },
    sendCloseHandshake: true,
    onMessage: (event, term) => {
      if (!term) return;
      switch (event.event) {
        case "output":
          term.write(event.bytes);
          break;
        case "ready":
          term.write(`\r\nConnected to ${machine} (${shell})\r\n`);
          break;
        case "error":
          term.write(`\r\n[error] ${event.detail || "unknown error"}\r\n`);
          break;
        case "closed":
          term.write("\r\n[session closed]\r\n");
          break;
      }
    },
    onError: (term) => term?.write("\r\n[error] websocket transport failed\r\n"),
    onClose: (ev, term) => {
      const reason = ev.reason?.trim() ? `, reason=${ev.reason}` : "";
      term?.write(`\r\n[closed code=${ev.code}${reason}]\r\n`);
    },
  });

  // Auto-connect on mount; disconnect on unmount (panel closed). Mount-only effect with a matching
  // cleanup (not a "connected once" ref) so React 18 StrictMode's mount→cleanup→mount reconnects
  // cleanly instead of getting stuck disconnected — same pattern as TerminalWindowPage.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    terminalRef.current?.write(`Opening live terminal for ${machine}...\r\n`);
    // Detect the shells actually present in the device, pick one (prefer bash), then connect.
    (async () => {
      try {
        const list = await api.listShells(ws.labName, machine);
        if (!cancelled && list.length) {
          setShells(list);
          chooseShell(list.includes("bash") ? "bash" : list[0]);
        }
      } catch {
        /* detection failed — keep the default shell + full picker list */
      }
      if (!cancelled) connect();
    })();
    return () => {
      cancelled = true;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Device stopped while the terminal is open — disconnect but keep the panel + scrollback so the
  // user can reconnect once it's running again.
  useEffect(() => {
    if (!running) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // dockview resizes the panel without firing a window resize, so watch the container and re-fit.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kt-term-panel">
      <div className="kt-term-bar">
        <Form.Select
          size="sm"
          className="kt-term-shell"
          value={shell}
          onChange={(e) => chooseShell(e.target.value)}
          disabled={connected || connecting}
          aria-label="Shell"
        >
          {(shells.length ? shells : ["bash", "sh", "ash", "zsh"]).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Form.Select>
        <Button
          size="sm"
          variant={connected ? "outline-danger" : "outline-success"}
          onClick={() => (connected ? disconnect() : connect())}
          disabled={!running || connecting}
          title={running ? undefined : `${machine} is not running`}
        >
          {connecting ? "Connecting..." : connected ? "Disconnect" : "Connect"}
        </Button>
        <Button size="sm" variant="outline-secondary" onClick={() => terminalRef.current?.clear()}>
          Clear
        </Button>
        <Badge bg={connected ? "success" : connecting ? "warning" : running ? "secondary" : "dark"}>
          {connected ? "connected" : connecting ? "connecting" : running ? "disconnected" : "device stopped"}
        </Badge>
      </div>
      <div ref={containerRef} className="kt-term-screen" onClick={() => terminalRef.current?.focus()} />
    </div>
  );
}
