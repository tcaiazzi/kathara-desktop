// Bipartite topology model (device nodes + collision-domain nodes, edges = interfaces) — the
// data shape the force-directed graph in TopologyGraph.tsx renders.

import { HOST_BRIDGE, visibleInterfaces } from "./constants";
import { type DeviceCategory, deviceType } from "./deviceIcon";
import type { LabDetail, MachineDetail, PendingMachineFiles, PortMapping } from "./types";

export interface TopoIface {
  num: number;
  link: string;
  mac: string | null;
  ips: string[];
}

export interface DeviceNode {
  id: string;
  type: "dev";
  name: string;
  image: string | null;
  running: boolean;
  status: string | null;
  // Visual type derived from the Docker image (icon category + friendly label) + extra facts
  // surfaced on the canvas/tooltip (all from MachineDetail).
  category: DeviceCategory;
  typeLabel: string;
  bridged: boolean;
  ports: PortMapping[];
  ifaces: TopoIface[];
  // mutable simulation state, set by TopologyGraph
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export interface DomainNode {
  id: string;
  type: "cd";
  name: string;
  external: string[];
  running: boolean;
  members: string[];
  x: number;
  y: number;
  dx: number;
  dy: number;
}

export type TopoNode = DeviceNode | DomainNode;

export interface TopoEdge {
  source: string;
  target: string;
  label: string;
  mac: string | null;
  ips: string[];
}

export interface TopoModel {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

// Best-effort: pull "ip address add <cidr> dev ethN" out of a device's config text. Kathara's
// startup log echoes each command (`echo "++ <command>"`), so a line can match twice — the dedupe
// below keeps each IP once per interface.
const IFACE_IP_RE = /ip\s+add(?:r|ress)?\s+add\s+(\S+)\s+dev\s+eth(\d+)/gi;

function collectIps(text: string, map: Record<number, string[]>): void {
  IFACE_IP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IFACE_IP_RE.exec(text)) !== null) {
    const num = Number(m[2]);
    const ips = map[num] || (map[num] = []);
    if (!ips.includes(m[1])) ips.push(m[1]);
  }
}

// Interface → IPs, parsed from a device's exec commands AND its startup script (where IPs are
// usually assigned — lab.conf `[exec]` lines are folded into the startup by the importer).
export function parseIfaceIps(machine: MachineDetail, startup = ""): Record<number, string[]> {
  const map: Record<number, string[]> = {};
  collectIps(machine.exec_commands.join("\n"), map);
  if (startup) collectIps(startup, map);
  return map;
}

export function computeTopology(
  detail: LabDetail,
  pending?: Record<string, PendingMachineFiles>,
): TopoModel {
  const cds = new Map<string, { name: string; external: string[]; running: boolean; machines: Set<string> }>();
  for (const lk of detail.links) {
    if (lk.name === HOST_BRIDGE) continue;
    cds.set(lk.name, { name: lk.name, external: lk.external, running: lk.running, machines: new Set(lk.machines) });
  }

  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  for (const m of detail.machines) {
    const ips = parseIfaceIps(m, pending?.[m.name]?.startup);
    const dtype = deviceType(m);
    const node: DeviceNode = {
      id: `dev:${m.name}`,
      type: "dev",
      name: m.name,
      image: m.image,
      running: m.running,
      status: m.status,
      category: dtype.category,
      typeLabel: dtype.label,
      bridged: m.bridged,
      ports: m.ports,
      ifaces: [],
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
    };
    for (const it of visibleInterfaces(m)) {
      const ifIps = ips[it.num] || [];
      node.ifaces.push({ num: it.num, link: it.link, mac: it.mac_address, ips: ifIps });
      if (!cds.has(it.link)) cds.set(it.link, { name: it.link, external: [], running: node.running, machines: new Set() });
      cds.get(it.link)!.machines.add(m.name);
      edges.push({ source: node.id, target: `cd:${it.link}`, label: `eth${it.num}`, mac: it.mac_address, ips: ifIps });
    }
    nodes.push(node);
  }
  for (const cd of cds.values()) {
    nodes.push({
      id: `cd:${cd.name}`,
      type: "cd",
      name: cd.name,
      external: cd.external,
      running: cd.running,
      members: [...cd.machines],
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
    });
  }
  return { nodes, edges };
}
