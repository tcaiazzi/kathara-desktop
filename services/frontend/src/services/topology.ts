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
  // A domain with no device on it, not saved in lab.conf yet (LinkDetail.draft).
  draft: boolean;
  // LinkDetail.network_plugin; null for a domain known only from a device's interface.
  networkPlugin: string | null;
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
  // The device and interface number the edge is (`source` is `dev:<device>`, `label` `eth<num>`).
  device: string;
  num: number;
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

// Best-effort: pull the addresses a device's config text assigns to its interfaces, from the two
// commands labs write them with — `ip address add` and `ifconfig`. Read one shell command at a
// time: a startup file chains commands with `;`/`&&` and comments with `#`, and Kathara's startup
// log echoes each command (`++ <command>`), so the same assignment can appear twice — the dedupe
// in collectIps keeps each IP once per interface.

const ETH_RE = /^eth(\d+)(?::\S*)?$/i;
// An IPv4/IPv6 address, with or without a prefix length. Loose on purpose: it only has to tell an
// address apart from the keywords around it, not validate it.
const ADDR_RE = /^(?=[0-9a-f:.]*[.:])[0-9a-f:.]+(?:\/\d{1,3})?$/i;
// `ip address add` keywords that take a value, which must not be mistaken for the address.
const IP_ARG_KEYWORDS = new Set([
  "brd", "broadcast", "scope", "label", "peer", "anycast", "valid_lft", "preferred_lft", "metric", "proto",
]);

// iproute2 accepts any prefix of an object or command name: `a`, `addr`, `address`; `a`, `add`.
function abbreviates(token: string, word: string): boolean {
  return token.length > 0 && word.startsWith(token.toLowerCase());
}

// A dotted netmask's prefix length, or null for anything that isn't one (e.g. 255.0.255.0).
export function netmaskPrefix(mask: string): number | null {
  const parts = mask.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  const bits = parts.map((p) => Number(p).toString(2).padStart(8, "0")).join("");
  if (!/^1*0*$/.test(bits)) return null;
  const firstZero = bits.indexOf("0");
  return firstZero === -1 ? 32 : firstZero;
}

// `ip [-opts] address add <X> [keyword value…] dev ethN`, the address and `dev` in either order.
function ipAddrAdd(args: string[]): [number, string] | null {
  let i = 0;
  while (args[i]?.startsWith("-")) i++;
  if (!abbreviates(args[i] ?? "", "address") || !abbreviates(args[i + 1] ?? "", "add")) return null;
  let iface: number | null = null;
  let addr: string | null = null;
  for (let j = i + 2; j < args.length; j++) {
    const tok = args[j];
    if (tok === "dev") {
      const m = ETH_RE.exec(args[++j] ?? "");
      if (m) iface = Number(m[1]);
    } else if (tok === "local") {
      addr = args[++j] ?? addr;
    } else if (IP_ARG_KEYWORDS.has(tok)) {
      j++;
    } else if (addr === null && ADDR_RE.test(tok)) {
      addr = tok;
    }
  }
  return iface !== null && addr !== null ? [iface, addr] : null;
}

// `ifconfig ethN [inet|inet6] [add] <X> [netmask M] …` — a netmask becomes the prefix length.
function ifconfigAddr(args: string[]): [number, string] | null {
  const m = ETH_RE.exec(args[0] ?? "");
  if (!m) return null;
  let i = 1;
  if (args[i] === "inet" || args[i] === "inet6") i++;
  if (args[i] === "add") i++;
  let addr = args[i] ?? "";
  if (!ADDR_RE.test(addr)) return null;
  const maskAt = args.indexOf("netmask", i + 1);
  const prefix = maskAt > 0 ? netmaskPrefix(args[maskAt + 1] ?? "") : null;
  if (prefix !== null && !addr.includes("/")) addr = `${addr}/${prefix}`;
  return [Number(m[1]), addr];
}

function collectIps(text: string, map: Record<number, string[]>): void {
  for (const line of text.split("\n")) {
    const code = line.replace(/(^|\s)#.*$/, "");
    for (const command of code.split(/;|&&|\|\|?/)) {
      const tokens = command.trim().split(/\s+/);
      // The program name may follow a prefix (`++ ` in the startup log, `sudo`) or carry a path.
      const at = tokens.findIndex((t) => /^(?:.*\/)?(?:ip|ifconfig)$/.test(t));
      if (at < 0) continue;
      const args = tokens.slice(at + 1);
      const found = tokens[at].endsWith("ifconfig") ? ifconfigAddr(args) : ipAddrAdd(args);
      if (!found) continue;
      const [num, ip] = found;
      const ips = map[num] || (map[num] = []);
      if (!ips.includes(ip)) ips.push(ip);
    }
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

// -- The addresses on a running device against the ones its startup declares --------------------

/** An IPv6 address in its canonical text form (RFC 5952: lowercase, no leading zeros, the longest
 *  run of two or more zero groups written `::`), so that two spellings of one address compare
 *  equal. Anything this can't read (including an embedded IPv4 tail) comes back lowercased. */
export function canonicalIpv6(addr: string): string {
  const lower = addr.toLowerCase();
  const halves = lower.split("::");
  if (lower.includes(".") || halves.length > 2) return lower;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return lower;
  const parts = groups.map((g) => g.replace(/^0+(?=.)/, ""));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && parts[j] === "0") j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = Math.max(j, i + 1);
  }
  if (best < 0) return parts.join(":");
  return `${parts.slice(0, best).join(":")}::${parts.slice(best + bestLen).join(":")}`;
}

function splitCidr(ip: string): { addr: string; prefix: string | null } {
  const slash = ip.indexOf("/");
  const addr = slash < 0 ? ip : ip.slice(0, slash);
  return { addr: addr.includes(":") ? canonicalIpv6(addr) : addr, prefix: slash < 0 ? null : ip.slice(slash + 1) };
}

// A declared address with no prefix length (`ifconfig ethN X` with no netmask) matches whatever
// prefix the kernel gave it.
function sameIp(declared: string, live: string): boolean {
  const d = splitCidr(declared);
  const l = splitCidr(live);
  return d.addr === l.addr && (d.prefix === null || d.prefix === l.prefix);
}

export interface IfaceIpMismatch {
  declared: string[];
  live: string[];
  // In the startup but not on the interface, and on the interface but not in the startup.
  missing: string[];
  extra: string[];
}

/** Interface number -> how its running addresses differ from the ones the startup declares, for
 *  each interface where they do. Only interfaces the startup declares an address for are compared:
 *  an address set some way parseIfaceIps can't read (a script file, a routing daemon) would
 *  otherwise flag every interface it touches. */
export function compareIfaceIps(
  declared: Record<number, string[]>,
  live: Record<number, string[]>,
): Record<number, IfaceIpMismatch> {
  const out: Record<number, IfaceIpMismatch> = {};
  for (const [key, want] of Object.entries(declared)) {
    if (!want.length) continue;
    const num = Number(key);
    const have = live[num] ?? [];
    const missing = want.filter((d) => !have.some((l) => sameIp(d, l)));
    const extra = have.filter((l) => !want.some((d) => sameIp(d, l)));
    if (missing.length || extra.length) out[num] = { declared: want, live: have, missing, extra };
  }
  return out;
}

/** Every device's mismatches, keyed by `ifaceKey`, from the running addresses the backend reports
 *  (GET /labs/{lab}/live-addresses: only running devices whose startup has finished) and the
 *  addresses each interface's edge carries. A device the backend left out is not compared. */
export function ipMismatches(
  edges: readonly Pick<TopoEdge, "device" | "num" | "ips">[],
  live: Record<string, Record<string, string[]>>,
): Record<string, IfaceIpMismatch> {
  const declared: Record<string, Record<number, string[]>> = {};
  for (const e of edges) (declared[e.device] ??= {})[e.num] = e.ips;
  const out: Record<string, IfaceIpMismatch> = {};
  for (const [device, byIface] of Object.entries(live)) {
    const have: Record<number, string[]> = {};
    for (const [num, ips] of Object.entries(byIface)) have[Number(num)] = ips;
    const diff = compareIfaceIps(declared[device] ?? {}, have);
    for (const [num, d] of Object.entries(diff)) out[ifaceKey(device, Number(num))] = d;
  }
  return out;
}

export function ifaceKey(device: string, num: number): string {
  return `${device}/eth${num}`;
}

/** One device's entries of `ipMismatches`, by interface number — what the Inspector shows. */
export function deviceIpMismatches(
  edges: readonly Pick<TopoEdge, "device" | "num">[],
  mismatches: Record<string, IfaceIpMismatch>,
  device: string,
): Record<number, IfaceIpMismatch> {
  const out: Record<number, IfaceIpMismatch> = {};
  for (const e of edges) {
    const m = e.device === device ? mismatches[ifaceKey(e.device, e.num)] : undefined;
    if (m) out[e.num] = m;
  }
  return out;
}

export function computeTopology(
  detail: LabDetail,
  startups?: Record<string, string>,
): TopoModel {
  const cds = new Map<
    string,
    {
      name: string;
      external: string[];
      running: boolean;
      draft: boolean;
      networkPlugin: string | null;
      machines: Set<string>;
    }
  >();
  for (const lk of detail.links) {
    if (lk.name === HOST_BRIDGE) continue;
    cds.set(lk.name, {
      name: lk.name,
      external: lk.external,
      running: lk.running,
      draft: lk.draft,
      networkPlugin: lk.network_plugin,
      machines: new Set(lk.machines),
    });
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
      if (!cds.has(it.link)) {
        cds.set(it.link, {
          name: it.link,
          external: [],
          running: node.running,
          draft: false,
          networkPlugin: null,
          machines: new Set(),
        });
      }
      const cd = cds.get(it.link)!;
      cd.machines.add(m.name);
      if (!explicitDomains.has(it.link) && node.running) cd.running = true;
      edges.push({
        source: node.id,
        target: `cd:${it.link}`,
        device: m.name,
        num: it.num,
        label: `eth${it.num}`,
        mac: it.mac_address,
        ips: ifIps,
      });
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
      // A device on it makes it saved, whatever the listing said a moment earlier.
      draft: cd.draft && cd.machines.size === 0,
      networkPlugin: cd.networkPlugin,
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
interface CarriedLayout {
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

// A device node's text sits between its leading icon (the first 28px) and the right edge, centred
// there. The name keeps 15px clear on each side; the image sublabel keeps IMAGE_MARGIN, so it
// neither touches the border nor runs under the published-port badge on the bottom-right corner.
// The per-character widths are the monospace label/sub-label font sizes (14px / 11px), rounded up.
// The image is the secondary line, so it never widens a node past MAX_IMAGE_CHARS (every
// `kathara/*` image fits); a longer one, such as a full registry path, is truncated and stays one
// hover away in the tooltip.
export const NAME_CHAR_W = 9;
export const IMAGE_CHAR_W = 7;
export const IMAGE_MARGIN = 10;
export const MAX_IMAGE_CHARS = 18;

/** A device node's rect width: wide enough for both its name and its image (up to
 *  MAX_IMAGE_CHARS), from 112px up to the cap. The same formula draws the rect (useForceLayout.ts)
 *  and sizes it for a fit, so the two can never disagree. */
export function deviceNodeWidth(node: Pick<DeviceNode, "name" | "image">): number {
  const forName = node.name.length * NAME_CHAR_W + 58;
  const imageChars = Math.min(node.image?.length ?? 0, MAX_IMAGE_CHARS);
  const forImage = imageChars * IMAGE_CHAR_W + 28 + 2 * IMAGE_MARGIN;
  return Math.min(MAX_DEVICE_NODE_WIDTH, Math.max(112, forName, forImage));
}

/** Half the width and height a node takes on the canvas, around its centre. A device is its rect
 *  plus the corner badges, which sit on the rect's edge and stick out by 6px on each side
 *  (r 9, centred 3px inside); a domain is its r-18 circle, or its label where that is wider
 *  (~7.6px per character at the domain label's monospace size) — just its circle while the Display
 *  panel hides domain names (`cdName` false). A node is drawn at 1× and scaled as a whole by the
 *  Display panel's size (`scale`), so its extent scales the same way. */
export function nodeExtent(
  node: Pick<DeviceNode, "type" | "name" | "image"> | Pick<DomainNode, "type" | "name">,
  scale = 1,
  cdName = true,
): { hw: number; hh: number } {
  if (node.type === "dev") return { hw: (deviceNodeWidth(node) / 2 + 6) * scale, hh: 23 * scale };
  return { hw: Math.max(18, cdName ? node.name.length * 3.8 : 0) * scale, hh: 18 * scale };
}

/** A collapsed point-to-point domain (collapsibleDomains) is drawn as a dot on the middle of its
 *  link, with its name just above. */
export const COLLAPSED_DOT_R = 4;
export const COLLAPSED_LABEL_Y = -8;

/** nodeExtent for a collapsed point-to-point domain: its dot, and its name above it while domain
 *  names show. */
export function collapsedDomainExtent(name: string, scale = 1, cdName = true): { hw: number; hh: number } {
  const dot = COLLAPSED_DOT_R + 2;
  if (!cdName) return { hw: dot * scale, hh: dot * scale };
  return { hw: Math.max(dot, name.length * 3.8) * scale, hh: 16 * scale };
}

/** The domains the Display panel's "Collapse point-to-point domains" draws as one straight link
 *  between their two devices, each with those two device ids: exactly two interfaces on it, from
 *  two different devices, and no external one — a domain reaching out of the lab keeps its circle. */
export function collapsibleDomains(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
): Map<string, [string, string]> {
  const ends = new Map<string, string[]>();
  for (const e of edges) ends.set(e.target, [...(ends.get(e.target) ?? []), e.source]);
  const out = new Map<string, [string, string]>();
  for (const nd of nodes) {
    if (nd.type !== "cd" || nd.external.length) continue;
    const devs = ends.get(nd.id) ?? [];
    if (devs.length === 2 && devs[0] !== devs[1]) out.set(nd.id, [devs[0], devs[1]]);
  }
  return out;
}

/** An interface label's box around its anchor point: the `ethN` line, then the IP and MAC lines
 *  under it (EDGE_LABEL_LINE_Y). Axis-aligned, like the nodes, so the two can be separated exactly. */
export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Each label line's baseline below the anchor, as the lines are drawn at 1×. */
export const EDGE_LABEL_LINE_Y = { name: -3, ip: 12, mac: 27 } as const;

/** The label lines' baselines at the Display panel's size: the font grows with it (the labels'
 *  CSS multiplies their font size by `--kt-topo-scale`), and so does the spacing between lines. */
export function edgeLabelLineY(scale: number): { name: number; ip: number; mac: number } {
  const y = EDGE_LABEL_LINE_Y;
  return { name: y.name * scale, ip: y.ip * scale, mac: y.mac * scale };
}

/** The warning drawn after an interface's `ethN` when its running addresses differ from the
 *  startup's (ipMismatches): its centre sits EDGE_WARN_GAP past the end of the name, and it is
 *  EDGE_WARN_R across each way from there. At 1×, like EDGE_LABEL_LINE_Y. */
export const EDGE_WARN_GAP = 10;
export const EDGE_WARN_R = 6;

/** Half the width of an interface's `ethN` text at 1× (monospace, 0.6em at 12px). */
export function edgeNameHalfWidth(label: string): number {
  return (label.length * 7.2) / 2;
}

/** The box an interface's label takes, counting only the lines on show and the warning (`warn`).
 *  Widths are estimated from the text (monospace: 0.6em per character, at 12px for `ethN` and
 *  11px for IP/MAC), plus the 2px halo each line is drawn with; the whole box scales with the text
 *  (`scale`). The box stays centred on the anchor, so the warning widens it on both sides. */
export function edgeLabelBox(
  edge: Pick<TopoEdge, "label" | "ips" | "mac">,
  show: { ips: boolean; macs: boolean },
  scale = 1,
  warn = false,
): LabelBox {
  const nameHalf = edgeNameHalfWidth(edge.label);
  const widths = [2 * (warn ? nameHalf + EDGE_WARN_GAP + EDGE_WARN_R : nameHalf)];
  let bottom = EDGE_LABEL_LINE_Y.name + 5;
  if (show.ips && edge.ips.length) {
    widths.push(edge.ips.join(", ").length * 6.6);
    bottom = EDGE_LABEL_LINE_Y.ip + 5;
  }
  if (show.macs && edge.mac) {
    widths.push(edge.mac.length * 6.6);
    bottom = EDGE_LABEL_LINE_Y.mac + 5;
  }
  const half = (Math.max(...widths) / 2 + 2) * scale;
  return { left: -half, right: half, top: (EDGE_LABEL_LINE_Y.name - 11) * scale, bottom: bottom * scale };
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

/** How far along its edge an interface's label sits, from the device: as a rule, and on every other
 *  one of a device's edges fanning out side by side (staggeredLabelAlong, services/topologyLayout.ts)
 *  — all the way along, up against the far end. A label the device's own clearance pushes out sits
 *  at that clearance whatever its `along`, so only the far end keeps two neighbours apart, and the
 *  longer the edges the further apart. */
export const LABEL_ALONG = 0.38;
export const LABEL_ALONG_STAGGERED = 1;

/** Where an interface's label goes on the edge from device `a` to domain `b`, and `need`: how long
 *  the edge must be (centre to centre) for the label to clear both nodes. With room to spare the
 *  label sits `along` of the way (LABEL_ALONG), pushed out of either node when that would overlap
 *  it; without room, halfway between the two positions that would clear each node. `need` does not
 *  depend on `along`. */
export function edgeLabelPlacement(
  a: { x: number; y: number },
  aExt: { hw: number; hh: number },
  b: { x: number; y: number },
  bExt: { hw: number; hh: number },
  box: LabelBox,
  along = LABEL_ALONG,
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
  const t = need <= len ? Math.min(Math.max(len * along, fromA), len - fromB) : (fromA + len - fromB) / 2;
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
