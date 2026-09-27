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

// Device nodes grow with their label up to this width, and the label is truncated past it.
export const MAX_DEVICE_NODE_WIDTH = 260;

/** A device node's rect width, from its name: the same formula draws the rect (useForceLayout.ts)
 *  and sizes it for a fit, so the two can never disagree. */
export function deviceNodeWidth(name: string): number {
  return Math.min(MAX_DEVICE_NODE_WIDTH, Math.max(112, name.length * 9 + 58));
}

/** Half the width and height a node takes on the canvas, around its centre. A device is its rect
 *  plus the corner badges, which sit on the rect's edge and stick out by 6px on each side
 *  (r 9, centred 3px inside); a domain is its r-18 circle, or its label where that is wider
 *  (~7.6px per character at the domain label's monospace size). */
export function nodeExtent(node: Pick<TopoNode, "type" | "name">): { hw: number; hh: number } {
  if (node.type === "dev") return { hw: deviceNodeWidth(node.name) / 2 + 6, hh: 23 };
  return { hw: Math.max(18, node.name.length * 3.8), hh: 18 };
}

/** An interface label's box around its anchor point: the `ethN` line, then the IP and MAC lines
 *  under it (EDGE_LABEL_LINE_Y). Axis-aligned, like the nodes, so the two can be separated exactly. */
export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Each label line's baseline below the anchor, as the lines are drawn. */
export const EDGE_LABEL_LINE_Y = { name: -3, ip: 12, mac: 27 } as const;

/** The box an interface's label takes, counting only the lines on show. Widths are estimated from
 *  the text (monospace: 0.6em per character, at 12px for `ethN` and 11px for IP/MAC), plus the
 *  2px halo each line is drawn with. */
export function edgeLabelBox(
  edge: Pick<TopoEdge, "label" | "ips" | "mac">,
  show: { ips: boolean; macs: boolean },
): LabelBox {
  const widths = [edge.label.length * 7.2];
  let bottom = EDGE_LABEL_LINE_Y.name + 5;
  if (show.ips && edge.ips.length) {
    widths.push(edge.ips.join(", ").length * 6.6);
    bottom = EDGE_LABEL_LINE_Y.ip + 5;
  }
  if (show.macs && edge.mac) {
    widths.push(edge.mac.length * 6.6);
    bottom = EDGE_LABEL_LINE_Y.mac + 5;
  }
  const half = Math.max(...widths) / 2 + 2;
  return { left: -half, right: half, top: EDGE_LABEL_LINE_Y.name - 11, bottom };
}

/** How far from a node's centre, along the unit direction (ux, uy), a label's anchor must be for
 *  the label's box to clear the node's box (half-sizes hw × hh, see nodeExtent) by `gap`. Two
 *  axis-aligned boxes are clear once they are apart on either axis, so this is exact. */
export function labelClearance(ux: number, uy: number, hw: number, hh: number, box: LabelBox, gap = 4): number {
  const eps = 1e-9;
  const tx = ux > eps ? (hw + gap - box.left) / ux : ux < -eps ? (hw + gap + box.right) / -ux : Infinity;
  const ty = uy > eps ? (hh + gap - box.top) / uy : uy < -eps ? (hh + gap + box.bottom) / -uy : Infinity;
  return Math.min(tx, ty);
}

/** Where an interface's label goes on the edge from device `a` to domain `b`, and `need`: how long
 *  the edge must be (centre to centre) for the label to clear both nodes. With room to spare the
 *  label sits 38% of the way along, pushed out of either node when that would overlap it; without
 *  room, halfway between the two positions that would clear each node. */
export function edgeLabelPlacement(
  a: { x: number; y: number },
  aExt: { hw: number; hh: number },
  b: { x: number; y: number },
  bExt: { hw: number; hh: number },
  box: LabelBox,
): { x: number; y: number; need: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: a.x, y: a.y, need: 0 };
  const ux = dx / len;
  const uy = dy / len;
  const fromA = labelClearance(ux, uy, aExt.hw, aExt.hh, box);
  const fromB = labelClearance(-ux, -uy, bExt.hw, bExt.hh, box);
  const need = fromA + fromB;
  const t = need <= len ? Math.min(Math.max(len * 0.38, fromA), len - fromB) : (fromA + len - fromB) / 2;
  return { x: a.x + ux * t, y: a.y + uy * t, need };
}

/** Canvas space, in px from each edge, that an overlay (toolbar, legend, zoom buttons) covers. */
export interface FitInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: FitInsets = { top: 0, right: 0, bottom: 0, left: 0 };

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The insets that keep a fit clear of `overlays` floating over `canvas` (both in the same client
 *  coordinates). Each overlay sits against one edge, and reserving a strip along it costs either its
 *  width or its height: the cheaper one, relative to the canvas, is taken — a wide toolbar costs a
 *  strip along the top, a tall legend in a corner a strip along the side. `gap` keeps the fitted
 *  graph a little away from the overlay rather than touching it. */
export function overlayInsets(canvas: Box, overlays: readonly Box[], gap = 8): FitInsets {
  const insets = { ...ZERO_INSETS };
  const width = canvas.right - canvas.left;
  const height = canvas.bottom - canvas.top;
  if (width <= 0 || height <= 0) return insets;
  for (const o of overlays) {
    if (o.right <= o.left || o.bottom <= o.top) continue; // hidden (display: none)
    const nearTop = (o.top + o.bottom) / 2 < canvas.top + height / 2;
    const nearLeft = (o.left + o.right) / 2 < canvas.left + width / 2;
    const vertical = nearTop ? o.bottom - canvas.top : canvas.bottom - o.top;
    const horizontal = nearLeft ? o.right - canvas.left : canvas.right - o.left;
    if (vertical / height <= horizontal / width) {
      if (nearTop) insets.top = Math.max(insets.top, vertical + gap);
      else insets.bottom = Math.max(insets.bottom, vertical + gap);
    } else if (nearLeft) {
      insets.left = Math.max(insets.left, horizontal + gap);
    } else {
      insets.right = Math.max(insets.right, horizontal + gap);
    }
  }
  return insets;
}

/** The viewport transform that fits every node into a `width`×`height` canvas: the nodes' bounding
 *  box — each node counted with its extent (`hw`/`hh`, see nodeExtent), when given — plus `pad` on
 *  each side, centred in the part of the canvas the `insets` leave free, at a scale kept within
 *  [0.3, 2]. `nodes` must not be empty. */
export function fitTransform(
  nodes: readonly { x: number; y: number; hw?: number; hh?: number }[],
  width: number,
  height: number,
  insets: FitInsets = ZERO_INSETS,
  pad = 24,
): { scale: number; tx: number; ty: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const nd of nodes) {
    const hw = nd.hw ?? 0;
    const hh = nd.hh ?? 0;
    minX = Math.min(minX, nd.x - hw);
    minY = Math.min(minY, nd.y - hh);
    maxX = Math.max(maxX, nd.x + hw);
    maxY = Math.max(maxY, nd.y + hh);
  }
  // Never below 1px, so insets larger than a tiny canvas still give a (clamped) scale, not NaN.
  const availW = Math.max(1, width - insets.left - insets.right);
  const availH = Math.max(1, height - insets.top - insets.bottom);
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  const scale = Math.max(0.3, Math.min(2, Math.min(availW / bw, availH / bh)));
  return {
    scale,
    tx: insets.left + availW / 2 - ((minX + maxX) / 2) * scale,
    ty: insets.top + availH / 2 - ((minY + maxY) / 2) * scale,
  };
}

/** Whether two collections hold the same node ids — a rebuild whose set of nodes changed (a
 *  device added or removed) refits the view; one that only refreshed their data does not. */
export function sameIdSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}
