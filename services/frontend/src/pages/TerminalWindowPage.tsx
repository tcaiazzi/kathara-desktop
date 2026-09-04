import { useEffect } from "react";
import { Badge, Button, Form } from "react-bootstrap";
import { useParams } from "react-router-dom";
import { useLiveTty } from "../hooks/useLiveTty";
import { useShellDetection } from "../hooks/useShellDetection";
import { api } from "../services/api";
import "./TerminalWindowPage.css";

// A bare, standalone page (no navbar) for one device's live terminal — opened via
// `openTerminalWindow()` as a real, separate browser window/tab rather than an in-page overlay,
// so the OS's own window manager handles drag/resize/arranging multiple terminals.
export function TerminalWindowPage() {
  const { name = "", machine = "" } = useParams();
  const { shells, shell, shellRef, chooseShell, detectShell } = useShellDetection();

  const { containerRef, terminalRef, connected, connecting, connect, disconnect } = useLiveTty(true, {
    wsUrl: () => api.ttyWsUrl(name, machine, shellRef.current),
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

  useEffect(() => {
    document.title = `Terminal: ${machine}`;
  }, [machine]);

  // Auto-connect on mount, after detecting which shells the device actually has — a plain "bash"
  // default fails outright on images without it (e.g. Alpine), which the in-page TerminalPanel
  // already accounts for. Deliberately a mount-only effect with a matching disconnect cleanup
  // (not a "connect once" ref) — React 18 StrictMode double-invokes effects in dev, and only this
  // shape reconnects correctly on the settled second pass. Same pattern as TerminalPanel.
  useEffect(() => {
    let cancelled = false;
    terminalRef.current?.write(`Opening live terminal for ${machine}...\r\n`);
    (async () => {
      await detectShell(name, machine);
      if (!cancelled) connect();
    })();
    return () => {
      cancelled = true;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kt-terminal-page">
      <div className="kt-topo-terminal-toolbar">
        <Form.Select
          style={{ width: 120 }}
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
          variant={connected ? "outline-danger" : "outline-success"}
          onClick={() => {
            if (connected) disconnect();
            else connect();
          }}
          disabled={connecting}
        >
          {connecting ? "Connecting..." : connected ? "Disconnect" : "Connect"}
        </Button>
        <Button variant="outline-secondary" onClick={() => terminalRef.current?.clear()}>
          Clear
        </Button>
        <Badge bg={connected ? "success" : connecting ? "warning" : "secondary"}>
          {connected ? "connected" : connecting ? "connecting" : "disconnected"}
        </Badge>
      </div>
      <div ref={containerRef} className="kt-topo-terminal-screen" onClick={() => terminalRef.current?.focus()} />
    </div>
  );
}
