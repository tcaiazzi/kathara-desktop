import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { HOST_BRIDGE } from "./constants";
import {
  computeTopology,
  deviceNodeWidth,
  edgeLabelBox,
  edgeLabelPlacement,
  type DeviceNode,
  type DomainNode,
  fitTransform,
  labelClearance,
  matchesSavedLayout,
  MAX_DEVICE_NODE_WIDTH,
  nodeExtent,
  overlayInsets,
  parseIfaceIps,
  planSeeds,
  sameIdSet,
} from "./topology";
import type { LabDetail, LinkDetail, MachineDetail } from "./types";

describe("parseIfaceIps", () => {
  it("picks up a plain IPv4 assignment", () => {
    expect(parseIfaceIps(machine(), "ip address add 10.0.0.1/24 dev eth0")).toEqual({
      0: ["10.0.0.1/24"],
    });
  });

  it("picks up an IPv6 assignment with no family flag", () => {
    expect(parseIfaceIps(machine(), "ip address add 2001:db8::1/64 dev eth0")).toEqual({
      0: ["2001:db8::1/64"],
    });
  });

  it("picks up an IPv6 assignment written with the -6 family flag", () => {
    expect(parseIfaceIps(machine(), "ip -6 addr add 2001:db8::1/64 dev eth0")).toEqual({
      0: ["2001:db8::1/64"],
    });
    expect(parseIfaceIps(machine(), "ip -6 address add 2001:db8::1/64 dev eth1")).toEqual({
      1: ["2001:db8::1/64"],
    });
  });

  it("collects both an IPv4 and an IPv6 address on the same interface", () => {
    const startup = ["ip address add 10.0.0.1/24 dev eth0", "ip -6 addr add 2001:db8::1/64 dev eth0"].join("\n");
    expect(parseIfaceIps(machine(), startup)).toEqual({
      0: ["10.0.0.1/24", "2001:db8::1/64"],
    });
  });
});

describe("matchesSavedLayout", () => {
  it("compares coordinates as integers, so sub-pixel drift is not a change", () => {
    expect(matchesSavedLayout({ pc1: { x: 10.2, y: 20.4 } }, { pc1: { x: 9.6, y: 19.5 } })).toBe(true);
    expect(matchesSavedLayout({ pc1: { x: 10, y: 20 } }, { pc1: { x: 11, y: 20 } })).toBe(false);
  });

  it("ignores saved nodes that are no longer on screen", () => {
    expect(matchesSavedLayout({ pc1: { x: 0, y: 0 } }, { pc1: { x: 0, y: 0 }, "cd:D": { x: 5, y: 5 } })).toBe(true);
  });

  it("differs when a node on screen is not in the saved layout", () => {
    expect(matchesSavedLayout({ pc1: { x: 0, y: 0 } }, { pc2: { x: 0, y: 0 } })).toBe(false);
    expect(matchesSavedLayout({ pc1: { x: 0, y: 0 }, pc2: { x: 5, y: 5 } }, { pc1: { x: 0, y: 0 } })).toBe(false);
  });

  it("never matches a missing saved layout", () => {
    expect(matchesSavedLayout({}, null)).toBe(false);
  });
});

describe("planSeeds", () => {
  const live = (x: number, y: number, fixed = false) => ({ x, y, fixed });

  it("keeps a surviving node where it was, pinned once the old graph had come to rest", () => {
    const carried = { positions: { a: live(10, 20) }, settled: true };

    expect(planSeeds(["a"], carried, { a: { x: 99, y: 99 } })).toEqual({ a: { x: 10, y: 20, fixed: true } });
  });

  it("lets a graph that was still settling keep settling, keeping only the nodes already pinned", () => {
    const carried = { positions: { a: live(10, 20), b: live(30, 40, true) }, settled: false };

    expect(planSeeds(["a", "b"], carried, {})).toEqual({
      a: { x: 10, y: 20, fixed: false },
      b: { x: 30, y: 40, fixed: true },
    });
  });

  it("places a node the old graph didn't have from the saved positions, pinned", () => {
    const carried = { positions: { a: live(10, 20) }, settled: true };

    expect(planSeeds(["a", "b"], carried, { b: { x: 5, y: 6 } }).b).toEqual({ x: 5, y: 6, fixed: true });
  });

  it("leaves a node with no known position to be laid out fresh", () => {
    expect(planSeeds(["a"], null, {})).toEqual({ a: null });
    expect(planSeeds(["a"], null, { a: { x: Number.NaN, y: 1 } })).toEqual({ a: null });
  });

  it("uses only the saved positions for a fresh layout", () => {
    expect(planSeeds(["a"], null, { a: { x: 1, y: 2 } })).toEqual({ a: { x: 1, y: 2, fixed: true } });
  });
});

describe("fitTransform", () => {
  it("centres the nodes' bounding box in the canvas", () => {
    const { scale, tx, ty } = fitTransform([{ x: 0, y: 0 }, { x: 200, y: 100 }], 600, 400);

    // Box 200x100 plus the 24px margin each side = 248x148, which fits 600x400 above 2x: clamped.
    expect(scale).toBe(2);
    // The box's centre (100, 50) lands on the canvas centre (300, 200).
    expect(100 * scale + tx).toBe(300);
    expect(50 * scale + ty).toBe(200);
  });

  it("scales down to the tighter of the two axes", () => {
    const { scale } = fitTransform([{ x: 0, y: 0 }, { x: 900, y: 100 }], 500, 500);

    expect(scale).toBe(500 / 948); // (900 + 2 × 24) wide into 500
  });

  it("keeps the scale within [0.3, 2]", () => {
    expect(fitTransform([{ x: 0, y: 0 }, { x: 10000, y: 0 }], 800, 600).scale).toBe(0.3);
    expect(fitTransform([{ x: 5, y: 5 }], 2000, 2000).scale).toBe(2);
  });

  it("counts each node's extent, so a wide node stays inside the view", () => {
    const { scale, tx } = fitTransform([{ x: 0, y: 0, hw: 130, hh: 23 }, { x: 400, y: 0, hw: 60, hh: 23 }], 800, 400);

    // Box from -130 to 460 = 590 wide, + 48 of margin: 638 into 800.
    expect(scale).toBe(800 / 638);
    expect(-130 * scale + tx).toBeCloseTo(24 * scale, 9); // the left edge sits one margin in
  });

  it("centres the graph in the part of the canvas the overlays leave free", () => {
    const insets = { top: 50, right: 0, bottom: 0, left: 120 };
    const { scale, tx, ty } = fitTransform([{ x: 0, y: 0 }, { x: 200, y: 100 }], 920, 450, insets, 0);

    // Free area 800x400 from (120, 50): the box's centre (100, 50) lands on (520, 250).
    expect(scale).toBe(2);
    expect(100 * scale + tx).toBe(520);
    expect(50 * scale + ty).toBe(250);
  });

  it("still gives a clamped scale when the insets leave no room at all", () => {
    const { scale } = fitTransform([{ x: 0, y: 0 }, { x: 100, y: 100 }], 300, 300, { top: 200, right: 0, bottom: 200, left: 0 });

    expect(scale).toBe(0.3);
  });

  it("puts a single node at the canvas centre", () => {
    const { scale, tx, ty } = fitTransform([{ x: 40, y: -10 }], 800, 600);

    expect(40 * scale + tx).toBe(400);
    expect(-10 * scale + ty).toBe(300);
  });
});

function lab(machines: MachineDetail[], links: LinkDetail[] = []): LabDetail {
  return {
    name: "l",
    id: "h",
    path: null,
    managed: true,
    n_machines: machines.length,
    n_links: links.length,
    deployed: false,
    n_running: 0,
    metadata: { description: null, version: null, author: null, email: null, web: null },
    machines,
    links,
    deploy_failed_machines: [],
  };
}

const iface = (num: number, link: string, mac: string | null = null) => ({ num, link, mac_address: mac });

describe("computeTopology", () => {
  it("turns each device into a node and each interface into an edge to its domain", () => {
    const model = computeTopology(
      lab(
        [
          machine({
            name: "r1",
            image: "kathara/frr",
            running: true,
            status: "running",
            interfaces: [iface(0, "A", "02:42:ac:11:00:02"), iface(1, "B")],
            exec_commands: ["ip address add 10.0.0.1/24 dev eth0"],
          }),
        ],
        [{ name: "A", machines: ["r1"], external: [], running: true, draft: false }],
      ),
      { r1: "ip address add 10.0.1.1/24 dev eth1\n" },
    );

    const r1 = model.nodes.find((n) => n.id === "dev:r1") as DeviceNode;
    expect(r1).toMatchObject({ type: "dev", category: "router", typeLabel: "FRR Router", running: true });
    expect(r1.ifaces).toEqual([
      { num: 0, link: "A", mac: "02:42:ac:11:00:02", ips: ["10.0.0.1/24"] },
      { num: 1, link: "B", mac: null, ips: ["10.0.1.1/24"] },
    ]);
    expect(model.edges).toEqual([
      { source: "dev:r1", target: "cd:A", label: "eth0", mac: "02:42:ac:11:00:02", ips: ["10.0.0.1/24"] },
      { source: "dev:r1", target: "cd:B", label: "eth1", mac: null, ips: ["10.0.1.1/24"] },
    ]);
    expect(model.nodes.map((n) => n.id)).toEqual(["dev:r1", "cd:A", "cd:B"]);
  });

  it("leaves Kathara's host bridge out of nodes and edges", () => {
    const model = computeTopology(
      lab(
        [machine({ interfaces: [iface(0, "A"), iface(1, HOST_BRIDGE)] })],
        [{ name: HOST_BRIDGE, machines: ["pc1"], external: [], running: true, draft: false }],
      ),
    );

    expect(model.nodes.map((n) => n.id)).toEqual(["dev:pc1", "cd:A"]);
    expect(model.edges.map((e) => [e.target, e.ips])).toEqual([["cd:A", []]]);  // no address known yet
  });

  it("keeps a listed domain's own running flag and external interfaces", () => {
    const model = computeTopology(
      lab(
        [machine({ running: true, interfaces: [iface(0, "A")] })],
        [{ name: "A", machines: ["pc1"], external: ["eth0"], running: false, draft: false }],
      ),
    );

    expect(model.nodes.find((n) => n.id === "cd:A")).toMatchObject({ running: false, external: ["eth0"], members: ["pc1"] });
  });

  it("marks a domain known only from interfaces running if any attached device runs, in any order", () => {
    const stoppedFirst = computeTopology(
      lab([
        machine({ name: "pc1", running: false, interfaces: [iface(0, "X")] }),
        machine({ name: "pc2", running: true, interfaces: [iface(0, "X")] }),
      ]),
    );
    const allStopped = computeTopology(lab([machine({ name: "pc1", interfaces: [iface(0, "X")] })]));

    const x = stoppedFirst.nodes.find((n) => n.id === "cd:X") as DomainNode;
    expect(x).toMatchObject({ running: true, members: ["pc1", "pc2"], external: [] });
    expect(allStopped.nodes.find((n) => n.id === "cd:X")).toMatchObject({ running: false });
  });

  it("shows a listed domain with no device attached, as the draft the backend says it is", () => {
    const model = computeTopology(lab([], [{ name: "EMPTY", machines: [], external: [], running: false, draft: true }]));

    expect(model.nodes).toEqual([
      { id: "cd:EMPTY", type: "cd", name: "EMPTY", external: [], running: false, draft: true, members: [], x: 0, y: 0, dx: 0, dy: 0 },
    ]);
    expect(model.edges).toEqual([]);
  });

  it("never shows a domain with a device on it as a draft, nor one only an interface names", () => {
    const pc1 = machine({ name: "pc1", interfaces: [{ num: 0, link: "A", mac_address: null }, { num: 1, link: "B", mac_address: null }] });
    const model = computeTopology(lab([pc1], [{ name: "A", machines: [], external: [], running: false, draft: true }]));

    expect(model.nodes.filter((n) => n.type === "cd").map((n) => [n.name, n.type === "cd" && n.draft])).toEqual([
      ["A", false],
      ["B", false],
    ]);
  });
});

describe("topology helpers, edge cases", () => {
  it("fits nodes whose bounding box does not start at the origin", () => {
    const { scale, tx, ty } = fitTransform([{ x: 100, y: 50 }, { x: 300, y: 150 }], 600, 400);

    // Box 200x100 + margins = 248x148 -> scale 2 (clamped); its centre (200, 100) lands on (300, 200).
    expect(scale).toBe(2);
    expect(200 * scale + tx).toBe(300);
    expect(100 * scale + ty).toBe(200);
  });

  it("uses the tighter axis when the height is what limits the scale", () => {
    expect(fitTransform([{ x: 0, y: 0 }, { x: 100, y: 900 }], 500, 500).scale).toBe(500 / 948);
  });

  it("notices when only one of several nodes moved", () => {
    const saved = { pc1: { x: 0, y: 0 }, pc2: { x: 50, y: 50 } };

    expect(matchesSavedLayout({ pc1: { x: 0, y: 0 }, pc2: { x: 90, y: 50 } }, saved)).toBe(false);
    expect(matchesSavedLayout({ pc1: { x: 0, y: 0 }, pc3: { x: 50, y: 50 } }, saved)).toBe(false);
  });

  it("reads two-digit interfaces, repeated whitespace and the short `ip add` form", () => {
    const startup = [
      "ip  address   add 10.0.10.1/24   dev  eth10",
      "ip -4  addr add 10.0.0.1/24 dev eth0",
      "ip add add 10.0.1.1/24 dev eth1",
      "ip addr add    10.0.2.1/24 dev eth2",
    ].join("\n");

    expect(parseIfaceIps(machine(), startup)).toEqual({
      10: ["10.0.10.1/24"], 0: ["10.0.0.1/24"], 1: ["10.0.1.1/24"], 2: ["10.0.2.1/24"],
    });
  });

  it("lists an IP once even when the startup log echoes its command", () => {
    const log = ["++ ip address add 10.0.0.1/24 dev eth0", "ip address add 10.0.0.1/24 dev eth0"].join("\n");

    expect(parseIfaceIps(machine(), log)).toEqual({ 0: ["10.0.0.1/24"] });
  });
});

describe("nodeExtent", () => {
  it("sizes a device by its label, badges included, up to the width cap", () => {
    expect(nodeExtent({ type: "dev", name: "pc1" })).toEqual({ hw: 112 / 2 + 6, hh: 23 });
    expect(nodeExtent({ type: "dev", name: "router_core_1" })).toEqual({ hw: (13 * 9 + 58) / 2 + 6, hh: 23 });
    expect(nodeExtent({ type: "dev", name: "x".repeat(40) })).toEqual({ hw: MAX_DEVICE_NODE_WIDTH / 2 + 6, hh: 23 });
  });

  it("sizes a domain by its circle, or its label where that is wider", () => {
    expect(nodeExtent({ type: "cd", name: "A" })).toEqual({ hw: 18, hh: 18 });
    expect(nodeExtent({ type: "cd", name: "backbone_lan" }).hw).toBeCloseTo(12 * 3.8, 9);
  });

  it("uses the same width the rect is drawn with", () => {
    expect(nodeExtent({ type: "dev", name: "pc10" }).hw).toBe(deviceNodeWidth("pc10") / 2 + 6);
  });
});

describe("overlayInsets", () => {
  const canvas = { left: 0, top: 0, right: 900, bottom: 460 };

  it("reserves a strip along the top for a wide toolbar there", () => {
    expect(overlayInsets(canvas, [{ left: 300, top: 8, right: 892, bottom: 42 }])).toEqual({
      top: 42 + 8,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it("reserves a strip along the side for a tall legend in a corner", () => {
    // 110 wide of 900 (12%) costs less than 120 high of 460 (26%).
    expect(overlayInsets(canvas, [{ left: 8, top: 332, right: 118, bottom: 452 }])).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 118 + 8,
    });
  });

  it("keeps the largest strip per edge and ignores hidden overlays", () => {
    const insets = overlayInsets(canvas, [
      { left: 500, top: 418, right: 892, bottom: 452 },
      { left: 600, top: 400, right: 892, bottom: 452 },
      { left: 0, top: 0, right: 0, bottom: 0 },
    ]);
    expect(insets).toEqual({ top: 0, right: 0, bottom: 460 - 400 + 8, left: 0 });
  });

  it("measures from the canvas's own position, not the page's", () => {
    const shifted = { left: 100, top: 50, right: 1000, bottom: 510 };
    expect(overlayInsets(shifted, [{ left: 400, top: 58, right: 992, bottom: 92 }]).top).toBe(42 + 8);
  });
});

describe("sameIdSet", () => {
  it("ignores order and duplicates", () => {
    expect(sameIdSet(["dev:pc1", "cd:A"], ["cd:A", "dev:pc1", "cd:A"])).toBe(true);
  });

  it("tells a device added or removed apart", () => {
    expect(sameIdSet(["dev:pc1"], ["dev:pc1", "dev:pc2"])).toBe(false);
    expect(sameIdSet(["dev:pc1", "dev:pc2"], ["dev:pc1", "dev:pc3"])).toBe(false);
  });
});

describe("edgeLabelBox", () => {
  const edge = { label: "eth0", ips: ["10.0.0.1/24"], mac: "02:00:00:00:00:01" };

  it("grows downwards only with the lines on show", () => {
    expect(edgeLabelBox(edge, { ips: false, macs: false }).bottom).toBe(2);
    expect(edgeLabelBox(edge, { ips: true, macs: false }).bottom).toBe(17);
    expect(edgeLabelBox(edge, { ips: true, macs: true }).bottom).toBe(32);
  });

  it("is as wide as its widest line on show, centred on the anchor", () => {
    const nameOnly = edgeLabelBox(edge, { ips: false, macs: false });
    expect(nameOnly.right).toBeCloseTo((4 * 7.2) / 2 + 2, 9);
    expect(nameOnly.left).toBe(-nameOnly.right);
    expect(edgeLabelBox(edge, { ips: false, macs: true }).right).toBeCloseTo((17 * 6.6) / 2 + 2, 9);
  });

  it("does not count a line the interface has nothing for", () => {
    expect(edgeLabelBox({ label: "eth1", ips: [], mac: null }, { ips: true, macs: true }).bottom).toBe(2);
  });
});

describe("labelClearance", () => {
  const box = { left: -20, right: 20, top: -14, bottom: 2 };

  it("clears a node sideways by its half-width, the gap and the label's own half-width", () => {
    expect(labelClearance(1, 0, 100, 23, box)).toBe(100 + 4 + 20);
    expect(labelClearance(-1, 0, 100, 23, box)).toBe(100 + 4 + 20);
  });

  it("uses the label's own height above or below the anchor going up or down", () => {
    expect(labelClearance(0, 1, 100, 23, box)).toBe(23 + 4 + 14); // the label's top faces the node
    expect(labelClearance(0, -1, 100, 23, box)).toBe(23 + 4 + 2); // its bottom does
  });

  it("clears on whichever axis comes first along a diagonal", () => {
    const u = Math.SQRT1_2;
    // Sideways needs (100+4+20)/u ≈ 175; vertically (23+4+14)/u ≈ 58 — the label is clear above.
    expect(labelClearance(u, u, 100, 23, box)).toBeCloseTo((23 + 4 + 14) / u, 9);
  });
});

describe("edgeLabelPlacement", () => {
  const box = { left: -16, right: 16, top: -14, bottom: 2 };
  const small = { hw: 62, hh: 23 };
  const wide = { hw: 136, hh: 23 };
  const domain = { hw: 18, hh: 18 };

  it("keeps the label 38% of the way along when that already clears both ends", () => {
    const { x, y } = edgeLabelPlacement({ x: 0, y: 0 }, small, { x: 400, y: 0 }, domain, box);
    expect([x, y]).toEqual([152, 0]);
  });

  it("pushes the label past a wide device rather than onto it", () => {
    const { x } = edgeLabelPlacement({ x: 0, y: 0 }, wide, { x: 400, y: 0 }, domain, box);
    expect(x).toBe(136 + 4 + 16); // 38% would be 152: the label's left half would still be on the rect
  });

  it("says how long the edge must be for the label to clear both ends", () => {
    const { need } = edgeLabelPlacement({ x: 0, y: 0 }, wide, { x: 100, y: 0 }, domain, box);
    expect(need).toBe(136 + 4 + 16 + (18 + 4 + 16));
  });

  it("splits the difference when the edge is too short for that", () => {
    const { x } = edgeLabelPlacement({ x: 0, y: 0 }, wide, { x: 100, y: 0 }, domain, box);
    // Clear of the device from 156, of the domain up to 100 - 38 = 62: halfway between.
    expect(x).toBe((156 + 62) / 2);
  });

  it("leaves a label on a zero-length edge at its device", () => {
    expect(edgeLabelPlacement({ x: 5, y: 5 }, small, { x: 5, y: 5 }, domain, box)).toEqual({ x: 5, y: 5, need: 0 });
  });
});
