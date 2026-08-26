import { Badge, Button, Table } from "react-bootstrap";
import { visibleInterfaces } from "../services/constants";
import { openTerminalWindow } from "../services/terminalWindow";
import { deviceStateLabel, formatIface } from "../services/topology";
import type { MachineDetail } from "../services/types";
import { Panel } from "./Panel";

interface DevicesTableProps {
  labName: string;
  machines: MachineDetail[];
}

// Read-only device table, plus a quick "Terminal" button per running device that pops out a
// terminal window for it (see services/terminalWindow.ts).
export function DevicesTable({ labName, machines }: DevicesTableProps) {
  return (
    <Panel title={`Devices (${machines.length})`} className="mb-3">
      {machines.length === 0 ? (
        <p className="text-muted mb-0">No devices.</p>
      ) : (
        <Table size="sm" responsive className="mb-0">
          <thead>
            <tr>
              <th>Name</th>
              <th>Image</th>
              <th>State</th>
              <th>Interfaces</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {machines.map((m) => {
              const ifaces = visibleInterfaces(m)
                .map((i) => formatIface(i.num, i.link))
                .join(", ");
              return (
                <tr key={m.name}>
                  <td className="font-monospace">{m.name}</td>
                  <td className="font-monospace text-muted">{m.image || "—"}</td>
                  <td>
                    <Badge bg={m.running ? "success" : "secondary"}>{deviceStateLabel(m)}</Badge>
                  </td>
                  <td className="font-monospace text-muted">{ifaces || "—"}</td>
                  <td className="text-end">
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      disabled={!m.running}
                      onClick={() => openTerminalWindow(labName, m.name)}
                    >
                      Terminal
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
