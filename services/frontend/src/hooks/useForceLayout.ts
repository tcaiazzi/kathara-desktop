// Imperative force-directed SVG topology engine (device + collision-domain nodes, edges =
// interfaces), no charting library. The simulation/render loop manipulates SVG DOM attributes
// directly every animation frame rather than going through React state: dozens of position
// updates per second per node is not a good fit for React re-renders. This hook owns the whole
// engine (physics, drag/pan/zoom, node DOM); the caller supplies callbacks for the low-frequency
// events that need component-level context (building context-menu items, opening modals) rather
// than the hook owning that state itself.
//
// Everything above the hook is module-level on purpose — the SVG element builder and the viewport
// transform have no React state to hold, so they stay out of the hook body and out of every
// re-render. The tooltip markup lives in services/topologyTooltip.ts, where it is unit-tested.

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { CATEGORY_ICON } from "../services/deviceIcon";
import {
  deviceNodeWidth,
  EDGE_LABEL_LINE_Y,
  edgeLabelBox,
  edgeLabelPlacement,
  fitTransform,
  nodeExtent,
  overlayInsets,
  planSeeds,
  sameIdSet,
  ZERO_INSETS,
  type FitInsets,
  type LabelBox,
  type NodePositions,
  type SeedPosition,
  type TopoEdge,
  type TopoModel,
  type TopoNode,
} from "../services/topology";
import { tooltipHtml } from "../services/topologyTooltip";

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
  edgeMacEls: SVGTextElement[];
  nodeEls: Record<string, SVGGElement>;
  // Each node's half-size (nodeExtent) and each edge's label box (edgeLabelBox, by edge index):
  // where a label can sit without covering either end, and how long its edge has to be for that.
  extents: Record<string, { hw: number; hh: number }>;
  labelBoxes: LabelBox[];
  // Re-measures the label boxes (the IP/MAC lines were shown or hidden) and redraws.
  refreshLabels: () => void;
  ro: ResizeObserver | null;
  autoFit: boolean;
  settledOnce: boolean;
  // Set once the user places the view themselves (wheel, pan, the zoom buttons, the search box's
  // centring) and cleared by Fit: until then the view follows the graph and the canvas — a resize
  // or a device added refits it — and afterwards it stays where the user put it.
  userCamera: boolean;
}

interface UseForceLayoutCallbacks {
  onSelect: (id: string | null) => void;
  onDismissContextMenu: () => void;
  onNodeContextMenu: (node: TopoNode, clientX: number, clientY: number) => void;
  onPaneContextMenu: (clientX: number, clientY: number) => void;
  onNodeDoubleClick: (node: TopoNode) => void;
}

interface UseForceLayoutOptions {
  // Seed positions per node id — a lab's fixed layout (its `lab.layout` file) overlaid with the
  // local draft in localStorage. Seeded nodes are pinned (see the rebuild effect); when every node
  // has one, the simulation starts cold so the graph doesn't reshuffle on reload.
  initialPositions?: NodePositions;
  // Called (settle + drag-end) with the current node positions, for the caller to persist.
  onPositionsChange?: (positions: NodePositions) => void;
  // Currently-selected node id (if any), so a rebuild can restore it instead of unconditionally
  // clearing the selection when the selected node still exists in the new model.
  selectedId?: string | null;
  // Identity of the graph being shown (the lab id). A rebuild only inherits the previous engine's
  // positions and camera within the same scope: node ids such as `dev:pc1` repeat across labs.
  scopeKey?: string;
  // Which of an interface label's lines are on show: they decide how much room the label needs,
  // and so where it goes. Its CSS still does the hiding.
  labelLines?: { ips: boolean; macs: boolean };
}

// What a rebuild can inherit from the engine it replaces — see `lastStateRef`.
interface EngineSnapshot {
  scope: string | null;
  camera: { tx: number; ty: number; scale: number };
  positions: Record<string, SeedPosition>;
  settled: boolean;
  autoFit: boolean;
  userCamera: boolean;
}

interface UseForceLayout {
  canvasRef: MutableRefObject<HTMLDivElement | null>;
  fit: () => void;
  // Imperatively set the selected node (e.g. from an external list). No-op if unchanged.
  select: (id: string | null) => void;
  // Zoom about the canvas center by a factor (>1 in, <1 out).
  zoom: (factor: number) => void;
  // Pan a node to the canvas center at the current scale (used by the search box).
  centerOn: (id: string) => void;
}

function applyTransform(engine: Engine): void {
  engine.viewport.setAttribute("transform", `translate(${engine.tx},${engine.ty}) scale(${engine.scale})`);
}

// The canvas space the overlays floating over the graph cover (toolbars, legend, zoom buttons —
// TopologyGraph marks each with `data-topo-overlay`), in SVG user units. Measured at fit time, not
// fixed: the toolbars collapse on a narrow canvas, and the legend's size depends on its content.
function overlayFitInsets(engine: Engine): FitInsets {
  const root = engine.canvas.parentElement;
  if (!root) return ZERO_INSETS;
  const r = engine.canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return ZERO_INSETS;
  const overlays = Array.from(root.querySelectorAll("[data-topo-overlay]"), (el) => el.getBoundingClientRect());
  const px = overlayInsets(r, overlays);
  // The viewBox is W×H drawn over the canvas's client box: client px -> user units.
  const sx = engine.W / r.width;
  const sy = engine.H / r.height;
  return { top: px.top * sy, right: px.right * sx, bottom: px.bottom * sy, left: px.left * sx };
}

// Fit all nodes into view (scale + center), each counted with its size and clear of the overlays.
// Shared by the returned fit(), the auto-fit-on-settle and the refit on resize.
function fitEngine(engine: Engine): void {
  const nodes = engine.nodes.map((nd) => ({ x: nd.x, y: nd.y, ...nodeExtent(nd) }));
  const { scale, tx, ty } = fitTransform(nodes, engine.W, engine.H, overlayFitInsets(engine));
  engine.scale = scale;
  engine.tx = tx;
  engine.ty = ty;
  applyTransform(engine);
}

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
  // The outgoing engine's camera, node positions and settle state, captured by *this effect's own
  // cleanup* (below) rather than read from `engineRef.current` at the top of a later run — React
  // always runs an effect's cleanup before its next invocation, so `engineRef.current` is already
  // null by the time a later run would try to read it there. Everything is read at cleanup time,
  // not closure-capture time, so it includes any pan/zoom/drag and settling since the build.
  const lastStateRef = useRef<EngineSnapshot | null>(null);

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
    const scope = optionsRef.current.scopeKey ?? null;
    // A rebuild that is just a data refresh of the same graph (a startup saved, a device added)
    // carries the previous engine forward: its camera, and each surviving node's live position.
    // An explicit relayout request, or another lab, starts over.
    const prev = lastStateRef.current;
    const carried = !isExplicitRelayout && prev && prev.scope === scope ? prev : null;

    canvas.replaceChildren();
    callbacksRef.current.onDismissContextMenu();

    const W = Math.max(canvas.clientWidth || 800, 320);
    const H = Math.max(canvas.clientHeight || 460, 300);
    const n = model.nodes.length;
    // Ideal (spring rest) distance between connected nodes, also the repulsion scale between every
    // pair — capped deliberately low so an auto-laid-out graph stays compact: just enough room to
    // read a node's label, not spread to fill whatever canvas/panel size is available.
    const k = Math.min(140, Math.max(66, 0.44 * Math.sqrt((W * H) / n)));

    // Seed positions (see planSeeds): the previous engine's live ones, else the saved ones, else a
    // jittered circle. A pinned node (`fixed`) is never moved by the physics, so adding one device
    // cannot nudge an arranged topology — the newcomer settles around the frozen graph instead.
    const seeds = planSeeds(
      model.nodes.map((nd) => nd.id),
      carried,
      optionsRef.current.initialPositions || {},
    );
    let pinnedCount = 0;
    const byId: Record<string, TopoNode> = {};
    model.nodes.forEach((nd, i) => {
      const p = seeds[nd.id];
      nd.fixed = false;
      if (p) {
        nd.x = p.x;
        nd.y = p.y;
        nd.fixed = p.fixed;
        if (p.fixed) pinnedCount++;
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
    const allPinned = pinnedCount === n;
    // Cold start when every node is pinned (nothing left to move); otherwise a full settle — only
    // the unpinned nodes actually move, so there is no need to hold the heat back.
    const temp = allPinned ? 0 : Math.max(W, H) * 0.11;

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
      tx: carried?.camera.tx ?? 0,
      ty: carried?.camera.ty ?? 0,
      scale: carried?.camera.scale ?? 1,
      raf: null,
      dragging: null,
      selected: null,
      selectNode: () => {},
      applySelectionVisuals: () => {},
      moved: false,
      edgeEls: [],
      edgeLabelEls: [],
      edgeIpEls: [],
      edgeMacEls: [],
      nodeEls: {},
      extents: Object.fromEntries(model.nodes.map((nd) => [nd.id, nodeExtent(nd)])),
      labelBoxes: [],
      refreshLabels: () => {},
      ro: null,
      // Fit once on settle for a genuinely fresh/relaid-out graph: a layout restored from
      // `lab.layout` may have been arranged on a differently-sized canvas, and fitEngine only
      // pans/zooms (stored coordinates are untouched). A rebuild that carries the previous engine
      // forward keeps its view, with two exceptions: that engine had not come to rest yet (its own
      // pending first fit is inherited rather than lost), or the set of nodes changed while the
      // user had not placed the view themselves — a device added may land outside it.
      autoFit:
        carried === null ||
        (!carried.settled && carried.autoFit) ||
        (!carried.userCamera && !sameIdSet(Object.keys(carried.positions), model.nodes.map((nd) => nd.id))),
      settledOnce: false,
      userCamera: carried?.userCamera ?? false,
    };
    engineRef.current = engine;

    // Set by this effect's cleanup below. A node/pane drag adds its `move`/`up` listeners
    // straight onto `window` (so the drag tracks the pointer outside the SVG's bounds) and only
    // removes them itself once the drag completes normally via `up()` — if this engine is torn
    // down (e.g. a lab import unmounts the topology) while a drag is in flight, `up()` never
    // fires. Without this guard the leaked closures would keep firing against this stale engine
    // while reading `optionsRef`/`callbacksRef`, which are always kept live and would by then
    // belong to whatever lab is mounted next — cross-contaminating its state with this engine's
    // stale node id/position. `activeDragCleanup` lets the effect cleanup remove any
    // still-attached listeners unconditionally, on top of this flag short-circuiting them.
    let disposed = false;
    let activeDragCleanup: (() => void) | null = null;

    function measureLabels() {
      const lines = optionsRef.current.labelLines ?? { ips: true, macs: false };
      engine.labelBoxes = engine.edges.map((e) => edgeLabelBox(e, lines));
    }
    measureLabels();
    engine.refreshLabels = () => {
      measureLabels();
      render();
    };

    for (const e of model.edges) {
      const line = svgEl("line", { class: "kt-topo-edge" });
      const lbl = svgEl("text", { class: "kt-topo-edge-label", "text-anchor": "middle" }, e.label);
      const ipLbl = svgEl("text", { class: "kt-topo-edge-ip", "text-anchor": "middle" }, e.ips.join(", "));
      const macLbl = svgEl("text", { class: "kt-topo-edge-mac", "text-anchor": "middle" }, e.mac ?? "");
      edgesG.append(line);
      labelsG.append(lbl, ipLbl, macLbl);
      engine.edgeEls.push(line);
      engine.edgeLabelEls.push(lbl);
      engine.edgeIpEls.push(ipLbl);
      engine.edgeMacEls.push(macLbl);
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
        engine.edgeMacEls[i].classList.toggle("hi", on);
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
        engine.edgeMacEls[i].classList.toggle("hi", on);
        engine.edgeMacEls[i].classList.toggle("dim", dim);
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
      edges.forEach((e, i) => {
        const a = ids[e.source];
        const b = ids[e.target];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        // The spring acts on the length beyond what the interface label needs to clear both ends
        // (edgeLabelPlacement's `need`, which grows with a wide device), so an edge rests at its
        // natural length or at that, whichever is longer — never with its label on a node.
        const { need } = edgeLabelPlacement(
          a,
          engine.extents[a.id],
          b,
          engine.extents[b.id],
          engine.labelBoxes[i],
        );
        const slack = Math.max(0, need + 8 - kk);
        const stretch = Math.max(0.01, d - slack);
        const f = (stretch * stretch) / kk;
        const ux = dx / d;
        const uy = dy / d;
        a.dx -= ux * f;
        a.dy -= uy * f;
        b.dx += ux * f;
        b.dy += uy * f;
      });
      for (const nd of nodes) {
        // Strong enough to matter on its own: a lightly-connected node (e.g. a single edge into a
        // domain everything else avoids) needs more than the spring force to stay near the rest of
        // the graph instead of drifting out to whatever the repulsion sum allows.
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
        const { x: mx, y: my } = edgeLabelPlacement(
          a,
          engine.extents[a.id],
          b,
          engine.extents[b.id],
          engine.labelBoxes[i],
        );
        const lbl = engine.edgeLabelEls[i];
        lbl.setAttribute("x", String(mx));
        lbl.setAttribute("y", String(my + EDGE_LABEL_LINE_Y.name));
        const ip = engine.edgeIpEls[i];
        ip.setAttribute("x", String(mx));
        ip.setAttribute("y", String(my + EDGE_LABEL_LINE_Y.ip));
        const mac = engine.edgeMacEls[i];
        mac.setAttribute("x", String(mx));
        mac.setAttribute("y", String(my + EDGE_LABEL_LINE_Y.mac));
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
        if (disposed) return;
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
        activeDragCleanup = null;
        if (disposed) return;
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
      activeDragCleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
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
        if (disposed) return;
        if (e.clientX !== startX || e.clientY !== startY) engine.userCamera = true;
        engine.tx = tx0 + ((e.clientX - startX) / r.width) * engine.W;
        engine.ty = ty0 + ((e.clientY - startY) / r.height) * engine.H;
        render();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        activeDragCleanup = null;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      activeDragCleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
    }

    function badge(cx: number, cy: number, cls: string, txt: string): SVGGElement {
      const g = svgEl("g", { class: `n-badge ${cls}`, transform: `translate(${cx},${cy})` });
      g.append(svgEl("circle", { r: 9 }));
      g.append(svgEl("text", { "text-anchor": "middle", y: 3 }, txt));
      return g;
    }

    // A node grows with its label up to a cap (deviceNodeWidth, services/topology.ts), and whatever no
    // longer fits is truncated (full name/image are still one hover away via the tooltip) —
    // otherwise a long device name or a long registry image path grows the rect unboundedly and
    // crowds/overlaps its neighbors.
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
        const w = deviceNodeWidth(nd.name);
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
        g = svgEl("g", {
          class: `kt-topo-node n-cd${nd.external.length ? " external" : ""}${nd.draft ? " draft" : ""}`,
        });
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
        engine.userCamera = true;
        engine.tx = vx - (vx - engine.tx) * (ns / engine.scale);
        engine.ty = vy - (vy - engine.ty) * (ns / engine.scale);
        engine.scale = ns;
        render();
      },
      { passive: false },
    );

    if (window.ResizeObserver) {
      // Both dimensions: the SVG is drawn W×H over the canvas's client box, so a stale H would
      // stretch the drawing on every height change. The layout itself is left alone — only the
      // view follows the new size, and only while the user has not placed it themselves (a graph
      // built in a hidden panel starts from a fallback size, and fits once the panel is shown).
      engine.ro = new ResizeObserver(() => {
        const nw = Math.max(canvas.clientWidth || engine.W, 320);
        const nh = Math.max(canvas.clientHeight || engine.H, 300);
        if (Math.abs(nw - engine.W) <= 4 && Math.abs(nh - engine.H) <= 4) return;
        engine.W = nw;
        engine.H = nh;
        svgNode.setAttribute("viewBox", `0 0 ${engine.W} ${engine.H}`);
        svgNode.setAttribute("width", String(engine.W));
        svgNode.setAttribute("height", String(engine.H));
        if (!engine.userCamera) fitEngine(engine);
        else applyTransform(engine);
      });
      engine.ro.observe(canvas);
    }

    render();
    if (allPinned) {
      // Nothing to settle — reflect (and, unless a data-refresh rebuild is preserving the user's
      // own camera, fit) the restored layout immediately.
      engine.settledOnce = true;
      if (engine.autoFit) fitEngine(engine);
    }
    ensureLoop();

    return () => {
      disposed = true;
      activeDragCleanup?.();
      activeDragCleanup = null;
      if (engine.raf) cancelAnimationFrame(engine.raf);
      if (engine.ro) engine.ro.disconnect();
      const positions: Record<string, SeedPosition> = {};
      for (const nd of engine.nodes) positions[nd.id] = { x: nd.x, y: nd.y, fixed: !!nd.fixed };
      lastStateRef.current = {
        scope,
        camera: { tx: engine.tx, ty: engine.ty, scale: engine.scale },
        positions,
        settled: engine.settledOnce,
        autoFit: engine.autoFit,
        userCamera: engine.userCamera,
      };
      engineRef.current = null;
      canvas.replaceChildren();
    };
  }, [model, relayoutNonce]);

  // Showing or hiding the IP/MAC lines changes how much room each label needs: re-place them
  // without rebuilding the engine (the layout stays put).
  const showIps = options.labelLines?.ips;
  const showMacs = options.labelLines?.macs;
  useEffect(() => {
    engineRef.current?.refreshLabels();
  }, [showIps, showMacs]);

  const fit = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.userCamera = false;
    fitEngine(engine);
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
    engine.userCamera = true;
    engine.tx = cx - (cx - engine.tx) * (ns / engine.scale);
    engine.ty = cy - (cy - engine.ty) * (ns / engine.scale);
    engine.scale = ns;
    applyTransform(engine);
  }, []);

  const centerOn = useCallback((id: string) => {
    const engine = engineRef.current;
    const nd = engine?.byId[id];
    if (!engine || !nd) return;
    engine.userCamera = true;
    engine.tx = engine.W / 2 - nd.x * engine.scale;
    engine.ty = engine.H / 2 - nd.y * engine.scale;
    applyTransform(engine);
  }, []);

  return { canvasRef, fit, select, zoom, centerOn };
}
