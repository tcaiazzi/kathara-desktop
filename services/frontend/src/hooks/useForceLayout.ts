import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { CATEGORY_ICON } from "../services/deviceIcon";
import { deviceStateLabel, formatIface, formatPort, type TopoEdge, type TopoModel, type TopoNode } from "../services/topology";

const SVGNS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | null | undefined> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVGNS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
}

export type NodePositions = Record<string, { x: number; y: number }>;

interface Engine {
  canvas: HTMLDivElement;
  svg: SVGSVGElement;
  viewport: SVGGElement;
  tooltip: HTMLDivElement;
  W: number;
  H: number;
  k: number;
  temp: number;
  nodes: TopoNode[];
  edges: TopoEdge[];
  byId: Record<string, TopoNode>;
  adj: Record<string, Set<string>>;
  tx: number;
  ty: number;
  scale: number;
  raf: number | null;
  dragging: TopoNode | null;
  selected: string | null;
  selectNode: (id: string | null) => void;
  applySelectionVisuals: (id: string | null) => void;
  moved: boolean;
  edgeEls: SVGLineElement[];
  edgeLabelEls: SVGTextElement[];
  edgeIpEls: SVGTextElement[];
  nodeEls: Record<string, SVGGElement>;
  ro: ResizeObserver | null;
  autoFit: boolean;
  settledOnce: boolean;
}

export interface UseForceLayoutCallbacks {
  onSelect: (id: string | null) => void;
  onDismissContextMenu: () => void;
  onNodeContextMenu: (node: TopoNode, clientX: number, clientY: number) => void;
  onPaneContextMenu: (clientX: number, clientY: number) => void;
  onNodeDoubleClick: (node: TopoNode) => void;
}

export interface UseForceLayoutOptions {
  // Seed positions per node id — a lab's fixed layout (its `lab.layout` file) overlaid with the
  // local draft in localStorage. Seeded nodes are pinned (see the rebuild effect); when every node
  // has one, the simulation starts cold so the graph doesn't reshuffle on reload.
  initialPositions?: NodePositions;
  // Called (settle + drag-end) with the current node positions, for the caller to persist.
  onPositionsChange?: (positions: NodePositions) => void;
  // Currently-selected node id (if any), so a rebuild can restore it instead of unconditionally
  // clearing the selection when the selected node still exists in the new model.
  selectedId?: string | null;
}

export interface UseForceLayout {
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  fit: () => void;
  // Imperatively set the selected node (e.g. from an external list). No-op if unchanged.
  select: (id: string | null) => void;
  // Zoom about the canvas center by a factor (>1 in, <1 out).
  zoom: (factor: number) => void;
  // Pan a node to the canvas center at the current scale (used by the search box).
  centerOn: (id: string) => void;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function ttRow(k: string, v: string): string {
  return `<div class="tt-row"><span class="tt-k">${esc(k)}</span><span class="tt-v">${esc(v)}</span></div>`;
}

// Full-detail HTML shown on node hover (device: image/state/interfaces+IPs/ports; domain: members).
function tooltipHtml(nd: TopoNode): string {
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

function applyTransform(engine: Engine): void {
  engine.viewport.setAttribute("transform", `translate(${engine.tx},${engine.ty}) scale(${engine.scale})`);
}

// Fit all nodes into view (scale + center). Shared by the returned fit() and the auto-fit-on-settle.
function fitEngine(engine: Engine): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const nd of engine.nodes) {
    minX = Math.min(minX, nd.x);
    minY = Math.min(minY, nd.y);
    maxX = Math.max(maxX, nd.x);
    maxY = Math.max(maxY, nd.y);
  }
  const pad = 50;
  const bw = maxX - minX + pad * 2;
  const bh = maxY - minY + pad * 2;
  engine.scale = Math.max(0.3, Math.min(2, Math.min(engine.W / bw, engine.H / bh)));
  engine.tx = (engine.W - (minX + maxX) * engine.scale) / 2;
  engine.ty = (engine.H - (minY + maxY) * engine.scale) / 2;
  applyTransform(engine);
}

// Imperative force-directed SVG topology engine (device + collision-domain nodes, edges =
// interfaces), no charting library. The simulation/render loop manipulates SVG DOM attributes
// directly every animation frame rather than going through React state: dozens of position
// updates per second per node is not a good fit for React re-renders. This hook owns the whole
// engine (physics, drag/pan/zoom, node DOM); the caller supplies callbacks for the low-frequency
// events that need component-level context (building context-menu items, opening modals) rather
// than the hook owning that state itself.
export function useForceLayout(
  model: TopoModel,
  relayoutNonce: number,
  callbacks: UseForceLayoutCallbacks,
  options: UseForceLayoutOptions = {},
): UseForceLayout {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  // Last `relayoutNonce` this effect actually rebuilt for, so it can tell "the caller asked for a
  // fresh layout" (Re-layout / the fixed layout arriving / Remove layout — relayoutNonce bumped)
  // apart from "only `model` changed" (any other data refresh — a deploy, a connect, a stats poll
  // touching `detail`, the startups fetch resolving after it). Only the former should reset pan/
  // zoom to "fit all"; the latter should leave the camera exactly where the user left it.
  const lastNonceRef = useRef(relayoutNonce);
  // The outgoing engine's camera, captured by *this effect's own cleanup* (below) rather than read
  // from `engineRef.current` at the top of a later run — React always runs an effect's cleanup
  // before its next invocation, so `engineRef.current` is already null by the time a later run
  // would try to read it there. `engine.tx/ty/scale` are read at cleanup time, not closure-capture
  // time, so this also picks up any live pan/zoom/drag that happened after the engine was built,
  // not just its state at construction.
  const lastCameraRef = useRef<{ tx: number; ty: number; scale: number } | null>(null);

  // Always-current callbacks/options for the DOM event listeners below, without forcing the whole
  // rebuild effect to re-run (and the simulation to restart) on every render.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model.nodes.length) return;

    const isExplicitRelayout = lastNonceRef.current !== relayoutNonce;
    lastNonceRef.current = relayoutNonce;
    // Restored below (instead of resetting to the default 0,0,1 + auto-fit) when this rebuild is
    // just a data refresh rather than an explicit relayout request.
    const prevCamera = !isExplicitRelayout ? lastCameraRef.current : null;

    canvas.replaceChildren();
    callbacksRef.current.onDismissContextMenu();

    const W = Math.max(canvas.clientWidth || 800, 320);
    const H = Math.max(canvas.clientHeight || 460, 300);
    const n = model.nodes.length;
    // Ideal (spring rest) distance between connected nodes, also the repulsion scale between every
    // pair — kept modest (vs. the previous 160 cap) so an auto-laid-out graph stays compact: just
    // enough room to read a node's label, not spread to fill whatever canvas/panel size is available.
    const k = Math.min(140, Math.max(66, 0.44 * Math.sqrt((W * H) / n)));

    // Seed positions: restore saved ones where available, else lay out on a jittered circle. A
    // restored node is *pinned* (`fixed`): the physics never moves it, so adding one device can no
    // longer nudge an arranged topology — the newcomer settles around the frozen graph instead.
    const saved = optionsRef.current.initialPositions || {};
    let savedCount = 0;
    const byId: Record<string, TopoNode> = {};
    model.nodes.forEach((nd, i) => {
      const p = saved[nd.id];
      nd.fixed = false;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        nd.x = p.x;
        nd.y = p.y;
        nd.fixed = true;
        savedCount++;
      } else {
        const a = (i / n) * Math.PI * 2;
        const jitter = ((i * 41) % 13) / 13;
        const r = Math.min(W, H) * (0.22 + 0.16 * jitter);
        nd.x = W / 2 + Math.cos(a) * r;
        nd.y = H / 2 + Math.sin(a) * r;
      }
      nd.dx = 0;
      nd.dy = 0;
      byId[nd.id] = nd;
    });
    const allSaved = savedCount === n;
    // Cold start when the whole layout was restored (nothing left to move); otherwise a full settle
    // — only the unpinned newcomers actually move, so there is no need to hold the heat back.
    const temp = allSaved ? 0 : Math.max(W, H) * 0.11;

    const adj: Record<string, Set<string>> = {};
    for (const nd of model.nodes) adj[nd.id] = new Set();
    for (const e of model.edges) {
      adj[e.source].add(e.target);
      adj[e.target].add(e.source);
    }

    const svgNode = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    const viewport = svgEl("g");
    // A faint dot grid, drawn first (so everything else paints over it) and living *inside*
    // `viewport` — it inherits the same pan/zoom transform as nodes/edges (applyTransform below),
    // so it reads as a genuine spatial reference while panning/zooming, not a static wallpaper.
    // Sized well beyond the visible canvas so it doesn't run out under any reasonable pan.
    const defs = svgEl("defs");
    const gridPattern = svgEl("pattern", {
      id: "kt-topo-grid",
      patternUnits: "userSpaceOnUse",
      width: 22,
      height: 22,
    });
    gridPattern.append(svgEl("circle", { cx: 1, cy: 1, r: 1, fill: "var(--kt-topo-grid-dot)" }));
    defs.append(gridPattern);
    const gridRect = svgEl("rect", {
      x: -2000,
      y: -2000,
      width: 4000,
      height: 4000,
      fill: "url(#kt-topo-grid)",
      "pointer-events": "none",
    });
    const edgesG = svgEl("g");
    const nodesG = svgEl("g");
    // Edge labels live in their own group drawn AFTER the nodes so a node never covers an interface
    // name (labels also get a background halo in CSS for contrast over lines/nodes).
    const labelsG = svgEl("g");
    viewport.append(defs, gridRect, edgesG, nodesG, labelsG);
    svgNode.append(viewport);
    canvas.append(svgNode);

    const tooltip = document.createElement("div");
    tooltip.className = "kt-topo-tooltip";
    tooltip.style.display = "none";
    canvas.append(tooltip);

    const engine: Engine = {
      canvas,
      svg: svgNode,
      viewport,
      tooltip,
      W,
      H,
      k,
      temp,
      nodes: model.nodes,
      edges: model.edges,
      byId,
      adj,
      tx: prevCamera?.tx ?? 0,
      ty: prevCamera?.ty ?? 0,
      scale: prevCamera?.scale ?? 1,
      raf: null,
      dragging: null,
      selected: null,
      selectNode: () => {},
      applySelectionVisuals: () => {},
      moved: false,
      edgeEls: [],
      edgeLabelEls: [],
      edgeIpEls: [],
      nodeEls: {},
      ro: null,
      // Fit once on settle for a genuinely fresh/relaid-out graph: a layout restored from
      // `lab.layout` may have been arranged on a differently-sized canvas, and fitEngine only
      // pans/zooms (stored coordinates are untouched). Skipped when this rebuild only carried a
      // data refresh forward (prevCamera set) — the user's own pan/zoom already applies and must
      // not be overridden by a fit the caller never asked for.
      autoFit: prevCamera === null,
      settledOnce: false,
    };
    engineRef.current = engine;

    for (const e of model.edges) {
      const line = svgEl("line", { class: "kt-topo-edge" });
      const lbl = svgEl("text", { class: "kt-topo-edge-label", "text-anchor": "middle" }, e.label);
      const ipLbl = svgEl("text", { class: "kt-topo-edge-ip", "text-anchor": "middle" }, e.ips.join(", "));
      edgesG.append(line);
      labelsG.append(lbl, ipLbl);
      engine.edgeEls.push(line);
      engine.edgeLabelEls.push(lbl);
      engine.edgeIpEls.push(ipLbl);
    }

    function savePositions() {
      const cb = optionsRef.current.onPositionsChange;
      if (!cb) return;
      const map: NodePositions = {};
      for (const nd of engine.nodes) map[nd.id] = { x: Math.round(nd.x), y: Math.round(nd.y) };
      cb(map);
    }

    function showTooltip(nd: TopoNode, clientX: number, clientY: number) {
      const r = engine.canvas.getBoundingClientRect();
      engine.tooltip.innerHTML = tooltipHtml(nd);
      engine.tooltip.style.display = "block";
      const tw = engine.tooltip.offsetWidth;
      const th = engine.tooltip.offsetHeight;
      let x = clientX - r.left + 14;
      let y = clientY - r.top + 14;
      if (x + tw > r.width) x = r.width - tw - 6;
      if (y + th > r.height) y = r.height - th - 6;
      engine.tooltip.style.left = `${Math.max(4, x)}px`;
      engine.tooltip.style.top = `${Math.max(4, y)}px`;
    }
    function hideTooltip() {
      engine.tooltip.style.display = "none";
    }

    function hoverTopo(id: string | null) {
      engine.edges.forEach((e, i) => {
        const on = id != null && (e.source === id || e.target === id);
        engine.edgeEls[i].classList.toggle("hi", on);
        engine.edgeLabelEls[i].classList.toggle("hi", on);
        engine.edgeIpEls[i].classList.toggle("hi", on);
      });
    }

    // Visual side of selecting a node — no callback. Used both by genuine clicks (via selectNode
    // below) and by paths that must NOT notify the caller: restoring the previous selection after a
    // model rebuild (nothing actually changed), and the externally-driven sync in `select()` below
    // (the caller is the one who set this selection — telling it back would be an echo).
    function applySelectionVisuals(id: string | null) {
      engine.selected = id;
      const keep = new Set<string>();
      if (id != null) {
        keep.add(id);
        for (const nb of engine.adj[id]) keep.add(nb);
      }
      for (const nd of engine.nodes) {
        const g = engine.nodeEls[nd.id];
        g.classList.toggle("selected", nd.id === id);
        g.classList.toggle("dim", id != null && !keep.has(nd.id));
      }
      engine.edges.forEach((e, i) => {
        const on = id != null && (e.source === id || e.target === id);
        const dim = id != null && !on;
        engine.edgeEls[i].classList.toggle("hi", on);
        engine.edgeEls[i].classList.toggle("dim", dim);
        engine.edgeLabelEls[i].classList.toggle("hi", on);
        engine.edgeLabelEls[i].classList.toggle("dim", dim);
        engine.edgeIpEls[i].classList.toggle("hi", on);
        engine.edgeIpEls[i].classList.toggle("dim", dim);
      });
    }
    engine.applySelectionVisuals = applySelectionVisuals;

    // Genuine selection event — a click/right-click on a node or the pane, inside this graph.
    function selectNode(id: string | null) {
      applySelectionVisuals(id);
      callbacksRef.current.onSelect(id);
    }
    engine.selectNode = selectNode;

    function clientToSim(clientX: number, clientY: number) {
      const r = engine.svg.getBoundingClientRect();
      const vx = ((clientX - r.left) / r.width) * engine.W;
      const vy = ((clientY - r.top) / r.height) * engine.H;
      return { x: (vx - engine.tx) / engine.scale, y: (vy - engine.ty) / engine.scale };
    }

    function ensureLoop() {
      if (engine.raf) return;
      const step = () => {
        if (engineRef.current !== engine) return;
        tick();
        tick();
        render();
        if (engine.temp > 1.2 || engine.dragging) {
          engine.raf = requestAnimationFrame(step);
        } else {
          engine.raf = null;
          // Settled: fit-to-view once for a fresh (unsaved) graph, and persist the resting layout.
          if (!engine.settledOnce) {
            engine.settledOnce = true;
            if (engine.autoFit) fitEngine(engine);
          }
          savePositions();
        }
      };
      engine.raf = requestAnimationFrame(step);
    }

    function tick() {
      const { nodes, edges, byId: ids, adj, k: kk, W: w, H: h } = engine;
      for (const nd of nodes) {
        nd.dx = 0;
        nd.dy = 0;
      }
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = i - j || 1;
            dy = i + 1;
            d2 = dx * dx + dy * dy;
          }
          const d = Math.sqrt(d2);
          const f = (kk * kk) / d;
          const ux = dx / d;
          const uy = dy / d;
          a.dx += ux * f;
          a.dy += uy * f;
          b.dx -= ux * f;
          b.dy -= uy * f;
        }
      }
      for (const e of edges) {
        const a = ids[e.source];
        const b = ids[e.target];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / kk;
        const ux = dx / d;
        const uy = dy / d;
        a.dx -= ux * f;
        a.dy -= uy * f;
        b.dx += ux * f;
        b.dy += uy * f;
      }
      for (const nd of nodes) {
        // Stronger than before (was 0.06) — a lightly-connected node (e.g. a single edge into a
        // domain everything else avoids) needs more than the spring force alone to keep it pulled in
        // near the rest of the graph instead of drifting out to whatever the repulsion sum allows.
        // An edge-less node (no interfaces at all) has no spring pulling it in whatsoever — only
        // repulsion from every other node pushing it away — so it needs a markedly stronger pull or
        // it drifts out on its own, forcing fit-to-view to zoom out to include it.
        const pull = adj[nd.id].size === 0 ? 0.32 : 0.09;
        nd.dx += (w / 2 - nd.x) * pull;
        nd.dy += (h / 2 - nd.y) * pull;
      }
      for (const nd of nodes) {
        if (nd === engine.dragging || nd.fixed) continue;
        const d = Math.hypot(nd.dx, nd.dy) || 0.01;
        const lim = Math.min(d, engine.temp);
        nd.x += (nd.dx / d) * lim;
        nd.y += (nd.dy / d) * lim;
        nd.x = Math.max(40, Math.min(w - 40, nd.x));
        nd.y = Math.max(36, Math.min(h - 36, nd.y));
      }
      engine.temp *= 0.96;
    }

    function render() {
      applyTransform(engine);
      engine.edges.forEach((e, i) => {
        const a = engine.byId[e.source];
        const b = engine.byId[e.target];
        const line = engine.edgeEls[i];
        line.setAttribute("x1", String(a.x));
        line.setAttribute("y1", String(a.y));
        line.setAttribute("x2", String(b.x));
        line.setAttribute("y2", String(b.y));
        const mx = a.x + (b.x - a.x) * 0.38;
        const my = a.y + (b.y - a.y) * 0.38;
        const lbl = engine.edgeLabelEls[i];
        lbl.setAttribute("x", String(mx));
        lbl.setAttribute("y", String(my - 3));
        const ip = engine.edgeIpEls[i];
        ip.setAttribute("x", String(mx));
        ip.setAttribute("y", String(my + 12));
      });
      for (const nd of engine.nodes) engine.nodeEls[nd.id].setAttribute("transform", `translate(${nd.x},${nd.y})`);
    }

    function onNodePointerDown(ev: PointerEvent, nd: TopoNode) {
      // Right-click (button 2) is handled entirely by the contextmenu listener below. This must
      // return early for it — otherwise the same right-click's pointerup would treat the
      // contextmenu handler's selectNode(nd.id) as a completed non-drag click and immediately
      // toggle the selection back off.
      if (ev.button !== 0) return;
      ev.stopPropagation();
      hideTooltip();
      engine.dragging = nd;
      engine.moved = false;
      engine.svg.classList.add("dragging");
      const move = (e: PointerEvent) => {
        const p = clientToSim(e.clientX, e.clientY);
        if (Math.abs(p.x - nd.x) > 2 || Math.abs(p.y - nd.y) > 2) engine.moved = true;
        nd.x = p.x;
        nd.y = p.y;
        nd.dx = 0;
        nd.dy = 0;
        engine.temp = Math.max(engine.temp, 14);
        ensureLoop();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        engine.svg.classList.remove("dragging");
        engine.dragging = null;
        if (!engine.moved) selectNode(engine.selected === nd.id ? null : nd.id);
        else {
          nd.fixed = true; // a hand-placed node stays where it was dropped
          savePositions();
        }
        ensureLoop();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    function onBgPointerDown(ev: PointerEvent) {
      // Right-click is handled entirely by the contextmenu listener below (see onNodePointerDown's
      // matching guard for why: otherwise this pointerdown's pan setup would fire alongside it).
      if (ev.button !== 0) return;
      callbacksRef.current.onDismissContextMenu();
      hideTooltip();
      selectNode(null);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const tx0 = engine.tx;
      const ty0 = engine.ty;
      const r = engine.svg.getBoundingClientRect();
      const move = (e: PointerEvent) => {
        engine.tx = tx0 + ((e.clientX - startX) / r.width) * engine.W;
        engine.ty = ty0 + ((e.clientY - startY) / r.height) * engine.H;
        render();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    function badge(cx: number, cy: number, cls: string, txt: string): SVGGElement {
      const g = svgEl("g", { class: `n-badge ${cls}`, transform: `translate(${cx},${cy})` });
      g.append(svgEl("circle", { r: 9 }));
      g.append(svgEl("text", { "text-anchor": "middle", y: 3 }, txt));
      return g;
    }

    // Cap how wide a node can grow from its label, and truncate whatever no longer fits (full name/
    // image are still one hover away via the tooltip) — otherwise a long device name or a long
    // registry image path grows the rect unboundedly and crowds/overlaps its neighbors.
    const MAX_NODE_W = 260;
    function truncate(s: string, maxChars: number): string {
      if (maxChars < 1) return "";
      if (s.length <= maxChars) return s;
      return maxChars === 1 ? "…" : s.slice(0, maxChars - 1) + "…";
    }

    for (const nd of model.nodes) {
      let g: SVGGElement;
      if (nd.type === "dev") {
        const cls =
          `kt-topo-node n-dev n-${nd.category}` +
          (nd.running ? " running" : "") +
          (nd.bridged ? " bridged" : "") +
          (nd.ports.length ? " has-ports" : "");
        g = svgEl("g", { class: cls });
        const w = Math.min(MAX_NODE_W, Math.max(112, nd.name.length * 9 + 58));
        g.append(svgEl("rect", { x: -w / 2, y: -21, width: w, height: 42, rx: 8 }));
        // Leading per-image type icon (SVG line-art, drawn at 16×16 then scaled up a bit to match
        // the bigger node), then the name + image sublabel.
        const icon = svgEl("g", { class: "n-icon", transform: `translate(${-w / 2 + 10},-9) scale(1.15)` });
        for (const [tag, attrs] of CATEGORY_ICON[nd.category]) icon.append(svgEl(tag, attrs));
        g.append(icon);
        // Char-width estimates match the monospace label/sub-label font sizes (14px / 11px).
        const name = truncate(nd.name, Math.max(1, Math.floor((w - 58) / 9)));
        g.append(svgEl("text", { class: "n-label", "text-anchor": "middle", x: 14, y: nd.image ? -2 : 6 }, name));
        if (nd.image) {
          const image = truncate(nd.image, Math.max(1, Math.floor((w - 28) / 7)));
          g.append(svgEl("text", { class: "n-sub", "text-anchor": "middle", x: 14, y: 13 }, image));
        }
        if (nd.bridged) g.append(badge(w / 2 - 3, -14, "b-bridged", "B"));
        if (nd.ports.length) g.append(badge(w / 2 - 3, 14, "b-ports", String(nd.ports.length)));
        // Small filled state dot (top-left, the one free corner) — redundant with the rect's
        // running/stopped border-stroke color, not a color-only distinction.
        g.append(badge(-w / 2 + 3, -14, `b-state${nd.running ? "" : " stopped"}`, ""));
      } else {
        g = svgEl("g", { class: `kt-topo-node n-cd${nd.external.length ? " external" : ""}` });
        g.append(svgEl("circle", { r: 18 }));
        g.append(svgEl("text", { class: "n-label", "text-anchor": "middle", y: 5 }, nd.name));
      }
      g.addEventListener("pointerdown", (ev) => onNodePointerDown(ev, nd));
      g.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        callbacksRef.current.onNodeDoubleClick(nd);
      });
      g.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideTooltip();
        selectNode(nd.id);
        callbacksRef.current.onNodeContextMenu(nd, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
      });
      g.addEventListener("mouseenter", (ev) => {
        if (!engine.selected) hoverTopo(nd.id);
        showTooltip(nd, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
      });
      g.addEventListener("mousemove", (ev) => {
        if (!engine.dragging) showTooltip(nd, (ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
      });
      g.addEventListener("mouseleave", () => {
        if (!engine.selected) hoverTopo(null);
        hideTooltip();
      });
      nodesG.append(g);
      engine.nodeEls[nd.id] = g;
    }

    // Restore the caller's selection if the previously-selected node survived the rebuild, instead
    // of leaving it cleared (see the dropped onSelect(null) above). Visuals only — nothing actually
    // changed from the caller's point of view, so this must not re-notify onSelect.
    const keepSelected = optionsRef.current.selectedId;
    applySelectionVisuals(keepSelected != null && byId[keepSelected] ? keepSelected : null);

    svgNode.addEventListener("pointerdown", onBgPointerDown as EventListener);
    svgNode.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      hideTooltip();
      selectNode(null);
      callbacksRef.current.onPaneContextMenu((ev as MouseEvent).clientX, (ev as MouseEvent).clientY);
    });
    svgNode.addEventListener(
      "wheel",
      (ev: WheelEvent) => {
        ev.preventDefault();
        const r = engine.svg.getBoundingClientRect();
        const vx = ((ev.clientX - r.left) / r.width) * engine.W;
        const vy = ((ev.clientY - r.top) / r.height) * engine.H;
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const ns = Math.max(0.3, Math.min(3, engine.scale * factor));
        engine.tx = vx - (vx - engine.tx) * (ns / engine.scale);
        engine.ty = vy - (vy - engine.ty) * (ns / engine.scale);
        engine.scale = ns;
        render();
      },
      { passive: false },
    );

    if (window.ResizeObserver) {
      engine.ro = new ResizeObserver(() => {
        const nw = Math.max(canvas.clientWidth || W, 320);
        if (Math.abs(nw - engine.W) > 4) {
          engine.W = nw;
          svgNode.setAttribute("viewBox", `0 0 ${engine.W} ${engine.H}`);
          svgNode.setAttribute("width", String(engine.W));
          engine.temp = Math.max(engine.temp, 8);
          ensureLoop();
        }
      });
      engine.ro.observe(canvas);
    }

    render();
    if (allSaved) {
      // Nothing to settle — reflect (and, unless a data-refresh rebuild is preserving the user's
      // own camera, fit) the restored layout immediately.
      engine.settledOnce = true;
      if (engine.autoFit) fitEngine(engine);
    }
    ensureLoop();

    return () => {
      if (engine.raf) cancelAnimationFrame(engine.raf);
      if (engine.ro) engine.ro.disconnect();
      lastCameraRef.current = { tx: engine.tx, ty: engine.ty, scale: engine.scale };
      engineRef.current = null;
      canvas.replaceChildren();
    };
  }, [model, relayoutNonce]);

  const fit = useCallback(() => {
    const engine = engineRef.current;
    if (engine) fitEngine(engine);
  }, []);

  // Stable so callers can use it as an effect dependency without re-running every render. Visuals
  // only (not `selectNode`) — the caller is who set this selection, so echoing it back via
  // `onSelect` would be a feedback loop (and, since callers may react to a selection by e.g.
  // bringing a panel into focus, a very visible one).
  const select = useCallback((id: string | null) => {
    const engine = engineRef.current;
    if (!engine || id === engine.selected) return;
    engine.applySelectionVisuals(id);
  }, []);

  const zoom = useCallback((factor: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const cx = engine.W / 2;
    const cy = engine.H / 2;
    const ns = Math.max(0.3, Math.min(3, engine.scale * factor));
    engine.tx = cx - (cx - engine.tx) * (ns / engine.scale);
    engine.ty = cy - (cy - engine.ty) * (ns / engine.scale);
    engine.scale = ns;
    applyTransform(engine);
  }, []);

  const centerOn = useCallback((id: string) => {
    const engine = engineRef.current;
    const nd = engine?.byId[id];
    if (!engine || !nd) return;
    engine.tx = engine.W / 2 - nd.x * engine.scale;
    engine.ty = engine.H / 2 - nd.y * engine.scale;
    applyTransform(engine);
  }, []);

  return { canvasRef, fit, select, zoom, centerOn };
}
