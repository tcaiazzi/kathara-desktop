// Bipartite topology model (device nodes + collision-domain nodes, edges = interfaces) — the
// data shape the force-directed graph in TopologyGraph.tsx renders.

import { HOST_BRIDGE, visibleInterfaces } from "./constants";
import { type DeviceCategory, deviceType } from "./deviceIcon";
import type { LabDetail, MachineDetail, PortMapping } from "./types";

interface TopoIface {
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
  // Pinned by a fixed layout: the physics never moves it (it still exerts forces on the others).
  fixed?: boolean;
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
  fixed?: boolean;
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

export function formatIface(num: number, link: string): string {
  return `eth${num} → ${link}`;
}

export function formatPort(p: PortMapping): string {
  return `${p.host_port}→${p.guest_port}/${p.protocol}`;
}

export function deviceStateLabel(node: { running: boolean; status: string | null }): string {
  return node.running ? node.status || "running" : "stopped";
}

// Best-effort: pull "ip address add <cidr> dev ethN" out of a device's config text — including
// IPv6 lines, which Kathara labs commonly write with an explicit family flag
// ("ip -6 addr add <cidr6> dev ethN"). Kathara's startup log echoes each command
// (`echo "++ <command>"`), so a line can match twice — the dedupe below keeps each IP once per
// interface.
const IFACE_IP_RE = /ip\s+(?:-[46]\s+)?add(?:r|ress)?\s+add\s+(\S+)\s+dev\s+eth(\d+)/gi;

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
  startups?: Record<string, string>,
): TopoModel {
  const cds = new Map<string, { name: string; external: string[]; running: boolean; machines: Set<string> }>();
  for (const lk of detail.links) {
    if (lk.name === HOST_BRIDGE) continue;
    cds.set(lk.name, { name: lk.name, external: lk.external, running: lk.running, machines: new Set(lk.machines) });
  }
  // Domains listed in detail.links trust the backend's running flag as-is; domains only inferred
  // below (from a device interface, with no entry in detail.links) don't have one yet — that path
  // OR's it in as running devices are found, instead of freezing it to whichever device is seen first.
  const explicitDomains = new Set(cds.keys());

  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  for (const m of detail.machines) {
    const ips = parseIfaceIps(m, startups?.[m.name]);
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
      const cd = cds.get(it.link)!;
      cd.machines.add(m.name);
      if (!explicitDomains.has(it.link) && node.running) cd.running = true;
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

// -- layout geometry --------------------------------------------------------------------------

/** Node id → canvas position: what the layout engine reports and what `lab.layout` stores. */
export type NodePositions = Record<string, { x: number; y: number }>;

// Does the graph as laid out now (`live`, every node on screen) still match the lab's fixed layout?
// Only the nodes on screen are compared: `saved` may also hold nodes that no longer exist (a
// device removed since, a draft domain that was never kept), and those must not make the layout
// read as unsaved forever — saving writes only `live`, which drops them. A node on screen that
// `saved` doesn't place is a change. Coordinates are compared as integers (that is what the engine
// reports and what is stored), so a sub-pixel drift never marks the layout as unsaved.
export function matchesSavedLayout(live: NodePositions, saved: NodePositions | null): boolean {
  if (!saved) return false;
  return Object.keys(live).every((id) => {
    const s = saved[id];
    return !!s && Math.round(live[id].x) === Math.round(s.x) && Math.round(live[id].y) === Math.round(s.y);
  });
}

/** A node's position as the layout engine holds it: `fixed` nodes are never moved by the physics. */
export interface SeedPosition {
  x: number;
  y: number;
  fixed: boolean;
}

/** What a rebuilt engine inherits from the one it replaces (see hooks/useForceLayout.ts). */
export interface CarriedLayout {
  positions: Record<string, SeedPosition>;
  /** Whether the replaced engine had come to rest at least once. */
  settled: boolean;
}

/**
 * Where each node of a rebuilt graph starts; null means "no position known, lay it out fresh".
 *
 * A node still on screen from the engine being replaced keeps its live position, so a rebuild that
 * only carries new data (a startup file saved, a device added) moves nothing. It is pinned if it
 * already was, or if that graph had come to rest — then only newcomers settle around it; a graph
 * still settling keeps settling instead of freezing half-way. Otherwise `initial` (the lab's fixed
 * layout plus the local draft) places the node, pinned. `carried` is null for a fresh layout.
 */
export function planSeeds(
  ids: readonly string[],
  carried: CarriedLayout | null,
  initial: NodePositions,
): Record<string, SeedPosition | null> {
  const plan: Record<string, SeedPosition | null> = {};
  for (const id of ids) {
    const live = carried?.positions[id];
    const stored = initial[id];
    if (live && Number.isFinite(live.x) && Number.isFinite(live.y)) {
      plan[id] = { x: live.x, y: live.y, fixed: live.fixed || !!carried?.settled };
    } else if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
      plan[id] = { x: stored.x, y: stored.y, fixed: true };
    } else {
      plan[id] = null;
    }
  }
  return plan;
}

/** The viewport transform that fits every node into a `width`×`height` canvas: the nodes' bounding
 *  box plus a 50px margin on each side, centred, at a scale kept within [0.3, 2]. `nodes` must not
 *  be empty. */
export function fitTransform(
  nodes: readonly { x: number; y: number }[],
  width: number,
  height: number,
): { scale: number; tx: number; ty: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const nd of nodes) {
    minX = Math.min(minX, nd.x);
    minY = Math.min(minY, nd.y);
    maxX = Math.max(maxX, nd.x);
    maxY = Math.max(maxY, nd.y);
  }
  const pad = 50;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  const scale = Math.max(0.3, Math.min(2, Math.min(width / bw, height / bh)));
  return {
    scale,
    tx: (width - (minX + maxX) * scale) / 2,
    ty: (height - (minY + maxY) * scale) / 2,
  };
}
