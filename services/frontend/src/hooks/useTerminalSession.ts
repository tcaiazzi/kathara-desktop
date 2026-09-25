import { useEffect, type RefObject } from "react";
import { useLiveTty } from "./useLiveTty";
import { useShellDetection } from "./useShellDetection";
import { api } from "../services/api";

// One live terminal session: shell detection, the xterm/websocket wiring, and the auto-connect on
// mount. Shared by the in-page dockview panel and the standalone popup window: the options
// literal, the message switch and the mount effect live here once, and neither surface keeps a
// copy of its own.
//
// `labId` is a parameter rather than read from WorkspaceContext on purpose: the popup route is
// mounted outside the provider, so anything shared here must not reach for that context.

interface TerminalSessionOptions {
  /** Scopes auto-focus-on-connect, so a background reconnect can't steal focus from the editor or
   * another terminal. Only the in-page panel passes one — in a window of its own, focus is always
   * wanted, and a scope whose element never holds focus would suppress it. */
  focusScopeRef?: RefObject<HTMLElement | null>;
  /** False when the device is stopped at mount: the panel stays open with its scrollback, but does
   * not dial out. Read once, at mount, like the effect it guards. */
  autoConnect?: boolean;
}

export function useTerminalSession(labId: string, machine: string, options: TerminalSessionOptions = {}) {
  const { focusScopeRef, autoConnect = true } = options;
  const detection = useShellDetection();
  const { shell, shellRef, detectShell } = detection;

  const tty = useLiveTty(true, {
    wsUrl: () => api.ttyWsUrl(labId, machine, shellRef.current),
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
    focusScopeRef,
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

  const { terminalRef, connect, disconnect } = tty;

  // Auto-connect on mount, after detecting which shells the device actually has — defaulting to
  // "bash" fails outright on images without it (Alpine). Deliberately a mount-only effect with a
  // matching disconnect cleanup, not a "connected once" ref: React 18 StrictMode double-invokes
  // effects in dev, and only this shape reconnects cleanly on the settled second pass.
  useEffect(() => {
    if (!autoConnect) return;
    let cancelled = false;
    terminalRef.current?.write(`Opening live terminal for ${machine}...\r\n`);
    (async () => {
      await detectShell(labId, machine);
      if (!cancelled) connect();
    })();
    return () => {
      cancelled = true;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { ...detection, ...tty };
}
