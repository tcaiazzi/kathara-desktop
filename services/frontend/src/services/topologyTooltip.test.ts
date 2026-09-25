import { describe, expect, it } from "vitest";
import type { DeviceNode, DomainNode } from "./topology";
import { tooltipHtml } from "./topologyTooltip";

function device(overrides: Partial<DeviceNode> = {}): DeviceNode {
  return {
    id: "dev:pc1",
    type: "dev",
    name: "pc1",
    image: "kathara/base",
    running: false,
    status: null,
    category: "host",
    typeLabel: "Host",
    bridged: false,
    ports: [],
    ifaces: [],
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    ...overrides,
  };
}

function domain(overrides: Partial<DomainNode> = {}): DomainNode {
  return {
    id: "cd:A",
    type: "cd",
    name: "A",
    external: [],
    running: false,
    members: ["pc1", "pc2"],
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    ...overrides,
  };
}

// Visible text of the tooltip, in document order, the way a reader sees it.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const ATTACK = `<img src=x onerror="alert(1)">&`;
const ESCAPED = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;";

describe("device tooltip", () => {
  it("shows name, type, image and state", () => {
    expect(text(tooltipHtml(device({ running: true, status: "running" })))).toBe(
      "pc1 Host image kathara/base state running",
    );
    expect(text(tooltipHtml(device({ image: null })))).toBe("pc1 Host image — state stopped");
  });

  it("tags a bridged device", () => {
    expect(tooltipHtml(device({ bridged: true }))).toContain("Host · bridged");
  });

  it("lists interfaces with their IPs and MACs, and the published ports", () => {
    const html = tooltipHtml(
      device({
        ifaces: [
          { num: 0, link: "A", mac: "02:42:ac:11:00:02", ips: ["10.0.0.1/24", "2001:db8::1/64"] },
          { num: 1, link: "B", mac: null, ips: [] },
        ],
        ports: [
          { host_port: 8080, guest_port: 80, protocol: "tcp" },
          { host_port: 5353, guest_port: 53, protocol: "udp" },
        ],
      }),
    );

    expect(text(html)).toBe(
      "pc1 Host image kathara/base state stopped interfaces " +
        "eth0 → A 10.0.0.1/24, 2001:db8::1/64 02:42:ac:11:00:02 eth1 → B — " +
        "ports 8080→80/tcp, 5353→53/udp",
    );
  });

  it("leaves out the interfaces and ports sections when there are none", () => {
    const html = tooltipHtml(device());

    expect(html).not.toContain("interfaces");
    expect(html).not.toContain("ports");
  });
});

describe("collision-domain tooltip", () => {
  it("lists the attached devices", () => {
    expect(text(tooltipHtml(domain()))).toBe("A collision domain devices pc1, pc2");
    expect(text(tooltipHtml(domain({ members: [] })))).toBe("A collision domain devices —");
  });

  it("marks an external domain and names its host interfaces", () => {
    expect(text(tooltipHtml(domain({ external: ["eth0", "eth1.20"] })))).toBe(
      "A external devices pc1, pc2 host eth0, eth1.20",
    );
  });
});

describe("escaping", () => {
  it("escapes every lab-controlled value of a device", () => {
    const html = tooltipHtml(
      device({
        name: ATTACK,
        typeLabel: ATTACK,
        image: ATTACK,
        status: ATTACK,
        running: true,
        ifaces: [{ num: 0, link: ATTACK, mac: ATTACK, ips: [ATTACK] }],
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain('"alert');
    // name, type label, image, state, link, IPs, MAC: each rendered once, escaped. (A port's
    // protocol is not free text: the API only ever sends tcp/udp/sctp.)
    expect(html.split(ESCAPED).length - 1).toBe(7);
  });

  it("escapes every lab-controlled value of a collision domain", () => {
    const html = tooltipHtml(domain({ name: ATTACK, members: [ATTACK], external: [ATTACK] }));

    expect(html).not.toContain("<img");
    expect(html.split(ESCAPED).length - 1).toBe(3);
  });
});
