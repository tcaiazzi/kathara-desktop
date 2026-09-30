// The topology graph's layouts beyond the plain force simulation: the layered one, computed once and
// drawn by the engine in hooks/useForceLayout.ts as pinned positions, and the pieces of the grouped
// one the engine's simulation works with (the groups, where it starts, the boxes it draws). Pure (no
// DOM), so every rule here is unit-tested.
// Node and label sizes come in from the caller — nodeExtent / edgeLabelBox at the size and label
// lines on show — so an arrangement leaves exactly the room the engine will draw things with.

import {
  edgeLabelPlacement,
  LABEL_ALONG,
  LABEL_ALONG_STAGGERED,
  type LabelBox,
  type NodePositions,
  type TopoEdge,
  type TopoNode,
} from "./topology";

/** Which way the tiers of a layered layout run: the top tier at the top ("tb") or at the left ("lr"). */
export type LayeredDirection = "tb" | "lr";

export interface LayoutSizes {
  // Each node's half-size, by node id (nodeExtent).
  extents: Record<string, { hw: number; hh: number }>;
  // Each edge's label box, by edge index (edgeLabelBox).
  labelBoxes: readonly LabelBox[];
}

// Clear space between the nodes of two neighbouring rows, and between neighbours in a row.
const ROW_GAP = 40;
const NODE_GAP = 24;
// How much longer than its label needs an edge is kept — the engine's spring rests at the same margin.
const LABEL_SLACK = 8;
const ROW_GAP_STEP = 8;
const ROW_GAP_MAX_EXTRA = 800;
// How much further a gap may widen, past what its edges need, to pull staggered labels clear of
// each other — past that, overlapping labels are left as they are.
const LABEL_GAP_MAX_EXTRA = 240;
// Room kept between two labels' boxes.
const LABEL_GAP = 2;
const ORDER_SWEEPS = 8;
const RELAX_PASSES = 3;

const NO_BOX: LabelBox = { left: 0, right: 0, top: 0, bottom: 0 };

function byName(a: TopoNode, b: TopoNode): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// Device → the domains it has an interface on, and domain → the devices on it. From the edges, which
// are what the engine draws; a device with two interfaces on one domain counts that domain once.
function incidence(nodes: readonly TopoNode[], edges: readonly TopoEdge[]) {
  const cdsOf = new Map<string, Set<string>>();
  const devsOf = new Map<string, Set<string>>();
  for (const nd of nodes) (nd.type === "dev" ? cdsOf : devsOf).set(nd.id, new Set());
  for (const e of edges) {
    const cds = cdsOf.get(e.source);
    const devs = devsOf.get(e.target);
    if (!cds || !devs) continue;
    cds.add(e.target);
    devs.add(e.source);
  }
  return { cdsOf, devsOf };
}

/** Each device's tier, by node id: its distance, in collision-domain hops, from the devices with the
 *  fewest domains in its connected component — the servers of a fat tree (or, with no servers, its
 *  leaves), then leaf, spine, top-of-fabric. The tiers come from the wiring, not from the images:
 *  in a fat tree every switch runs the same router image. When every device of a component has as
 *  many domains as the others (a ring, a full mesh), the tiers count from its first device by name
 *  instead, since counting from all of them would leave the whole component on one row. A device
 *  with no interfaces is tier 0. */
export function deviceTiers(nodes: readonly TopoNode[], edges: readonly TopoEdge[]): Record<string, number> {
  const { cdsOf, devsOf } = incidence(nodes, edges);
  const neighbors = new Map<string, string[]>();
  for (const [dev, cds] of cdsOf) {
    const out = new Set<string>();
    for (const cd of cds) for (const other of devsOf.get(cd) ?? []) if (other !== dev) out.add(other);
    neighbors.set(dev, [...out]);
  }

  const tiers: Record<string, number> = {};
  const seen = new Set<string>();
  for (const start of nodes.filter((nd) => nd.type === "dev").sort(byName)) {
    if (seen.has(start.id)) continue;
    // The component, in BFS order from its first device by name.
    const component = [start.id];
    seen.add(start.id);
    for (let i = 0; i < component.length; i++) {
      for (const nb of neighbors.get(component[i]) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        component.push(nb);
      }
    }
    const degree = (id: string) => cdsOf.get(id)?.size ?? 0;
    const fewest = Math.min(...component.map(degree));
    let sources = component.filter((id) => degree(id) === fewest);
    if (sources.length === component.length && component.length > 1) sources = [start.id];

    const queue = [...sources];
    for (const id of sources) tiers[id] = 0;
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const nb of neighbors.get(id) ?? []) {
        if (nb in tiers) continue;
        tiers[nb] = tiers[id] + 1;
        queue.push(nb);
      }
    }
  }
  return tiers;
}

// Each node's rank: device tier t at 2t, a domain on the odd rank between its devices' tiers. A
// domain whose devices all sit on one tier (a stub, a LAN of hosts only) goes half a rank below it,
// or above it when that is the top tier, so it never lands on a row of devices; one with no device
// at all goes to the very bottom.
function nodeRanks(nodes: readonly TopoNode[], edges: readonly TopoEdge[]): Map<string, number> {
  const tiers = deviceTiers(nodes, edges);
  const { devsOf } = incidence(nodes, edges);
  const topTier = Math.max(0, ...Object.values(tiers));
  const ranks = new Map<string, number>();
  for (const nd of nodes) {
    if (nd.type === "dev") {
      ranks.set(nd.id, 2 * (tiers[nd.id] ?? 0));
      continue;
    }
    const memberTiers = [...(devsOf.get(nd.id) ?? [])].map((d) => tiers[d] ?? 0);
    if (!memberTiers.length) {
      ranks.set(nd.id, -1);
      continue;
    }
    const lo = Math.min(...memberTiers);
    const hi = Math.max(...memberTiers);
    if (lo !== hi) ranks.set(nd.id, (lo + hi) % 2 ? lo + hi : 2 * lo + 1);
    else ranks.set(nd.id, lo === topTier && lo > 0 ? 2 * lo + 1 : 2 * lo - 1);
  }
  return ranks;
}

// Pairs of edges between two neighbouring rows that cross, summed over every pair of rows.
function countCrossings(rows: readonly string[][], adj: Map<string, string[]>, rowOf: Map<string, number>): number {
  let total = 0;
  for (let r = 0; r + 1 < rows.length; r++) {
    const below = new Map(rows[r + 1].map((id, i) => [id, i]));
    const segs: [number, number][] = [];
    rows[r].forEach((id, i) => {
      for (const nb of adj.get(id) ?? []) if (rowOf.get(nb) === r + 1) segs.push([i, below.get(nb) ?? 0]);
    });
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) total++;
      }
    }
  }
  return total;
}

// The order within each row: barycentre sweeps, alternately down and up, each node moving to the mean
// relative position of its neighbours in the rows already swept. Ties keep the incoming order, which
// starts as the natural name order — so `leaf_1_*` and `leaf_2_*` start out as two groups. The sweep
// with the fewest crossings wins.
function orderRows(rows: string[][], adj: Map<string, string[]>, rowOf: Map<string, number>): string[][] {
  let best = rows.map((r) => [...r]);
  let bestCrossings = countCrossings(best, adj, rowOf);
  const current = rows.map((r) => [...r]);
  const frac = new Map<string, number>();
  const setFrac = (row: string[]) => row.forEach((id, i) => frac.set(id, (i + 0.5) / row.length));
  current.forEach(setFrac);
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep++) {
    const down = sweep % 2 === 0;
    for (let k = 1; k < current.length; k++) {
      const r = down ? k : current.length - 1 - k;
      const bary = new Map<string, number>();
      for (const id of current[r]) {
        const ref = (adj.get(id) ?? []).filter((nb) => {
          const nr = rowOf.get(nb) ?? r;
          return down ? nr < r : nr > r;
        });
        bary.set(id, ref.length ? mean(ref.map((nb) => frac.get(nb) ?? 0)) : frac.get(id) ?? 0);
      }
      current[r].sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0));
      setFrac(current[r]);
    }
    const crossings = countCrossings(current, adj, rowOf);
    if (crossings < bestCrossings) {
      best = current.map((r) => [...r]);
      bestCrossings = crossings;
    }
  }
  return best;
}

export interface LayeredOptions {
  direction?: LayeredDirection;
  // The point-to-point domains drawn collapsed (collapsibleDomains), each with its two devices: they
  // get no row of their own, and sit on the middle of their link.
  collapsed?: ReadonlyMap<string, readonly [string, string]>;
}

/** Where along its edge each interface label sits (edgeLabelPlacement's `along`), by edge index, for
 *  a layered arrangement. The edges a device fans out to one side (towards the rows before it, or
 *  the rows after it) are taken in order along the row, and every other one gets
 *  LABEL_ALONG_STAGGERED instead of LABEL_ALONG: side by side, two labels at the same distance from
 *  the device would sit abreast, a fraction of the spacing apart, however far the rows are apart.
 *  An edge of a collapsed link goes by the device at its far end. */
export function staggeredLabelAlong(
  edges: readonly TopoEdge[],
  positions: NodePositions,
  direction: LayeredDirection = "tb",
  collapsed: ReadonlyMap<string, readonly [string, string]> = new Map(),
): number[] {
  const tb = direction === "tb";
  const along = edges.map(() => LABEL_ALONG);
  const fans = new Map<string, { i: number; key: number }[]>();
  edges.forEach((e, i) => {
    const ends = collapsed.get(e.target);
    const far = ends ? (ends[0] === e.source ? ends[1] : ends[0]) : e.target;
    const p = positions[e.source];
    const q = positions[far];
    if (!p || !q) return;
    const side = Math.sign(tb ? q.y - p.y : q.x - p.x);
    if (!side) return;
    const fan = `${e.source}\n${side}`;
    fans.set(fan, [...(fans.get(fan) ?? []), { i, key: tb ? q.x : q.y }]);
  });
  for (const fan of fans.values()) {
    fan.sort((a, b) => a.key - b.key || a.i - b.i);
    fan.forEach(({ i }, k) => {
      if (k % 2) along[i] = LABEL_ALONG_STAGGERED;
    });
  }
  return along;
}

/** A layered ("hierarchical") arrangement: devices on rows by tier (deviceTiers), the top tier first,
 *  and each collision domain on a row of its own between the tiers it joins — a point-to-point domain
 *  on the middle of its link, or, collapsed, on no row at all. Rows are ordered to cut down edge
 *  crossings; they share one width, so a fat tree comes out symmetric, and each gap between rows is
 *  wide enough for every interface label across it to clear both its ends. Centred on `center`. */
export function layeredLayout(
  nodes: readonly TopoNode[],
  edges: readonly TopoEdge[],
  sizes: LayoutSizes,
  center: { x: number; y: number },
  { direction = "tb", collapsed = new Map() }: LayeredOptions = {},
): NodePositions {
  if (!nodes.length) return {};
  const tb = direction === "tb";
  const ext = (id: string) => sizes.extents[id] ?? { hw: 0, hh: 0 };
  // Half-sizes along a row and across it.
  const along = (id: string) => (tb ? ext(id).hw : ext(id).hh);
  const across = (id: string) => (tb ? ext(id).hh : ext(id).hw);
  const sep = (a: string, b: string) => along(a) + along(b) + NODE_GAP;
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));

  const ranks = nodeRanks(nodes, edges);
  const rankList = [...new Set([...ranks].filter(([id]) => !collapsed.has(id)).map(([, rank]) => rank))].sort(
    (a, b) => b - a,
  );
  const rows: string[][] = rankList.map((rank) =>
    nodes
      .filter((nd) => ranks.get(nd.id) === rank && !collapsed.has(nd.id))
      .sort(byName)
      .map((nd) => nd.id),
  );
  const rowOf = new Map<string, number>();
  rows.forEach((row, r) => row.forEach((id) => rowOf.set(id, r)));
  // What the ordering sees as linked: a device and its domain, or the two ends of a collapsed link.
  const adj = new Map<string, string[]>(nodes.map((nd) => [nd.id, []]));
  const link = (a: string, b: string) => {
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  };
  for (const e of edges) if (!collapsed.has(e.target) && adj.has(e.source) && adj.has(e.target)) link(e.source, e.target);
  for (const [a, b] of collapsed.values()) link(a, b);
  const ordered = orderRows(rows, adj, rowOf);
  // Along the rows. `pack` keeps a row's order and spacing, as close to `target` as one shift allows.
  const u = new Map<string, number>();
  const pack = (row: string[], target: number[]) => {
    const placed = [...target];
    for (let i = 1; i < row.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + sep(row[i - 1], row[i]));
    const shift = mean(target) - mean(placed);
    row.forEach((id, i) => u.set(id, placed[i] + shift));
  };
  const isDeviceRow = (row: string[]) => byId.get(row[0])?.type === "dev";
  const span = (row: string[]) => row.slice(1).reduce((s, id, i) => s + sep(row[i], id), 0);
  // One slot width for every row: the widest one packed tight fills it. The domain rows count too,
  // so the domains between two device rows fit under the links they sit on.
  const width = Math.max(
    0,
    ...ordered.filter((row) => row.length > 1).map((row) => (span(row) * row.length) / (row.length - 1)),
  );
  const slots = (row: string[]) => row.map((_, i) => ((i + 0.5) * width) / row.length - width / 2);
  for (const row of ordered) pack(row, slots(row));

  // Pull each device part of the way towards the devices it shares a domain with. A row keeps its
  // spread and only shifts as a whole or reorders its gaps, or the pulls would squeeze every row
  // towards the middle.
  const { cdsOf, devsOf } = incidence(nodes, edges);
  const peers = (dev: string) => {
    const out = new Set<string>();
    for (const cd of cdsOf.get(dev) ?? []) for (const d of devsOf.get(cd) ?? []) if (rowOf.get(d) !== rowOf.get(dev)) out.add(d);
    return [...out];
  };
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (const row of ordered.filter(isDeviceRow)) {
      const own = row.map((id) => u.get(id) ?? 0);
      const pulled = row.map((id, i) => {
        const ps = peers(id);
        return ps.length ? (own[i] + mean(ps.map((p) => u.get(p) ?? 0))) / 2 : own[i];
      });
      const spread = own[own.length - 1] - own[0];
      const pulledSpread = pulled[pulled.length - 1] - pulled[0];
      const k = pulledSpread > 1e-6 ? spread / pulledSpread : 1;
      const mid = mean(pulled);
      pack(
        row,
        pulled.map((x) => mid + (x - mid) * k),
      );
    }
  }

  // Each domain at the mean of its devices, its row re-sorted to match.
  for (let r = 0; r < ordered.length; r++) {
    const row = ordered[r];
    if (isDeviceRow(row)) continue;
    const fallback = slots(row);
    const target = new Map(
      row.map((id, i) => {
        const members = [...(devsOf.get(id) ?? [])];
        return [id, members.length ? mean(members.map((d) => u.get(d) ?? 0)) : fallback[i]];
      }),
    );
    const sorted = [...row].sort((a, b) => (target.get(a) ?? 0) - (target.get(b) ?? 0));
    ordered[r] = sorted;
    pack(
      sorted,
      sorted.map((id) => target.get(id) ?? 0),
    );
  }

  // Across the rows: each gap starts clear of both rows' nodes and widens until every edge between the
  // two rows is long enough for its label — for a collapsed link, each half up to its middle — and
  // then, within LABEL_GAP_MAX_EXTRA, until the (staggered) labels on those edges stop overlapping.
  const point = (id: string, v: number) => {
    const a = u.get(id) ?? 0;
    return tb ? { x: a, y: v } : { x: v, y: a };
  };
  const farEnd = (e: TopoEdge) => {
    const ends = collapsed.get(e.target);
    return ends ? (ends[0] === e.source ? ends[1] : ends[0]) : e.target;
  };
  const betweenRows = (r: number) =>
    edges.flatMap((e, i) => {
      const rs = rowOf.get(e.source);
      const rt = rowOf.get(farEnd(e));
      return (rs === r - 1 && rt === r) || (rs === r && rt === r - 1) ? [{ e, i, box: sizes.labelBoxes[i] ?? NO_BOX }] : [];
    });
  const midpoint = (p: { x: number; y: number }, q: { x: number; y: number }) => ({
    x: (p.x + q.x) / 2,
    y: (p.y + q.y) / 2,
  });
  // The stagger only depends on each row's order and side, so any spacing of the rows gives it.
  const provisional: NodePositions = {};
  for (const [id, r] of rowOf) provisional[id] = point(id, r);
  const labelAlong = staggeredLabelAlong(edges, provisional, direction, collapsed);
  const v = new Map<string, number>();
  let offset = 0;
  ordered.forEach((row, r) => {
    if (r > 0) {
      const prevOffset = offset;
      const base = Math.max(...ordered[r - 1].map(across)) + Math.max(...row.map(across)) + ROW_GAP;
      const crossing = betweenRows(r);
      const vOf = (id: string, gap: number) => (rowOf.get(id) === r ? prevOffset + gap : prevOffset);
      const ends = (e: TopoEdge, gap: number) => {
        const a = point(e.source, vOf(e.source, gap));
        const far = farEnd(e);
        const b = far === e.target ? point(far, vOf(far, gap)) : midpoint(a, point(far, vOf(far, gap)));
        return { a, b };
      };
      const clears = (gap: number) =>
        crossing.every(({ e, box }) => {
          const { a, b } = ends(e, gap);
          const { need } = edgeLabelPlacement(a, ext(e.source), b, ext(e.target), box);
          return Math.hypot(b.x - a.x, b.y - a.y) >= need + LABEL_SLACK;
        });
      const overlaps = (gap: number) => {
        const rects = crossing.map(({ e, i, box }) => {
          const { a, b } = ends(e, gap);
          const { x, y } = edgeLabelPlacement(a, ext(e.source), b, ext(e.target), box, labelAlong[i]);
          return { x0: x + box.left, x1: x + box.right, y0: y + box.top, y1: y + box.bottom };
        });
        let count = 0;
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const p = rects[i];
            const q = rects[j];
            if (p.x0 < q.x1 + LABEL_GAP && q.x0 < p.x1 + LABEL_GAP && p.y0 < q.y1 + LABEL_GAP && q.y0 < p.y1 + LABEL_GAP) {
              count++;
            }
          }
        }
        return count;
      };
      let gap = base;
      while (gap < base + ROW_GAP_MAX_EXTRA && !clears(gap)) gap += ROW_GAP_STEP;
      let best = gap;
      let fewest = overlaps(gap);
      for (let g = gap + ROW_GAP_STEP; fewest > 0 && g <= gap + LABEL_GAP_MAX_EXTRA; g += ROW_GAP_STEP) {
        const o = overlaps(g);
        if (o < fewest) {
          best = g;
          fewest = o;
        }
      }
      offset = prevOffset + best;
    }
    for (const id of row) v.set(id, offset);
  });

  const positions: NodePositions = {};
  for (const nd of nodes) if (!collapsed.has(nd.id)) positions[nd.id] = point(nd.id, v.get(nd.id) ?? 0);
  for (const [cd, [a, b]] of collapsed) {
    if (positions[a] && positions[b]) positions[cd] = midpoint(positions[a], positions[b]);
  }
  const xs = Object.values(positions).map((p) => p.x);
  const ys = Object.values(positions).map((p) => p.y);
  const dx = center.x - (Math.min(...xs) + Math.max(...xs)) / 2;
  const dy = center.y - (Math.min(...ys) + Math.max(...ys)) / 2;
  for (const p of Object.values(positions)) {
    p.x += dx;
    p.y += dy;
  }
  return positions;
}

/** The group a device's name puts it in, for the grouped layout: the name up to its last `_`/`-`
 *  segment (`leaf_1_0_1` → `leaf_1_0`, a pod and tier); else the AS-style prefix before a trailing
 *  role and number (`as100r1` → `as100`, `as20pc2` → `as20`); else the name without its trailing
 *  digits (`pc1` → `pc`). A name that would leave nothing is its own group. */
export function groupKey(name: string): string {
  const cut = Math.max(name.lastIndexOf("_"), name.lastIndexOf("-"));
  if (cut > 0) return name.slice(0, cut);
  const as = /^(.*?\d+)[a-z]+\d*$/i.exec(name);
  if (as) return as[1];
  return name.replace(/\d+$/, "") || name;
}

/** Each node's group, by node id, for the grouped layout: a device by groupKey, when at least one
 *  other device shares it, and a domain whose devices are all in one group. A domain joining
 *  several groups, and a device alone in its group, are in none. */
export function nodeGroups(nodes: readonly TopoNode[]): Map<string, string> {
  const devices = nodes.filter((nd) => nd.type === "dev");
  const count = new Map<string, number>();
  for (const nd of devices) count.set(groupKey(nd.name), (count.get(groupKey(nd.name)) ?? 0) + 1);
  const byName = new Map<string, string>();
  for (const nd of devices) {
    const g = groupKey(nd.name);
    if ((count.get(g) ?? 0) > 1) byName.set(nd.name, g);
  }
  const groups = new Map<string, string>();
  for (const nd of nodes) {
    if (nd.type === "dev") {
      const g = byName.get(nd.name);
      if (g !== undefined) groups.set(nd.id, g);
      continue;
    }
    const memberGroups = new Set(nd.members.map((m) => byName.get(m)));
    const [only] = memberGroups;
    if (memberGroups.size === 1 && only !== undefined) groups.set(nd.id, only);
  }
  return groups;
}

/** Where the grouped layout's simulation starts each node: the groups' centres spread on a circle
 *  of `radius` around `center`, in name order, and each group's nodes on a small circle around its
 *  own centre; nodes in no group start around `center`. Starting out apart, the groups do not have
 *  to push through each other to separate. */
export function groupedSeeds(
  nodes: readonly TopoNode[],
  groups: ReadonlyMap<string, string>,
  center: { x: number; y: number },
  radius: number,
): NodePositions {
  const names = [...new Set(groups.values())].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const centres = new Map(
    names.map((g, i) => {
      const a = (i / names.length) * Math.PI * 2;
      const r = names.length > 1 ? radius : 0;
      return [g, { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r }];
    }),
  );
  const members = new Map<string | undefined, string[]>();
  for (const nd of [...nodes].sort(byName)) {
    const g = groups.get(nd.id);
    members.set(g, [...(members.get(g) ?? []), nd.id]);
  }
  const seeds: NodePositions = {};
  for (const [g, ids] of members) {
    const c = (g !== undefined && centres.get(g)) || center;
    const r = 20 + 14 * Math.sqrt(ids.length);
    ids.forEach((id, i) => {
      const a = (i / ids.length) * Math.PI * 2;
      seeds[id] = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    });
  }
  return seeds;
}

export interface GroupBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Room a group's box leaves around its nodes; more above, where its name goes.
export const GROUP_PAD = { side: 14, top: 26 } as const;

/** Each group's box, by group name: its nodes' bounding box, each node counted with its extent,
 *  plus GROUP_PAD. */
export function groupBoxes(
  nodes: readonly { id: string; x: number; y: number }[],
  extents: Record<string, { hw: number; hh: number }>,
  groups: ReadonlyMap<string, string>,
): Map<string, GroupBox> {
  const bounds = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  for (const nd of nodes) {
    const g = groups.get(nd.id);
    if (g === undefined) continue;
    const { hw, hh } = extents[nd.id] ?? { hw: 0, hh: 0 };
    const b = bounds.get(g) ?? { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    bounds.set(g, {
      x0: Math.min(b.x0, nd.x - hw),
      y0: Math.min(b.y0, nd.y - hh),
      x1: Math.max(b.x1, nd.x + hw),
      y1: Math.max(b.y1, nd.y + hh),
    });
  }
  const boxes = new Map<string, GroupBox>();
  for (const [g, b] of bounds) {
    boxes.set(g, {
      x: b.x0 - GROUP_PAD.side,
      y: b.y0 - GROUP_PAD.top,
      width: b.x1 - b.x0 + 2 * GROUP_PAD.side,
      height: b.y1 - b.y0 + GROUP_PAD.top + GROUP_PAD.side,
    });
  }
  return boxes;
}
