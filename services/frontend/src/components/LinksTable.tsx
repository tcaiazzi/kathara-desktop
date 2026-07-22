import { Badge, Table } from "react-bootstrap";
import { HOST_BRIDGE } from "../services/constants";
import type { LinkDetail } from "../services/types";
import { Panel } from "./Panel";

interface LinksTableProps {
  links: LinkDetail[];
}

// Read-only collision-domain table. Add/remove/connect actions live with the topology graph,
// not here.
export function LinksTable({ links }: LinksTableProps) {
  const visible = links.filter((l) => l.name !== HOST_BRIDGE);

  return (
    <Panel title={`Collision domains (${visible.length})`}>
      {visible.length === 0 ? (
        <p className="text-muted mb-0">No collision domains.</p>
      ) : (
        <Table size="sm" responsive className="mb-0">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Devices</th>
              <th>External</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((lk) => (
              <tr key={lk.name}>
                <td className="font-monospace">{lk.name}</td>
                <td>
                  <Badge bg={lk.running ? "success" : "secondary"}>{lk.running ? "up" : "down"}</Badge>
                </td>
                <td className="font-monospace text-muted">{lk.machines.join(", ") || "—"}</td>
                <td className="font-monospace text-muted">{lk.external.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}
