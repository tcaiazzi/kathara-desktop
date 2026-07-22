import { useEffect, useState } from "react";
import { Badge, Button, Form } from "react-bootstrap";
import { useParams } from "react-router-dom";
import { useLiveTty } from "../hooks/useLiveTty";
import { api } from "../services/api";
import "./TerminalWindowPage.css";

// A bare, standalone page (no navbar) for one device's live terminal — opened via
// `openTerminalWindow()` as a real, separate browser window/tab rather than an in-page overlay,
// so the OS's own window manager handles drag/resize/arranging multiple terminals.
export function TerminalWindowPage() {
  const { name = "", machine = "" } = useParams();
  const [shell, setShell] = useState("bash");

  const { containerRef, terminalRef, connected, connecting, connect, disconnect } = useLiveTty(true, {
    wsUrl: () => api.ttyWsUrl(name, machine, shell),
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
          term.write(event.text);
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

  // Auto-connect on mount. Deliberately a mount-only effect with a matching disconnect cleanup
  // (not a "connect once" ref) — React 18 StrictMode double-invokes effects in dev, and only this
  // shape reconnects correctly on the settled second pass. Same pattern as TerminalPanel.
  useEffect(() => {
    terminalRef.current?.write(`Opening live terminal for ${machine}...\r\n`);
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="kt-terminal-page">
      <div className="kt-topo-terminal-toolbar">
        <Form.Select
          style={{ width: 120 }}
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          disabled={connected || connecting}
          aria-label="Shell"
        >
          <option value="bash">bash</option>
          <option value="sh">sh</option>
          <option value="ash">ash</option>
          <option value="zsh">zsh</option>
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
