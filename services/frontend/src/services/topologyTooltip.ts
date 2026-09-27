// The HTML of a topology node's hover tooltip. It is assigned to `innerHTML` (see
// useForceLayout), and every value in it comes from the lab: device and domain names, images,
// interface IPs and MACs, all of which a third-party lab.conf controls. So every such value passes
// through `esc` here, and a caller must not interpolate lab data into this markup any other way.

import { deviceStateLabel, formatIface, formatPort, type IfaceIpMismatch, type TopoNode } from "./topology";

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
    `<div class="tt-title">${esc(nd.name)}<span class="tt-tag">${
      nd.external.length ? "external" : nd.draft ? "draft" : "collision domain"
    }</span></div>`,
    ttRow("devices", nd.members.join(", ") || "—"),
  ];
  if (nd.draft) rows.push('<div class="tt-sub">Not saved in lab.conf until a device is connected.</div>');
  if (nd.external.length) rows.push(ttRow("host", nd.external.join(", ")));
  return rows.join("");
}

/** Why a running address can differ from the startup's, shown wherever the difference is. */
export const IP_MISMATCH_HINT =
  "Changed after boot (for example from a terminal), or a startup command failed: see the startup log.";

// Shown on hover of the warning beside an interface label whose running addresses differ from the
// ones its startup declares (topology.ts's ipMismatches).
export function ipMismatchTooltipHtml(device: string, label: string, m: IfaceIpMismatch): string {
  return [
    `<div class="tt-title">${esc(device)} ${esc(label)}<span class="tt-tag">address differs</span></div>`,
    ttRow("startup", m.declared.join(", ")),
    ttRow("running", m.live.join(", ") || "none"),
    `<div class="tt-sub">${esc(IP_MISMATCH_HINT)}</div>`,
  ].join("");
}
