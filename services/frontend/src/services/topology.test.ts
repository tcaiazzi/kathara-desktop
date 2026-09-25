import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { HOST_BRIDGE } from "./constants";
import { computeTopology, type DeviceNode, type DomainNode, fitTransform, parseIfaceIps, samePositions } from "./topology";
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

describe("samePositions", () => {
  it("compares coordinates as integers, so sub-pixel drift is not a change", () => {
    expect(samePositions({ pc1: { x: 10.2, y: 20.4 } }, { pc1: { x: 9.6, y: 19.5 } })).toBe(true);
    expect(samePositions({ pc1: { x: 10, y: 20 } }, { pc1: { x: 11, y: 20 } })).toBe(false);
  });

  it("differs when the two maps place different nodes", () => {
    expect(samePositions({ pc1: { x: 0, y: 0 } }, { pc2: { x: 0, y: 0 } })).toBe(false);
    expect(samePositions({ pc1: { x: 0, y: 0 } }, { pc1: { x: 0, y: 0 }, pc2: { x: 5, y: 5 } })).toBe(false);
  });

  it("never matches a missing saved layout", () => {
    expect(samePositions({}, null)).toBe(false);
  });
});

describe("fitTransform", () => {
  it("centres the nodes' bounding box in the canvas", () => {
    const { scale, tx, ty } = fitTransform([{ x: 0, y: 0 }, { x: 200, y: 100 }], 600, 400);

    // Box 200x100 plus a 50px margin each side = 300x200, which fits 600x400 at 2x.
    expect(scale).toBe(2);
    // The box's centre (100, 50) lands on the canvas centre (300, 200).
    expect(100 * scale + tx).toBe(300);
    expect(50 * scale + ty).toBe(200);
  });

  it("scales down to the tighter of the two axes", () => {
    const { scale } = fitTransform([{ x: 0, y: 0 }, { x: 900, y: 100 }], 500, 500);

    expect(scale).toBe(0.5); // (900 + 100) wide into 500
  });

  it("keeps the scale within [0.3, 2]", () => {
    expect(fitTransform([{ x: 0, y: 0 }, { x: 10000, y: 0 }], 800, 600).scale).toBe(0.3);
    expect(fitTransform([{ x: 5, y: 5 }], 2000, 2000).scale).toBe(2);
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
    n_machines: machines.length,
    n_links: links.length,
    deployed: false,
    metadata: { description: null, version: null, author: null, email: null, web: null },
    machines,
    links,
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
        [{ name: "A", machines: ["r1"], external: [], running: true }],
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
        [{ name: HOST_BRIDGE, machines: ["pc1"], external: [], running: true }],
      ),
    );

    expect(model.nodes.map((n) => n.id)).toEqual(["dev:pc1", "cd:A"]);
    expect(model.edges.map((e) => [e.target, e.ips])).toEqual([["cd:A", []]]);  // no address known yet
  });

  it("keeps a listed domain's own running flag and external interfaces", () => {
    const model = computeTopology(
      lab(
        [machine({ running: true, interfaces: [iface(0, "A")] })],
        [{ name: "A", machines: ["pc1"], external: ["eth0"], running: false }],
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

  it("shows a listed domain with no device attached", () => {
    const model = computeTopology(lab([], [{ name: "EMPTY", machines: [], external: [], running: false }]));

    expect(model.nodes).toEqual([
      { id: "cd:EMPTY", type: "cd", name: "EMPTY", external: [], running: false, members: [], x: 0, y: 0, dx: 0, dy: 0 },
    ]);
    expect(model.edges).toEqual([]);
  });
});

describe("topology helpers, edge cases", () => {
  it("fits nodes whose bounding box does not start at the origin", () => {
    const { scale, tx, ty } = fitTransform([{ x: 100, y: 50 }, { x: 300, y: 150 }], 600, 400);

    // Box 200x100 + margins = 300x200 -> scale 2; its centre (200, 100) lands on (300, 200).
    expect(scale).toBe(2);
    expect(200 * scale + tx).toBe(300);
    expect(100 * scale + ty).toBe(200);
  });

  it("uses the tighter axis when the height is what limits the scale", () => {
    expect(fitTransform([{ x: 0, y: 0 }, { x: 100, y: 900 }], 500, 500).scale).toBe(0.5);
  });

  it("notices when only one of several nodes moved", () => {
    const saved = { pc1: { x: 0, y: 0 }, pc2: { x: 50, y: 50 } };

    expect(samePositions({ pc1: { x: 0, y: 0 }, pc2: { x: 90, y: 50 } }, saved)).toBe(false);
    expect(samePositions({ pc1: { x: 0, y: 0 }, pc3: { x: 50, y: 50 } }, saved)).toBe(false);
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
