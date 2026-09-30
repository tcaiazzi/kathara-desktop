import { describe, expect, it } from "vitest";
import { labDetail, machine } from "../test/fixtures";
import {
  collapsedDomainExtent,
  collapsibleDomains,
  computeTopology,
  edgeLabelBox,
  edgeLabelPlacement,
  LABEL_ALONG,
  LABEL_ALONG_STAGGERED,
  nodeExtent,
  type TopoModel,
} from "./topology";
import {
  deviceTiers,
  GROUP_PAD,
  groupBoxes,
  groupedSeeds,
  groupKey,
  layeredLayout,
  nodeGroups,
  staggeredLabelAlong,
  type LayoutSizes,
} from "./topologyLayout";
import type { MachineDetail } from "./types";

const CENTER = { x: 400, y: 300 };

// Devices by name, each with the domains its interfaces are on (eth0, eth1, … in that order).
function model(devices: Record<string, string[]>): TopoModel {
  const machines: MachineDetail[] = Object.entries(devices).map(([name, links]) =>
    machine({ name, image: "kathara/frr", interfaces: links.map((link, num) => ({ num, link, mac_address: null })) }),
  );
  return computeTopology(labDetail({ machines }));
}

// A two-pod fat tree shaped like the ones Kathara's fat-tree generator writes: every leaf of a pod
// linked to every spine of the pod, every spine to every top-of-fabric switch, one point-to-point
// domain per link. Each leaf has one more domain below it: a stub, or a LAN with a server on it.
function fatTree(servers: boolean): TopoModel {
  const devices: Record<string, string[]> = {};
  const link = (a: string, b: string) => {
    const cd = `${a}~${b}`;
    (devices[a] ??= []).push(cd);
    (devices[b] ??= []).push(cd);
  };
  for (const pod of [1, 2]) {
    for (const l of [1, 2]) {
      const leaf = `leaf_${pod}_0_${l}`;
      for (const s of [1, 2]) link(leaf, `spine_${pod}_1_${s}`);
      (devices[leaf] ??= []).push(`lan_${pod}_${l}`);
      if (servers) devices[`server_${pod}_0_${l}`] = [`lan_${pod}_${l}`];
    }
    for (const s of [1, 2]) for (const t of [1, 2]) link(`spine_${pod}_1_${s}`, `tof_1_2_${t}`);
  }
  return model(devices);
}

function sizesOf(m: TopoModel, collapsed: ReadonlyMap<string, unknown> = new Map()): LayoutSizes {
  return {
    extents: Object.fromEntries(
      m.nodes.map((nd) => [nd.id, collapsed.has(nd.id) ? collapsedDomainExtent(nd.name) : nodeExtent(nd)]),
    ),
    labelBoxes: m.edges.map((e) => edgeLabelBox(e, { ips: true, macs: false })),
  };
}

function tiersByName(m: TopoModel): Record<string, number> {
  return Object.fromEntries(Object.entries(deviceTiers(m.nodes, m.edges)).map(([id, t]) => [id.slice(4), t]));
}

describe("deviceTiers", () => {
  it("counts a fat tree's tiers up from its leaves when it has no servers", () => {
    const tiers = tiersByName(fatTree(false));
    for (const [name, t] of Object.entries(tiers)) {
      expect(t, name).toBe(name.startsWith("leaf") ? 0 : name.startsWith("spine") ? 1 : 2);
    }
  });

  it("counts a fat tree's tiers up from its servers when it has them", () => {
    const tiers = tiersByName(fatTree(true));
    const expected: Record<string, number> = { server: 0, leaf: 1, spine: 2, tof: 3 };
    for (const [name, t] of Object.entries(tiers)) expect(t, name).toBe(expected[name.split("_")[0]]);
  });

  it("counts a ring from its first device by name, instead of putting it all on one tier", () => {
    const tiers = tiersByName(model({ r1: ["A", "B"], r2: ["B", "C"], r3: ["C", "D"], r4: ["D", "A"] }));
    expect(tiers).toEqual({ r1: 0, r2: 1, r4: 1, r3: 2 });
  });

  it("puts a device with no interfaces on tier 0", () => {
    expect(tiersByName(model({ pc1: [] }))).toEqual({ pc1: 0 });
  });
});

describe("layeredLayout", () => {
  const byName = (m: TopoModel, positions: ReturnType<typeof layeredLayout>) =>
    Object.fromEntries(m.nodes.map((nd) => [nd.name, positions[nd.id]]));

  it("draws a fat tree's top tier at the top, then its spines, then its leaves", () => {
    const m = fatTree(false);
    const p = byName(m, layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER));
    const ys = (prefix: string) => Object.entries(p).filter(([n]) => n.startsWith(prefix) && !n.includes("~")).map(([, q]) => q.y);
    expect(Math.max(...ys("tof_"))).toBeLessThan(Math.min(...ys("spine_")));
    expect(Math.max(...ys("spine_"))).toBeLessThan(Math.min(...ys("leaf_")));
    // Each tier on one row.
    for (const prefix of ["tof_", "spine_", "leaf_"]) expect(new Set(ys(prefix)).size).toBe(1);
  });

  it("runs the tiers from left to right in the lr direction", () => {
    const m = fatTree(false);
    const p = byName(m, layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER, { direction: "lr" }));
    const xs = (prefix: string) => Object.entries(p).filter(([n]) => n.startsWith(prefix) && !n.includes("~")).map(([, q]) => q.x);
    expect(Math.max(...xs("tof_"))).toBeLessThan(Math.min(...xs("spine_")));
    expect(Math.max(...xs("spine_"))).toBeLessThan(Math.min(...xs("leaf_")));
  });

  it("puts each point-to-point domain between the two rows it joins", () => {
    const m = fatTree(false);
    const p = layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER);
    for (const nd of m.nodes) {
      if (nd.type !== "cd" || nd.members.length !== 2) continue;
      const [a, b] = nd.members.map((name) => p[`dev:${name}`].y);
      expect(p[nd.id].y).toBeGreaterThan(Math.min(a, b));
      expect(p[nd.id].y).toBeLessThan(Math.max(a, b));
    }
  });

  it("puts a stub domain below its device, and one on the top tier above it", () => {
    const m = model({ top: ["up", "A"], mid: ["A", "B"], low: ["B", "stub"] });
    const p = byName(m, layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER));
    expect(p.stub.y).toBeGreaterThan(p.low.y);
    expect(p.up.y).toBeLessThan(p.top.y);
  });

  it("keeps the nodes of a row from overlapping", () => {
    const m = fatTree(true);
    const sizes = sizesOf(m);
    const p = layeredLayout(m.nodes, m.edges, sizes, CENTER);
    for (const a of m.nodes) {
      for (const b of m.nodes) {
        if (a.id >= b.id || p[a.id].y !== p[b.id].y) continue;
        expect(Math.abs(p[a.id].x - p[b.id].x), `${a.name} / ${b.name}`).toBeGreaterThanOrEqual(
          sizes.extents[a.id].hw + sizes.extents[b.id].hw,
        );
      }
    }
  });

  it("leaves every interface label room to clear both ends of its edge", () => {
    const m = fatTree(true);
    const sizes = sizesOf(m);
    const p = layeredLayout(m.nodes, m.edges, sizes, CENTER);
    m.edges.forEach((e, i) => {
      const a = p[e.source];
      const b = p[e.target];
      const { need } = edgeLabelPlacement(a, sizes.extents[e.source], b, sizes.extents[e.target], sizes.labelBoxes[i]);
      expect(Math.hypot(b.x - a.x, b.y - a.y), `${e.device} ${e.label}`).toBeGreaterThanOrEqual(need);
    });
  });

  it("keeps a fat tree's pods apart, each pod's leaves and spines side by side", () => {
    const m = fatTree(false);
    const p = byName(m, layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER));
    expect(Math.max(p.leaf_1_0_1.x, p.leaf_1_0_2.x)).toBeLessThan(Math.min(p.leaf_2_0_1.x, p.leaf_2_0_2.x));
    expect(Math.max(p.spine_1_1_1.x, p.spine_1_1_2.x)).toBeLessThan(Math.min(p.spine_2_1_1.x, p.spine_2_1_2.x));
  });

  it("gives the same arrangement whatever order the nodes and edges come in", () => {
    const m = fatTree(true);
    const sizes = sizesOf(m);
    const reversed: TopoModel = { nodes: [...m.nodes].reverse(), edges: [...m.edges].reverse() };
    const reversedSizes = { ...sizes, labelBoxes: [...sizes.labelBoxes].reverse() };
    expect(layeredLayout(reversed.nodes, reversed.edges, reversedSizes, CENTER)).toEqual(
      layeredLayout(m.nodes, m.edges, sizes, CENTER),
    );
  });

  it("centres the arrangement on the given point", () => {
    const m = fatTree(false);
    const p = Object.values(layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER));
    const xs = p.map((q) => q.x);
    const ys = p.map((q) => q.y);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(CENTER.x);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(CENTER.y);
  });

  it("places a device with no interfaces and a domain with no device", () => {
    const m = computeTopology(
      labDetail({
        machines: [machine({ name: "pc1" })],
        links: [{ name: "D", machines: [], external: [], running: false, draft: true, network_plugin: null }],
      }),
    );
    const p = byName(m, layeredLayout(m.nodes, m.edges, sizesOf(m), CENTER));
    expect(Object.keys(p).sort()).toEqual(["D", "pc1"]);
    expect(p.D.y).toBeGreaterThan(p.pc1.y);
  });

  it("gives collapsed point-to-point domains no row, and puts each on the middle of its link", () => {
    const m = fatTree(true);
    const collapsed = collapsibleDomains(m.nodes, m.edges);
    const p = layeredLayout(m.nodes, m.edges, sizesOf(m, collapsed), CENTER, { collapsed });
    // Every domain is point-to-point, the servers' LANs included: only the four device tiers are left.
    expect(collapsed.size).toBe(m.nodes.filter((nd) => nd.type === "cd").length);
    expect(new Set(m.nodes.filter((nd) => nd.type === "dev").map((nd) => p[nd.id].y)).size).toBe(4);
    for (const [cd, [a, b]] of collapsed) {
      expect(p[cd].x).toBeCloseTo((p[a].x + p[b].x) / 2);
      expect(p[cd].y).toBeCloseTo((p[a].y + p[b].y) / 2);
    }
  });

  it("leaves each half of a collapsed link room for its interface label", () => {
    const m = fatTree(true);
    const collapsed = collapsibleDomains(m.nodes, m.edges);
    const sizes = sizesOf(m, collapsed);
    const p = layeredLayout(m.nodes, m.edges, sizes, CENTER, { collapsed });
    m.edges.forEach((e, i) => {
      const a = p[e.source];
      const b = p[e.target];
      const { need } = edgeLabelPlacement(a, sizes.extents[e.source], b, sizes.extents[e.target], sizes.labelBoxes[i]);
      expect(Math.hypot(b.x - a.x, b.y - a.y), `${e.device} ${e.label}`).toBeGreaterThanOrEqual(need);
    });
  });

  it("keeps apart the labels of the edges a device fans out to one side", () => {
    const m = fatTree(true);
    const sizes = sizesOf(m);
    const p = layeredLayout(m.nodes, m.edges, sizes, CENTER);
    const along = staggeredLabelAlong(m.edges, p);
    const rects = m.edges.map((e, i) => {
      const box = sizes.labelBoxes[i];
      const { x, y } = edgeLabelPlacement(p[e.source], sizes.extents[e.source], p[e.target], sizes.extents[e.target], box, along[i]);
      return { device: e.source, up: p[e.target].y < p[e.source].y, x0: x + box.left, x1: x + box.right, y0: y + box.top, y1: y + box.bottom };
    });
    for (const [i, a] of rects.entries()) {
      for (const b of rects.slice(i + 1)) {
        if (a.device !== b.device || a.up !== b.up) continue;
        const apart = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
        expect(apart, `${a.device}: ${m.edges[i].label} / ${m.edges[rects.indexOf(b)].label}`).toBe(true);
      }
    }
  });

  it("returns nothing for an empty graph", () => {
    expect(layeredLayout([], [], { extents: {}, labelBoxes: [] }, CENTER)).toEqual({});
  });
});

describe("groupKey", () => {
  it("drops the last segment of a name with separators", () => {
    expect(groupKey("leaf_1_0_1")).toBe("leaf_1_0");
    expect(groupKey("as100-r1")).toBe("as100");
  });

  it("keeps the AS-style prefix before a trailing role and number", () => {
    expect(groupKey("as100r1")).toBe("as100");
    expect(groupKey("as20pc2")).toBe("as20");
  });

  it("otherwise drops the trailing digits, and never leaves a name empty", () => {
    expect(groupKey("pc1")).toBe("pc");
    expect(groupKey("router")).toBe("router");
    expect(groupKey("42")).toBe("42");
  });
});

describe("nodeGroups", () => {
  const m = model({
    as100r1: ["A", "X"],
    as100r2: ["A"],
    as200r1: ["B", "X"],
    as200r2: ["B"],
    lonely1: ["X"],
  });
  const groups = Object.fromEntries([...nodeGroups(m.nodes)].map(([id, g]) => [id, g]));

  it("groups devices sharing a key, and a domain whose devices are all in one group", () => {
    expect(groups).toMatchObject({
      "dev:as100r1": "as100",
      "dev:as100r2": "as100",
      "dev:as200r1": "as200",
      "cd:A": "as100",
      "cd:B": "as200",
    });
  });

  it("leaves out a device alone in its group and a domain joining several groups", () => {
    expect(groups["dev:lonely1"]).toBeUndefined();
    expect(groups["cd:X"]).toBeUndefined();
  });
});

describe("groupedSeeds", () => {
  it("starts each group around its own centre, the groups apart from each other", () => {
    const m = model({ as1r1: ["A"], as1r2: ["A"], as2r1: ["B"], as2r2: ["B"] });
    const groups = nodeGroups(m.nodes);
    const seeds = groupedSeeds(m.nodes, groups, CENTER, 200);
    const centre = (g: string) => {
      const ps = m.nodes.filter((nd) => groups.get(nd.id) === g).map((nd) => seeds[nd.id]);
      return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
    };
    const a = centre("as1");
    const b = centre("as2");
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(400);
    expect(Object.keys(seeds).sort()).toEqual(m.nodes.map((nd) => nd.id).sort());
  });
});

describe("groupBoxes", () => {
  it("boxes each group's nodes with their extents, plus the padding", () => {
    const boxes = groupBoxes(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 100, y: 50 },
        { id: "c", x: 500, y: 500 },
      ],
      { a: { hw: 10, hh: 5 }, b: { hw: 20, hh: 5 }, c: { hw: 1, hh: 1 } },
      new Map([
        ["a", "g"],
        ["b", "g"],
      ]),
    );
    expect([...boxes]).toEqual([
      [
        "g",
        {
          x: -10 - GROUP_PAD.side,
          y: -5 - GROUP_PAD.top,
          width: 130 + 2 * GROUP_PAD.side,
          height: 60 + GROUP_PAD.top + GROUP_PAD.side,
        },
      ],
    ]);
  });
});

describe("staggeredLabelAlong", () => {
  it("staggers every other edge a device fans out to one side, in order along the row", () => {
    const m = model({ top: ["A", "B", "C"], low1: ["A"], low2: ["B"], low3: ["C"] });
    const p = { "dev:top": { x: 0, y: 0 }, "cd:A": { x: -100, y: 100 }, "cd:B": { x: 0, y: 100 }, "cd:C": { x: 100, y: 100 } };
    const along = staggeredLabelAlong(m.edges, { ...p, "dev:low1": { x: -100, y: 200 }, "dev:low2": { x: 0, y: 200 }, "dev:low3": { x: 100, y: 200 } });
    const of = (device: string, cd: string) => along[m.edges.findIndex((e) => e.device === device && e.target === cd)];
    expect([of("top", "cd:A"), of("top", "cd:B"), of("top", "cd:C")]).toEqual([LABEL_ALONG, LABEL_ALONG_STAGGERED, LABEL_ALONG]);
    // Each low device has one edge, towards the rows before it: nothing to stagger.
    expect([of("low1", "cd:A"), of("low2", "cd:B"), of("low3", "cd:C")]).toEqual([LABEL_ALONG, LABEL_ALONG, LABEL_ALONG]);
  });

  it("orders a collapsed link's edge by the device at its far end", () => {
    const m = model({ top: ["P", "Q"], a: ["P"], b: ["Q"] });
    const collapsed = collapsibleDomains(m.nodes, m.edges);
    const p = { "dev:top": { x: 0, y: 0 }, "dev:a": { x: 100, y: 100 }, "dev:b": { x: -100, y: 100 } };
    const along = staggeredLabelAlong(m.edges, p, "tb", collapsed);
    const of = (device: string, cd: string) => along[m.edges.findIndex((e) => e.device === device && e.target === cd)];
    expect([of("top", "cd:Q"), of("top", "cd:P")]).toEqual([LABEL_ALONG, LABEL_ALONG_STAGGERED]);
  });
});
