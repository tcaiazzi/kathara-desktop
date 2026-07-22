// Classify a device by its Docker image into a visual category (icon + label), used to draw a
// meaningful icon per device on the topology. Recognizes the official Kathara Docker-Images
// (github.com/KatharaFramework/Docker-Images) plus a few common third-party images, and falls back
// to a generic "device" icon for anything unknown.
//
// Classification is purely image-based: in Kathara `net.ipv4.ip_forward` (and the IPv6 equivalent)
// is enabled on every device by default, so it carries no signal about the device's role.

import type { MachineDetail } from "./types";

export type DeviceCategory =
  | "host"
  | "router"
  | "switch"
  | "controller"
  | "server"
  | "dns"
  | "security"
  | "analyzer"
  | "device";

export interface DeviceType {
  category: DeviceCategory;
  label: string;
}

// Exact image-basename → category/label (the Kathara Docker-Images set).
const EXACT: Record<string, DeviceType> = {
  base: { category: "host", label: "host" },
  core: { category: "host", label: "host" },
  frr: { category: "router", label: "FRR router" },
  quagga: { category: "router", label: "Quagga router" },
  quagga_deprecated: { category: "router", label: "Quagga router" },
  bird: { category: "router", label: "BIRD router" },
  bird2: { category: "router", label: "BIRD router" },
  bird3: { category: "router", label: "BIRD router" },
  openbgpd: { category: "router", label: "OpenBGPD router" },
  scion: { category: "router", label: "SCION router" },
  "rift-python": { category: "router", label: "RIFT router" },
  openvswitch: { category: "switch", label: "Open vSwitch" },
  sdn: { category: "switch", label: "SDN switch" },
  bmv2: { category: "switch", label: "P4 (bmv2) switch" },
  p4: { category: "switch", label: "P4 switch" },
  pox: { category: "controller", label: "POX SDN controller" },
  apache: { category: "server", label: "Apache web server" },
  bind: { category: "dns", label: "BIND DNS" },
  dnsmasq: { category: "dns", label: "dnsmasq DNS/DHCP" },
  krill: { category: "security", label: "Krill RPKI CA" },
  routinator: { category: "security", label: "Routinator RPKI" },
  "rpki-client": { category: "security", label: "rpki-client (RPKI)" },
};

// Substring rules for non-exact / third-party images (first match wins).
const KEYWORDS: [RegExp, DeviceType][] = [
  [/wireshark|tcpdump|tshark/, { category: "analyzer", label: "packet analyzer" }],
  [/frr|quagga|bird|openbgpd|\bbgp\b|ospf|zebra|scion|rift|rout/, { category: "router", label: "router" }],
  [/vswitch|\bovs\b|bmv2|\bp4\b|switch|\bsdn\b/, { category: "switch", label: "switch" }],
  [/controller|\bpox\b|ryu|onos|floodlight/, { category: "controller", label: "SDN controller" }],
  [/dnsmasq|\bbind\b|unbound|\bdns\b/, { category: "dns", label: "DNS" }],
  [/apache|nginx|httpd|\bweb\b|caddy/, { category: "server", label: "web server" }],
  [/rpki|krill|routinator/, { category: "security", label: "RPKI" }],
];

// "lscr.io/linuxserver/wireshark:latest" → "wireshark"; "kathara/frr" → "frr".
function imageBasename(image: string): string {
  const noTag = image.split("@")[0].split(":")[0];
  const parts = noTag.split("/");
  return (parts[parts.length - 1] || "").toLowerCase();
}

// Decide a device's type purely from its Docker image: an exact Kathara image wins, then a keyword
// rule (covers third-party / tagged images), else a generic "device" (unknown image).
export function deviceType(machine: MachineDetail): DeviceType {
  const name = machine.image ? imageBasename(machine.image) : "";
  if (!name) return { category: "device", label: "device" };

  const exact = EXACT[name];
  if (exact) return exact;
  for (const [re, type] of KEYWORDS) if (re.test(name)) return type;

  return { category: "device", label: machine.image ?? "device" };
}

// Inline SVG line-art per category (16×16 user units, stroke = currentColor), as element specs
// (`[tag, attrs]`) so both the imperative canvas engine and the React legend build the same icon via
// the DOM/JSX — no `innerHTML` (which rasterizes unreliably for SVG in some engines).
export type IconSpec = [tag: "rect" | "path" | "circle", attrs: Record<string, string | number>];

export const CATEGORY_ICON: Record<DeviceCategory, IconSpec[]> = {
  host: [
    ["rect", { x: 2.5, y: 3, width: 11, height: 8, rx: 1 }],
    ["path", { d: "M6 14h4M8 11v3" }],
  ],
  router: [
    ["rect", { x: 2, y: 6.5, width: 12, height: 5.5, rx: 1.5 }],
    ["path", { d: "M4.5 9.2h7" }],
    ["path", { d: "M9.6 6.2l2.4-2.4M12 3.8h-2.2M12 3.8v2.2" }],
    ["path", { d: "M6.4 12.3l-2.4 2.4M4 14.7h2.2M4 14.7v-2.2" }],
  ],
  switch: [
    ["rect", { x: 2, y: 4.5, width: 12, height: 5, rx: 1.5 }],
    ["path", { d: "M4.6 9.5v3M7.2 9.5v3M9.8 9.5v3M12.4 9.5v3" }],
  ],
  controller: [
    ["path", { d: "M2.5 5.5h11M2.5 10.5h11" }],
    ["circle", { cx: 6, cy: 5.5, r: 1.7 }],
    ["circle", { cx: 10, cy: 10.5, r: 1.7 }],
  ],
  server: [
    ["rect", { x: 3, y: 2.5, width: 10, height: 4.6, rx: 1 }],
    ["rect", { x: 3, y: 8.9, width: 10, height: 4.6, rx: 1 }],
    ["path", { d: "M5.4 4.8h.01M5.4 11.2h.01" }],
  ],
  dns: [
    ["circle", { cx: 8, cy: 8, r: 5.6 }],
    ["path", { d: "M2.4 8h11.2M8 2.4c3 3 3 8.2 0 11.2M8 2.4c-3 3-3 8.2 0 11.2" }],
  ],
  security: [
    ["path", { d: "M8 2.2l5 1.9v4.1c0 3-2 5.3-5 6.3-3-1-5-3.3-5-6.3V4.1z" }],
    ["path", { d: "M6 8l1.6 1.6L10.2 7" }],
  ],
  analyzer: [
    ["circle", { cx: 6.8, cy: 6.8, r: 3.9 }],
    ["path", { d: "M9.7 9.7l3.8 3.8" }],
  ],
  device: [["rect", { x: 3, y: 3, width: 10, height: 10, rx: 2 }]],
};

export const CATEGORY_LABEL: Record<DeviceCategory, string> = {
  host: "host",
  router: "router",
  switch: "switch",
  controller: "controller",
  server: "server",
  dns: "DNS",
  security: "RPKI / security",
  analyzer: "analyzer",
  device: "device",
};
