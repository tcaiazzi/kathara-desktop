// The HTML of a topology node's hover tooltip. It is assigned to `innerHTML` (see
// useForceLayout), and every value in it comes from the lab: device and domain names, images,
// interface IPs and MACs, all of which a third-party lab.conf controls. So every such value passes
// through `esc` here, and a caller must not interpolate lab data into this markup any other way.

import { deviceStateLabel, formatIface, formatPort, type TopoNode } from "./topology";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function ttRow(k: string, v: string): string {
  return `<div class="tt-row"><span class="tt-k">${esc(k)}</span><span class="tt-v">${esc(v)}</span></div>`;
}

// Full-detail HTML shown on node hover (device: image/state/interfaces+IPs/ports; domain: members).
export function tooltipHtml(nd: TopoNode): string {
  if (nd.type === "dev") {
    const rows: string[] = [
      `<div class="tt-title">${esc(nd.name)}<span class="tt-tag">${esc(nd.typeLabel)}${nd.bridged ? " · bridged" : ""}</span></div>`,
      ttRow("image", nd.image || "—"),
      ttRow("state", deviceStateLabel(nd)),
    ];
    if (nd.ifaces.length) {
      rows.push('<div class="tt-sec">interfaces</div>');
      for (const it of nd.ifaces) {
        const ips = it.ips.length ? it.ips.join(", ") : "—";
        rows.push(`<div class="tt-if"><span class="tt-mono">${formatIface(it.num, esc(it.link))}</span><span class="tt-mono tt-ip">${esc(ips)}</span></div>`);
        if (it.mac) rows.push(`<div class="tt-mac tt-mono">${esc(it.mac)}</div>`);
      }
    }
    if (nd.ports.length) {
      const ports = nd.ports.map(formatPort).join(", ");
      rows.push('<div class="tt-sec">ports</div>');
      rows.push(`<div class="tt-mono">${esc(ports)}</div>`);
    }
    return rows.join("");
  }
  const rows: string[] = [
    `<div class="tt-title">${esc(nd.name)}<span class="tt-tag">${nd.external.length ? "external" : "collision domain"}</span></div>`,
    ttRow("devices", nd.members.join(", ") || "—"),
  ];
  if (nd.external.length) rows.push(ttRow("host", nd.external.join(", ")));
  return rows.join("");
}
