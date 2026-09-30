import { describe, expect, it } from "vitest";
import { labDetail, machine } from "../test/fixtures";
import { HOST_BRIDGE } from "./constants";
import {
  canonicalIpv6,
  compareIfaceIps,
  computeTopology,
  deviceIpMismatches,
  deviceNodeWidth,
  EDGE_LABEL_LINE_Y,
  EDGE_WARN_GAP,
  EDGE_WARN_R,
  edgeLabelBox,
  edgeLabelLineY,
  edgeNameHalfWidth,
  edgeLabelPlacement,
  type DeviceNode,
  type DomainNode,
  fitTransform,
  ifaceKey,
  ipMismatches,
  labelClearance,
  matchesSavedLayout,
  MAX_DEVICE_NODE_WIDTH,
  MAX_IMAGE_CHARS,
  netmaskPrefix,
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
  return labDetail({ name: "l", id: "h", machines, links });
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
        [{ name: "A", machines: ["r1"], external: [], running: true, draft: false, network_plugin: null }],
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
      { source: "dev:r1", target: "cd:A", device: "r1", num: 0, label: "eth0", mac: "02:42:ac:11:00:02", ips: ["10.0.0.1/24"] },
      { source: "dev:r1", target: "cd:B", device: "r1", num: 1, label: "eth1", mac: null, ips: ["10.0.1.1/24"] },
    ]);
    expect(model.nodes.map((n) => n.id)).toEqual(["dev:r1", "cd:A", "cd:B"]);
  });

  it("leaves Kathara's host bridge out of nodes and edges", () => {
    const model = computeTopology(
      lab(
        [machine({ interfaces: [iface(0, "A"), iface(1, HOST_BRIDGE)] })],
        [{ name: HOST_BRIDGE, machines: ["pc1"], external: [], running: true, draft: false, network_plugin: null }],
      ),
    );

    expect(model.nodes.map((n) => n.id)).toEqual(["dev:pc1", "cd:A"]);
    expect(model.edges.map((e) => [e.target, e.ips])).toEqual([["cd:A", []]]);  // no address known yet
  });

  it("keeps a listed domain's own running flag and external interfaces", () => {
    const model = computeTopology(
      lab(
        [machine({ running: true, interfaces: [iface(0, "A")] })],
        [{ name: "A", machines: ["pc1"], external: ["eth0"], running: false, draft: false, network_plugin: null }],
      ),
    );

    expect(model.nodes.find((n) => n.id === "cd:A")).toMatchObject({ running: false, external: ["eth0"], members: ["pc1"] });
  });

  it("carries a listed domain's network plugin, and none for a domain only an interface names", () => {
    const model = computeTopology(
      lab(
        [machine({ interfaces: [iface(0, "A"), iface(1, "B")] })],
        [{ name: "A", machines: ["pc1"], external: [], running: true, draft: false, network_plugin: "kathara/katharanp_vde" }],
      ),
    );

    expect(model.nodes.find((n) => n.id === "cd:A")).toMatchObject({ networkPlugin: "kathara/katharanp_vde" });
    expect(model.nodes.find((n) => n.id === "cd:B")).toMatchObject({ networkPlugin: null });
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
    const model = computeTopology(lab([], [{ name: "EMPTY", machines: [], external: [], running: false, draft: true, network_plugin: null }]));

    expect(model.nodes).toEqual([
      {
        id: "cd:EMPTY",
        type: "cd",
        name: "EMPTY",
        external: [],
        running: false,
        draft: true,
        networkPlugin: null,
        members: [],
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
      },
    ]);
    expect(model.edges).toEqual([]);
  });

  it("never shows a domain with a device on it as a draft, nor one only an interface names", () => {
    const pc1 = machine({ name: "pc1", interfaces: [{ num: 0, link: "A", mac_address: null }, { num: 1, link: "B", mac_address: null }] });
    const model = computeTopology(lab([pc1], [{ name: "A", machines: [], external: [], running: false, draft: true, network_plugin: null }]));

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

  it("accepts any abbreviation of `address` and `add`", () => {
    const startup = ["ip a add 10.0.0.1/24 dev eth0", "ip addr a 10.0.1.1/24 dev eth1"].join("\n");

    expect(parseIfaceIps(machine(), startup)).toEqual({ 0: ["10.0.0.1/24"], 1: ["10.0.1.1/24"] });
  });

  it("finds the address around extra keywords, and with `dev` written before it", () => {
    const startup = [
      "ip addr add 10.0.0.1/24 brd + dev eth0",
      "ip addr add 10.0.1.1/24 broadcast 10.0.1.255 scope global label eth1:0 dev eth1",
      "ip addr add dev eth2 10.0.2.1/24",
      "ip addr add local 10.0.3.1/24 dev eth3",
    ].join("\n");

    expect(parseIfaceIps(machine(), startup)).toEqual({
      0: ["10.0.0.1/24"], 1: ["10.0.1.1/24"], 2: ["10.0.2.1/24"], 3: ["10.0.3.1/24"],
    });
  });

  it("reads each command of a chained line, after a `sudo` or a path to the binary", () => {
    const startup = "sudo ip addr add 10.0.0.1/24 dev eth0 && /sbin/ip -6 addr add 2001:db8::1/64 dev eth0; ip link set eth0 up";

    expect(parseIfaceIps(machine(), startup)).toEqual({ 0: ["10.0.0.1/24", "2001:db8::1/64"] });
  });

  it("reads ifconfig, turning a dotted netmask into the prefix length", () => {
    const startup = [
      "ifconfig eth0 10.0.0.1 netmask 255.255.255.0 up",
      "ifconfig eth1 10.0.1.1/30 up",
      "ifconfig eth2 inet6 add 2001:db8::2/64",
      "ifconfig eth3 inet 10.0.3.1",
    ].join("\n");

    expect(parseIfaceIps(machine(), startup)).toEqual({
      0: ["10.0.0.1/24"], 1: ["10.0.1.1/30"], 2: ["2001:db8::2/64"], 3: ["10.0.3.1"],
    });
  });

  it("keeps an ifconfig address bare when its netmask isn't a valid one", () => {
    expect(parseIfaceIps(machine(), "ifconfig eth0 10.0.0.1 netmask 255.0.255.0")).toEqual({ 0: ["10.0.0.1"] });
  });

  it("ignores routes, links, interface state changes and commented-out lines", () => {
    const startup = [
      "ip route add 10.0.0.0/24 via 10.0.1.1 dev eth0",
      "ip -6 route add default via 2001:db8::1 dev eth0",
      "ip link set eth0 up",
      "ifconfig eth0 up",
      "ifconfig eth0 hw ether 00:00:00:00:00:01",
      "# ip addr add 10.0.9.1/24 dev eth0",
      "ip addr add 10.0.8.1/24 dev eth0 # 10.0.7.1/24 dev eth1",
    ].join("\n");

    expect(parseIfaceIps(machine(), startup)).toEqual({ 0: ["10.0.8.1/24"] });
  });

  it("ignores an assignment to anything but an ethN interface", () => {
    expect(parseIfaceIps(machine(), "ip addr add 10.0.0.1/32 dev lo\nifconfig lo 127.0.0.2")).toEqual({});
  });
});

describe("canonicalIpv6", () => {
  it("lowercases, drops leading zeros and writes the longest zero run as ::", () => {
    expect(canonicalIpv6("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(canonicalIpv6("2001:db8:0:0:1:0:0:1")).toBe("2001:db8::1:0:0:1");
    expect(canonicalIpv6("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(canonicalIpv6("::1")).toBe("::1");
    expect(canonicalIpv6("fe80::")).toBe("fe80::");
    expect(canonicalIpv6("::")).toBe("::");
  });

  it("does not shorten a single zero group", () => {
    expect(canonicalIpv6("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1");
  });

  it("leaves what it can't read lowercased as it was", () => {
    expect(canonicalIpv6("::FFFF:10.0.0.1")).toBe("::ffff:10.0.0.1");
    expect(canonicalIpv6("1::2::3")).toBe("1::2::3");
    expect(canonicalIpv6("zz::1")).toBe("zz::1");
  });
});

describe("compareIfaceIps", () => {
  it("finds nothing when the running addresses are the declared ones, however IPv6 is spelled", () => {
    expect(compareIfaceIps({ 0: ["10.0.0.1/24", "2001:DB8:0::1/64"] }, { 0: ["2001:db8::1/64", "10.0.0.1/24"] })).toEqual({});
  });

  it("reports what is missing and what is extra on an interface that changed", () => {
    expect(compareIfaceIps({ 0: ["10.0.0.1/24"], 1: ["10.0.1.1/24"] }, { 0: ["10.9.9.9/24"], 1: ["10.0.1.1/24"] })).toEqual({
      0: { declared: ["10.0.0.1/24"], live: ["10.9.9.9/24"], missing: ["10.0.0.1/24"], extra: ["10.9.9.9/24"] },
    });
  });

  it("counts a different prefix length as a different address", () => {
    expect(compareIfaceIps({ 0: ["10.0.0.1/24"] }, { 0: ["10.0.0.1/16"] })[0]).toMatchObject({
      missing: ["10.0.0.1/24"], extra: ["10.0.0.1/16"],
    });
  });

  it("matches a declared address with no prefix against any prefix", () => {
    expect(compareIfaceIps({ 0: ["10.0.0.1"] }, { 0: ["10.0.0.1/8"] })).toEqual({});
  });

  it("reports an interface with no address left as all missing", () => {
    expect(compareIfaceIps({ 0: ["10.0.0.1/24"] }, {})[0]).toMatchObject({ missing: ["10.0.0.1/24"], extra: [] });
  });

  it("compares only interfaces the startup declares an address for", () => {
    expect(compareIfaceIps({ 0: [] }, { 0: ["10.0.0.1/24"], 1: ["10.0.1.1/24"] })).toEqual({});
  });
});

describe("ipMismatches", () => {
  const edges = [
    { device: "pc1", num: 0, ips: ["10.0.0.1/24"] },
    { device: "pc2", num: 0, ips: ["10.0.0.2/24"] },
  ];

  it("keys each differing interface by device and interface, with JSON's string keys read as numbers", () => {
    expect(ipMismatches(edges, { pc1: { "0": ["10.0.0.5/24"] }, pc2: { "0": ["10.0.0.2/24"] } })).toEqual({
      [ifaceKey("pc1", 0)]: { declared: ["10.0.0.1/24"], live: ["10.0.0.5/24"], missing: ["10.0.0.1/24"], extra: ["10.0.0.5/24"] },
    });
  });

  it("does not compare a device the backend left out (stopped, or still booting)", () => {
    expect(ipMismatches(edges, { pc2: { "0": ["10.0.0.2/24"] } })).toEqual({});
  });
});

describe("deviceIpMismatches", () => {
  it("picks one device's mismatches out, by interface number", () => {
    const m = { declared: ["10.0.0.1/24"], live: [], missing: ["10.0.0.1/24"], extra: [] };
    const edges = [{ device: "pc1", num: 0 }, { device: "pc1", num: 1 }, { device: "pc10", num: 0 }];
    const all = { [ifaceKey("pc1", 1)]: m, [ifaceKey("pc10", 0)]: m };

    expect(deviceIpMismatches(edges, all, "pc1")).toEqual({ 1: m });
    expect(deviceIpMismatches(edges, all, "pc2")).toEqual({});
  });
});

describe("netmaskPrefix", () => {
  it("counts the leading one bits of a contiguous dotted mask", () => {
    expect(netmaskPrefix("255.255.255.0")).toBe(24);
    expect(netmaskPrefix("255.255.255.252")).toBe(30);
    expect(netmaskPrefix("255.255.255.255")).toBe(32);
    expect(netmaskPrefix("0.0.0.0")).toBe(0);
  });

  it("rejects a mask with a hole, a byte out of range, or the wrong shape", () => {
    expect(netmaskPrefix("255.0.255.0")).toBeNull();
    expect(netmaskPrefix("255.255.256.0")).toBeNull();
    expect(netmaskPrefix("255.255.255")).toBeNull();
    expect(netmaskPrefix("0xffffff00")).toBeNull();
  });
});

describe("nodeExtent", () => {
  const dev = (name: string, image: string | null = null) => ({ type: "dev" as const, name, image });

  it("sizes a device by its label, badges included, up to the width cap", () => {
    expect(nodeExtent(dev("pc1"))).toEqual({ hw: 112 / 2 + 6, hh: 23 });
    expect(nodeExtent(dev("router_core_1"))).toEqual({ hw: (13 * 9 + 58) / 2 + 6, hh: 23 });
    expect(nodeExtent(dev("x".repeat(40)))).toEqual({ hw: MAX_DEVICE_NODE_WIDTH / 2 + 6, hh: 23 });
  });

  it("widens a device for an image that would not fit with its margins", () => {
    expect(deviceNodeWidth(dev("pc1", "kathara/base"))).toBe(12 * 7 + 28 + 2 * 10);
    expect(deviceNodeWidth(dev("pc1", "debian"))).toBe(112);
    expect(deviceNodeWidth(dev("router_core_1", "kathara/frr"))).toBe(13 * 9 + 58);
    expect(deviceNodeWidth(dev("pc1", "kathara/openbgpd"))).toBe(16 * 7 + 28 + 2 * 10);
  });

  it("stops widening a device for its image at MAX_IMAGE_CHARS, leaving the rest to truncation", () => {
    const capped = MAX_IMAGE_CHARS * 7 + 28 + 2 * 10;
    expect(deviceNodeWidth(dev("pc1", `registry.example.com/${"x".repeat(60)}`))).toBe(capped);
    expect(deviceNodeWidth(dev("pc1", "x".repeat(MAX_IMAGE_CHARS + 1)))).toBe(capped);
    expect(deviceNodeWidth(dev("x".repeat(40), "x".repeat(60)))).toBe(MAX_DEVICE_NODE_WIDTH);
  });

  it("sizes a domain by its circle, or its label where that is wider", () => {
    expect(nodeExtent({ type: "cd", name: "A" })).toEqual({ hw: 18, hh: 18 });
    expect(nodeExtent({ type: "cd", name: "backbone_lan" }).hw).toBeCloseTo(12 * 3.8, 9);
  });

  it("scales both half-sizes with the Display size, for devices and domains alike", () => {
    expect(nodeExtent(dev("pc1"), 1.5)).toEqual({ hw: (112 / 2 + 6) * 1.5, hh: 23 * 1.5 });
    expect(nodeExtent({ type: "cd", name: "A" }, 0.8)).toEqual({ hw: 18 * 0.8, hh: 18 * 0.8 });
  });

  it("uses the same width the rect is drawn with", () => {
    expect(nodeExtent(dev("pc10", "kathara/base")).hw).toBe(deviceNodeWidth(dev("pc10", "kathara/base")) / 2 + 6);
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

  it("makes room for the warning after the interface name, on both sides of the anchor", () => {
    const show = { ips: false, macs: false };
    const withWarn = edgeLabelBox(edge, show, 1, true);

    expect(withWarn.right).toBeCloseTo(edgeNameHalfWidth("eth0") + EDGE_WARN_GAP + EDGE_WARN_R + 2, 9);
    expect(withWarn.left).toBe(-withWarn.right);
    expect(edgeLabelBox(edge, show, 2, true).right).toBeCloseTo(withWarn.right * 2, 9);
  });

  it("scales every side with the text size", () => {
    const show = { ips: true, macs: true };
    const base = edgeLabelBox(edge, show);
    const big = edgeLabelBox(edge, show, 1.5);

    expect(big.left).toBeCloseTo(base.left * 1.5, 9);
    expect(big.right).toBeCloseTo(base.right * 1.5, 9);
    expect(big.top).toBeCloseTo(base.top * 1.5, 9);
    expect(big.bottom).toBeCloseTo(base.bottom * 1.5, 9);
  });
});

describe("edgeLabelLineY", () => {
  it("spaces the label lines out with the text size, and is EDGE_LABEL_LINE_Y at 1x", () => {
    expect(edgeLabelLineY(1)).toEqual(EDGE_LABEL_LINE_Y);
    expect(edgeLabelLineY(2)).toEqual({ name: -6, ip: 24, mac: 54 });
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
