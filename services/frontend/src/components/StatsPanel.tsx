import { useEffect, useRef, useState } from "react";
import { Button, Table } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import { api } from "../services/api";
import type { MachineStats } from "../services/types";
import { Panel } from "./Panel";

interface StatsPanelProps {
  labName: string;
  deployed: boolean;
}

// Live device statistics. Unlike exec/stream, stats/stream is a GET endpoint, so the browser's
// native EventSource can be used directly (no manual SSE body-parsing needed here).
export function StatsPanel({ labName, deployed }: StatsPanelProps) {
  const [rows, setRows] = useState<Record<string, MachineStats>>({});
  const [streaming, setStreaming] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const toast = useToast();

  function stop() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setStreaming(false);
  }

  function start() {
    stop();
    setRows({});
    const src = new EventSource(api.statsStreamUrl(labName));
    sourceRef.current = src;
    setStreaming(true);
    src.addEventListener("stats", (ev) => {
      try {
        const sample: MachineStats[] = JSON.parse((ev as MessageEvent).data);
        setRows((prev) => {
          const next = { ...prev };
          for (const r of sample) next[r.name] = r;
          return next;
        });
      } catch {
        // ignore malformed frame
      }
    });
    src.onerror = () => {
      toast.show("Live stats stream ended.", "info");
      stop();
    };
  }

  // Stop the stream when navigating away from this lab or unmounting.
  useEffect(() => stop, [labName]);

  const sorted = Object.values(rows).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Panel
      title="Live statistics"
      className="mt-3"
      headerExtra={
        streaming ? (
          <Button size="sm" variant="danger" onClick={stop}>
            ■ Stop
          </Button>
        ) : (
          <Button size="sm" variant="outline-secondary" disabled={!deployed} onClick={start}>
            ▶ Start
          </Button>
        )
      }
    >
      {!deployed && <p className="text-muted mb-0">Deploy the lab to view live stats.</p>}
      {deployed && sorted.length === 0 && <p className="text-muted mb-0">Waiting for samples…</p>}
      {sorted.length > 0 && (
        <Table size="sm" responsive className="mb-0">
          <thead>
            <tr>
              <th>Device</th>
              <th>Status</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Mem %</th>
              <th>Net I/O</th>
              <th>PIDs</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name}>
                <td className="font-monospace">{r.name}</td>
                <td className="text-muted">{r.status || "—"}</td>
                <td className="font-monospace">{r.cpu_usage || "—"}</td>
                <td className="font-monospace">{r.mem_usage || "—"}</td>
                <td className="font-monospace">{r.mem_percent || "—"}</td>
                <td className="font-monospace">{r.net_usage || "—"}</td>
                <td className="font-monospace">{r.pids ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
