import {
  DockviewDefaultTab,
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Loader2, ShieldAlert, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dropdown, DropdownButton, Form } from "react-bootstrap";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DevicesTable } from "../components/DevicesTable";
import { LabExplorer } from "../components/LabExplorer";
import { LinksTable } from "../components/LinksTable";
import { AddDeviceModal } from "../components/AddDeviceModal";
import { MachineOptionsEditor } from "../components/MachineOptionsEditor";
import { NewLabModal } from "../components/NewLabModal";
import { RuntimeFilesystemEditor } from "../components/RuntimeFilesystemEditor";
import { StatsPanel } from "../components/StatsPanel";
import { TerminalPanel } from "../components/TerminalPanel";
import { TopologyActionModal } from "../components/TopologyActionModal";
import { TopologyContextMenu, type ContextMenuState } from "../components/TopologyContextMenu";
import { TopologyGraph } from "../components/TopologyGraph";
import { UploadLabModal } from "../components/UploadLabModal";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { useDesktopCommand } from "../desktop/DesktopCommands";
import { WorkspaceProvider, useWorkspace } from "../context/WorkspaceContext";
import { WorkspaceCoreProvider, useWorkspaceCore } from "../context/WorkspaceCoreContext";
import { useToast } from "../context/ToastContext";
import { useDeviceActions } from "../hooks/useDeviceActions";
import { useKtTheme } from "../hooks/useKtTheme";
import { useLabLifecycleActions } from "../hooks/useLabLifecycleActions";
import { api, ApiError } from "../services/api";
import { visibleLinks } from "../services/constants";
import { saveBlob } from "../services/download";
import type { LabDetail, LabSummary } from "../services/types";
import "./WorkspacePage.css";

// --- Dock panels (each reads live lab data from WorkspaceContext) ---
function TopologyPanel() {
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel-fill">
      <TopologyGraph
        labName={ws.labName}
        detail={ws.detail}
        onEditFiles={ws.openFilesPanel}
        {...ws.deviceActions}
        setContextMenu={ws.setContextMenu}
        selectedId={ws.selectedId}
        onSelectId={ws.setSelectedId}
        nodeInfoHost={ws.nodeInfoHost}
      />
    </div>
  );
}
// The node-info panel is just a mount point: the topology portals its live inspector into this
// element (see TopologyGraph). Registering the host on mount / clearing it on unmount is what lets
// "close the panel" hide the inspector and "drag the panel" move it anywhere in the dock.
function NodeInfoPanel() {
  const ws = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const { setNodeInfoHost } = ws;
  useEffect(() => {
    setNodeInfoHost(ref.current);
    return () => setNodeInfoHost(null);
  }, [setNodeInfoHost]);
  return <div className="kt-nodeinfo-panel" ref={ref} />;
}
function DevicesPanel() {
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel">
      <DevicesTable labName={ws.labName} machines={ws.detail.machines} />
      <LinksTable links={ws.detail.links} />
    </div>
  );
}
function FilesPanel() {
  const ws = useWorkspaceCore();
  return (
    <div className="kt-ws-panel-fill">
      <LabExplorer labName={ws.labName} detail={ws.detail} onStructuralChange={ws.onRefresh} />
    </div>
  );
}
function RuntimeFsPanel() {
  const ws = useWorkspaceCore();
  return (
    <div className="kt-ws-panel-fill">
      <RuntimeFilesystemEditor labName={ws.labName} detail={ws.detail} preferredMachine={ws.runtimeFsPreferredMachine} />
    </div>
  );
}
function StatsPanel_() {
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel">
      <StatsPanel labName={ws.labName} deployed={ws.detail.deployed} />
    </div>
  );
}

// Stable component map for dockview. Terminals are opened on demand as `terminal` panels (one per
// session), so — unlike the fixed panels — there's no single "terminals" entry in the default layout.
const DOCK_COMPONENTS = {
  topology: TopologyPanel,
  "node-info": NodeInfoPanel,
  devices: DevicesPanel,
  files: FilesPanel,
  "runtime-fs": RuntimeFsPanel,
  stats: StatsPanel_,
  terminal: TerminalPanel,
};

// Every panel in this dock is a fixed part of the workspace except the terminals, which are
// opened on demand (one per session) and are the only ones a user should be able to close.
function isFixedPanel(id: string): boolean {
  return !id.startsWith("terminal:");
}

// Tab renderer for every panel: the close button appears only on the panels that are actually
// closable. Wired as dockview's `defaultTabComponent` rather than per-panel, so it also governs a
// layout restored from localStorage — a saved layout replays each panel's own `tabComponent`, so
// a per-panel opt-in could never reach a panel that was already persisted without one (which is
// how "Node info" ended up with a close button while its siblings had none).
function DockTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose={isFixedPanel(props.api.id)} />;
}
// Still registered under the name older saved layouts persisted for the core panels, so restoring
// one resolves to a real component instead of failing.
const DOCK_TAB_COMPONENTS = { fixed: DockTab };

// A collapse/expand toggle rendered in every group's header (right side). Collapsing shrinks the
// group to a header strip; the toggle (and clicking the strip) expands it again. Gives the bottom
// tools panel — and any other group — the same collapse affordance as the sidebar.
function GroupHeaderActions(props: IDockviewHeaderActionsProps) {
  const groupApi = props.api;
  const [collapsed, setCollapsed] = useState(() => groupApi.height <= COLLAPSE_THRESHOLD);
  useEffect(() => {
    const d = groupApi.onDidDimensionsChange((e) => setCollapsed(e.height <= COLLAPSE_THRESHOLD));
    return () => d.dispose();
  }, [groupApi]);
  return (
    <div className="kt-ws-group-actions">
      <button
        className="kt-ws-group-btn"
        title="Maximize panel"
        aria-label="Maximize panel"
        onClick={() => maximizeGroup(props.containerApi, props.group)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      </button>
      <button
        className="kt-ws-group-btn"
        title={collapsed ? "Expand panel" : "Collapse panel"}
        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
        onClick={() => {
          if (collapsed) {
            groupApi.setSize({ height: RESTORE_GROUP_HEIGHT });
          } else {
            // Lower the min-height first — dockview's default group minimum (~100px) would otherwise
            // stop it from shrinking to a header-only strip.
            groupApi.setConstraints({ minimumHeight: COLLAPSED_GROUP_HEIGHT });
            groupApi.setSize({ height: COLLAPSED_GROUP_HEIGHT });
          }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={collapsed ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
        </svg>
      </button>
    </div>
  );
}

// v5: default arrangement flipped — topology is now its own full-height column on the right, with
// the inspector, tool panels and every terminal sharing one tab group on the left. Ignore older
// saved layouts (v4 node info out of the topology, v3 core tabs, v2 closable core tabs, v1 removed
// "terminals" panel) so the new default applies.
const LS_LAYOUT = "kt-ws-layout-v5";
const LS_RAIL = "kt-ws-rail-open";
const LS_RAIL_W = "kt-ws-rail-width";
const LS_LAST_LAB = "kt-ws-last-lab";

// Left explorer (rail) resize bounds.
const RAIL_MIN_W = 180;
const RAIL_MAX_W = 560;
const RAIL_DEFAULT_W = 264;

// The manual per-group "Collapse panel" toggle shrinks a group to (about) its header height;
// clicking it again (or its header strip) restores it to a usable height.
const COLLAPSED_GROUP_HEIGHT = 35;
const RESTORE_GROUP_HEIGHT = 280;
// A group at/under this height is considered collapsed (header strip only).
const COLLAPSE_THRESHOLD = 60;

// Fraction of the total width the topology column gets when it's first split off from the left
// tab group — matches the shipped default screenshot (topology noticeably wider than the tabs).
const TOPOLOGY_WIDTH_FRACTION = 0.62;

// Matches an `openTerminal`-minted panel id (`terminal:<machine>:<n>`) so a restored layout's
// terminals can be told apart from every other panel.
const TERMINAL_ID_RE = /^terminal:(.*):(\d+)$/;

function buildDefaultLayout(api: DockviewApi) {
  // One shared tab group on the left: the inspector plus every tool panel. Node info goes in
  // first so it lands as the left-most tab.
  api.addPanel({ id: "node-info", component: "node-info", title: "Node info" });
  api.addPanel({ id: "devices", component: "devices", title: "Devices", position: { referencePanel: "node-info", direction: "within" } });
  api.addPanel({ id: "files", component: "files", title: "Lab Configuration", position: { referencePanel: "devices", direction: "within" } });
  api.addPanel({ id: "runtime-fs", component: "runtime-fs", title: "Runtime FS", position: { referencePanel: "devices", direction: "within" } });
  api.addPanel({ id: "stats", component: "stats", title: "Stats", position: { referencePanel: "devices", direction: "within" } });
  // Topology: its own full-height column to the right of that shared group.
  api.addPanel({
    id: "topology",
    component: "topology",
    title: "Topology",
    position: { referencePanel: "devices", direction: "right" },
    initialWidth: api.width ? Math.round(api.width * TOPOLOGY_WIDTH_FRACTION) : undefined,
  });
  api.getPanel("devices")?.api.setActive();
}

// Re-open the Node info panel if it was closed (as a tab alongside Devices/Lab Configuration/…).
// No-op if it already exists.
function showNodeInfo(api: DockviewApi) {
  if (api.getPanel("node-info")) {
    api.getPanel("node-info")?.api.setActive();
    return;
  }
  const devices = api.getPanel("devices");
  api.addPanel({
    id: "node-info",
    component: "node-info",
    title: "Node info",
    position: devices ? { referencePanel: "devices", direction: "within" } : undefined,
  });
}

// Move every panel that isn't already in a kept group into `target`, as a background tab —
// rather than shrinking the other groups to strips, this removes them outright (an empty group
// closes itself), so the kept group(s) actually get the full available space instead of sharing
// it with squished-but-still-present neighbors. The moved panels aren't lost: they're just tabs
// in `target` now, and "Layout → Default" (resetLayout) puts everything back in place.
function mergeOthersInto(api: DockviewApi, target: DockviewGroupPanel, keep: Set<DockviewGroupPanel>) {
  for (const g of api.groups.filter((g) => !keep.has(g))) {
    for (const p of [...g.panels]) {
      p.api.moveTo({ group: target, position: "center" });
    }
  }
}

// Maximize a single group in place — used by the per-panel header's "Maximize panel" button.
function maximizeGroup(api: DockviewApi, group: DockviewGroupPanel) {
  mergeOthersInto(api, group, new Set([group]));
}

// --- Preset layouts (reposition existing panels via moveTo — no unmount, so terminal sessions
// survive). All are no-ops when there's nothing to arrange. ---
const terminalPanelsOf = (api: DockviewApi) => api.panels.filter((p) => p.id.startsWith("terminal:"));

// A layout restored from localStorage can bring back terminal ids (`terminal:<machine>:<n>`) from
// a previous session — seed `termCounter` from them so a freshly opened terminal never reuses a
// still-open id. Without this, `termCounter` (a fresh `useRef({})` on every mount) restarts every
// per-machine counter at 1, and dockview throws "panel with id ... already exists" the moment that
// collides with a live restored id.
function seedTermCounterFromPanels(api: DockviewApi, termCounter: Record<string, number>) {
  for (const p of api.panels) {
    const match = TERMINAL_ID_RE.exec(p.id);
    if (!match) continue;
    const [, machine, numStr] = match;
    const num = Number(numStr);
    if (num > (termCounter[machine] ?? 0)) termCounter[machine] = num;
  }
}

// Close any terminal panel whose device no longer exists in this lab (matches the old grid
// behavior). Shared by the effect below (reacts to a later `detail` change) and `onDockReady`
// (handles a lab already loaded by the time a restored layout's terminals first appear).
function pruneOrphanTerminals(api: DockviewApi, machineNames: Set<string>) {
  for (const p of terminalPanelsOf(api)) {
    const machine = (p.params as { machine?: string } | undefined)?.machine;
    if (machine && !machineNames.has(machine)) p.api.close();
  }
}

// Equalize a terminal grid's row/column split ratios: same width for every column within a row,
// same height for every row. An incomplete last row (fewer columns) legitimately ends up wider
// per column — tmux does the same, and it's an acceptable tradeoff.
//
// Sizes are derived from the grid's own current combined bounding box so this only touches space
// the grid already owns. Setting an explicit size makes dockview snapshot the new ratio as that
// split's proportion; a later resize of an ancestor (mergeOthersInto freeing space by removing a
// sibling group) redistributes using that saved proportion, so equal ratios survive the later grow.
function equalizeTerminalGrid(rows: DockviewGroupPanel[][]) {
  const groups = rows.flat();
  if (!groups.length) return;
  const rects = groups.map((g) => g.element.getBoundingClientRect());
  const gridWidth = Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
  const gridHeight = Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top));
  const rowHeight = Math.round(gridHeight / rows.length);
  for (const row of rows) {
    const colWidth = Math.round(gridWidth / row.length);
    for (const g of row) g.api.setSize({ width: colWidth });
    // Height is shared by the whole row (only width is per-group) — one call per row suffices.
    row[0].api.setSize({ height: rowHeight });
  }
}

// All open terminals tiled into a roughly-square grid (tmux-like), each cell the same size.
// Returns the row groupings so callers can re-equalize later (e.g. after freeing more space).
function tileTerminals(api: DockviewApi): DockviewGroupPanel[][] {
  const terms = terminalPanelsOf(api);
  if (!terms.length) return [];
  const cols = Math.ceil(Math.sqrt(terms.length));
  const numRows = Math.ceil(terms.length / cols);

  // Phase 1: stack one seed group per row, top-to-bottom, before any row is split into columns.
  // Splitting rows first — rather than interleaving row and column splits — keeps every row a
  // direct sibling of the others spanning the full grid width. Splitting a new row below a row
  // that's already been divided into columns would nest it under just one of those columns
  // instead, leaving another column spanning the full grid height alongside it.
  const rowSeeds: DockviewGroupPanel[] = [terms[0].api.group];
  for (let r = 1; r < numRows; r++) {
    const seedTerm = terms[r * cols];
    seedTerm.api.moveTo({ group: rowSeeds[r - 1], position: "bottom" as const });
    rowSeeds.push(seedTerm.api.group);
  }

  // Phase 2: within each row's now-fixed full-width slot, split off its remaining columns.
  const rows: DockviewGroupPanel[][] = rowSeeds.map((seed) => [seed]);
  for (let r = 0; r < numRows; r++) {
    const end = Math.min(r * cols + cols, terms.length);
    let prev = rowSeeds[r];
    for (let i = r * cols + 1; i < end; i++) {
      terms[i].api.moveTo({ group: prev, position: "right" as const });
      prev = terms[i].api.group;
      rows[r].push(prev);
    }
  }

  equalizeTerminalGrid(rows);
  return rows;
}

// Default: one shared tab group on the left with the inspector, every tool panel, and every open
// terminal; the topology full-height on the right. Without unmounting anything.
function resetLayout(api: DockviewApi) {
  const devices = api.getPanel("devices");
  const topo = api.getPanel("topology");
  if (!devices || !topo) return;
  // Reset shouldn't leave the inspector hidden — bring it back if it was closed.
  if (!api.getPanel("node-info")) showNodeInfo(api);
  for (const id of ["node-info", "files", "runtime-fs", "stats"]) {
    api.getPanel(id)?.api.moveTo({ group: devices.api.group });
  }
  for (const p of terminalPanelsOf(api)) p.api.moveTo({ group: devices.api.group });
  topo.api.moveTo({ group: devices.api.group, position: "right" as const });
  // Undo any collapse pinning left by the manual per-group "Collapse panel" toggle, on every
  // group (not just tools) — any of them can end up shrunk depending on what ran last.
  for (const g of api.groups) {
    g.api.setConstraints({ minimumHeight: 100, minimumWidth: 100 });
  }
  topo.api.group.api.setSize({ width: Math.round(api.width * TOPOLOGY_WIDTH_FRACTION) });
  devices.api.setActive();
}

// Topology takes the whole screen; every tool panel and the node-info inspector join it as
// background tabs.
function focusTopology(api: DockviewApi) {
  const topo = api.getPanel("topology");
  if (!topo) return;
  mergeOthersInto(api, topo.api.group, new Set([topo.api.group]));
  topo.api.setActive();
}

// The Files panel takes the whole screen (writing lab.conf/startup scripts); topology, its
// inspector, and any open terminals join it as background tabs.
function focusEditing(api: DockviewApi) {
  const files = api.getPanel("files");
  if (!files) return;
  mergeOthersInto(api, files.api.group, new Set([files.api.group]));
  files.api.setActive();
}

// All open terminals tiled into a grid taking the whole screen; everything else joins the first
// terminal's group as background tabs. No-op if none are open (open one via "+ Terminal" first).
function focusTerminals(api: DockviewApi) {
  if (!terminalPanelsOf(api).length) return;
  const rows = tileTerminals(api); // arrange + size them equally among themselves first
  const groups = new Set(rows.flat());
  // Re-fetch: tiling just moved them into new groups.
  const terms = terminalPanelsOf(api);
  mergeOthersInto(api, terms[0].api.group, groups);
  // mergeOthersInto grows the grid's footprint by removing its siblings; dockview's proportional
  // resize should already preserve the equal ratios set above, but re-measuring against the
  // final, fully-grown footprint is cheap and removes any reliance on that assumption (e.g.
  // rounding drift compounding across several nested splits).
  equalizeTerminalGrid(rows);
  terms[0].api.setActive();
}

// Experimental integrated "IDE" view: left rail (labs + devices) + a dockview panel area (topology,
// devices, files, runtime-fs, terminals, stats) whose layout can be freely rearranged by dragging.
export function WorkspacePage() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const ktTheme = useKtTheme();
  const { deployToggle, deleteLab, renameLab, wipeAll } = useLabLifecycleActions();

  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [labFilter, setLabFilter] = useState("");
  const [detail, setDetail] = useState<LabDetail | null>(null);
  // Mirrors `detail` for onDockReady (stable `useCallback([])`, so it can't read fresh state from
  // its own closure) to prune restored terminals against, without changing onDockReady's identity.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  // Separate from `busy` (shared with delete/rename/wipe-all) so the Deploy/Undeploy button only
  // spins for its own action, not whichever lifecycle action currently has the buttons disabled.
  // Fixed at the action's start rather than read live off `detail.deployed`: the toggle's onDone
  // callback refreshes `detail` (so it already flips to the new state) before this clears, and
  // recomputing the label from live state would flash "Undeploying…" right after a deploy finishes.
  const [deployAction, setDeployAction] = useState<"deploy" | "undeploy" | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(LS_RAIL) !== "false");
  const [railWidth, setRailWidth] = useState(() => {
    const saved = Number(localStorage.getItem(LS_RAIL_W));
    return Number.isFinite(saved) && saved >= RAIL_MIN_W && saved <= RAIL_MAX_W ? saved : RAIL_DEFAULT_W;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeInfoHost, setNodeInfoHost] = useState<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const didRedirect = useRef(false);

  const [showNew, setShowNew] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const dockApiRef = useRef<DockviewApi | null>(null);

  const reloadLabs = useCallback(async () => {
    try {
      setLabs(await api.listLabs());
    } catch (e) {
      toast.reportError("List labs", e);
    }
  }, [toast]);

  // Guards against out-of-order responses: switching lab A -> B quickly could otherwise let A's
  // slower fetch land after B's and clobber the workspace with the wrong lab's data — `api.ts` has
  // no request-cancellation support, so a generation counter is the fix (same pattern as
  // useFsTree's selectGenRef). Every `return` below is really "this call is done, stale or not."
  const loadGenRef = useRef(0);
  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (!name) {
      setDetail(null);
      setNotFound(false);
      return;
    }
    try {
      const nextDetail = await api.getLab(name);
      if (loadGenRef.current !== gen) return;
      setDetail(nextDetail);
      setNotFound(false);
    } catch (e) {
      if (loadGenRef.current !== gen) return;
      if (e instanceof ApiError && e.status === 404) {
        setDetail(null);
        setNotFound(true);
        return;
      }
      toast.reportError("Load lab", e);
    }
  }, [name, toast]);

  useEffect(() => {
    reloadLabs();
  }, [reloadLabs]);

  useEffect(() => {
    setDetail(null);
    setNotFound(false);
    setSelectedId(null);
    load();
  }, [load]);

  // Persist rail state + the last-open lab, and (once, on first entry to /workspace with no lab)
  // jump back to the last-open lab if it still exists.
  useEffect(() => {
    localStorage.setItem(LS_RAIL, String(railOpen));
  }, [railOpen]);
  useEffect(() => {
    localStorage.setItem(LS_RAIL_W, String(railWidth));
  }, [railWidth]);
  useEffect(() => {
    if (name) localStorage.setItem(LS_LAST_LAB, name);
  }, [name]);
  useEffect(() => {
    if (didRedirect.current || name || labs == null) return;
    didRedirect.current = true;
    // An explicit request to see the welcome screen (Help menu, or its own "show it again" link)
    // wins over jumping back into the last-open lab — set *after* didRedirect so dismissing the
    // welcome later doesn't then trigger a surprise redirect on its own re-render.
    if (searchParams.get("welcome") === "1") return;
    const last = localStorage.getItem(LS_LAST_LAB);
    if (last && labs.some((l) => l.name === last)) {
      navigate(`/workspace/${encodeURIComponent(last)}`, { replace: true });
    }
  }, [labs, name, navigate, searchParams]);

  // Zero labs is the only trigger for the welcome screen — no persisted "seen" flag: it's
  // self-healing (it comes back if the user empties their workspace, which is exactly when they
  // want the on-ramp again) and works identically whether or not localStorage survives a relaunch
  // (see backend.ts's stable-port fix for why that used to matter more than it should have).
  // `?welcome=1` (Help menu, or the "show it again" link below) reopens it on demand even with
  // labs present.
  const welcomeRequested = searchParams.get("welcome") === "1";
  const showWelcome = !detail && !notFound && labs != null && (labs.length === 0 || welcomeRequested);

  const handleLabCreated = useCallback(
    (n: string) => {
      reloadLabs();
      navigate(`/workspace/${encodeURIComponent(n)}`);
    },
    [reloadLabs, navigate],
  );

  const openFilesPanel = useCallback(() => {
    dockApiRef.current?.getPanel("files")?.api.setActive();
  }, []);

  const [runtimeFsPreferredMachine, setRuntimeFsPreferredMachine] = useState<string | null>(null);
  const openRuntimeFsPanel = useCallback((machine: string) => {
    setRuntimeFsPreferredMachine(machine);
    dockApiRef.current?.getPanel("runtime-fs")?.api.setActive();
  }, []);

  // The machine-options editor is a modal, not a dock panel — rendered once here (not inside
  // TopologyGraph) so both the topology canvas and the sidebar device list's right-click menu
  // (which share a single deviceContextItems) open the exact same instance.
  const [optionsEditorMachine, setOptionsEditorMachine] = useState<string | null>(null);
  const openOptionsEditor = useCallback((machine: string) => {
    setOptionsEditorMachine(machine);
  }, []);
  const closeOptionsEditor = useCallback(() => {
    setOptionsEditorMachine(null);
  }, []);

  // Same reasoning as the options editor above: one modal instance shared by every "add device"
  // entry point (topology canvas, device rail, domain context menu).
  const [addDeviceLink, setAddDeviceLink] = useState<{ show: boolean; prefillLink: string | null }>({
    show: false,
    prefillLink: null,
  });
  const openAddDeviceModal = useCallback((prefillLink: string | null) => {
    setAddDeviceLink({ show: true, prefillLink });
  }, []);
  const closeAddDeviceModal = useCallback(() => {
    setAddDeviceLink((s) => ({ ...s, show: false }));
  }, []);

  // Drag the rail's right edge to resize it (persisted). Listeners live on window so the drag keeps
  // tracking even when the pointer moves fast over the dock area.
  const startRailResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const left = railRef.current?.getBoundingClientRect().left ?? 0;
    const onMove = (ev: MouseEvent) => {
      setRailWidth(Math.min(RAIL_MAX_W, Math.max(RAIL_MIN_W, ev.clientX - left)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // Per-machine "next instance number" so a terminal's #n stays stable for its lifetime.
  const termCounter = useRef<Record<string, number>>({});
  const openTerminal = useCallback((machine: string) => {
    const dockApi = dockApiRef.current;
    if (!dockApi) return;
    const num = (termCounter.current[machine] ?? 0) + 1;
    termCounter.current[machine] = num;
    const existingTerminal = dockApi.panels.find((p) => p.id.startsWith("terminal:"));
    const devices = dockApi.getPanel("devices");
    dockApi.addPanel({
      id: `terminal:${machine}:${num}`,
      component: "terminal",
      title: `${machine} #${num}`,
      params: { machine },
      // Group with existing terminals (as tabs) if any; else land as a tab alongside the tool
      // panels (Devices, Lab Configuration, …) on the left; else just drop into a new/active group.
      position: existingTerminal
        ? { referenceGroup: existingTerminal.group, direction: "within" }
        : devices
          ? { referencePanel: "devices", direction: "within" }
          : undefined,
    });
  }, []);

  // Single useDeviceActions instance for the whole workspace — shared by the topology canvas (via
  // WorkspaceContext) and the device rail below, so right-clicking a device in either place means
  // exactly the same thing and there's one `pending`-files fetch / one action modal, not two.
  const deviceActions = useDeviceActions({
    labName: name,
    detail,
    onRefresh: load,
    onEditFiles: openFilesPanel,
    onOpenTerminal: openTerminal,
    onOpenRuntimeFs: openRuntimeFsPanel,
    onOpenOptions: openOptionsEditor,
    onOpenAddDevice: openAddDeviceModal,
  });
  const { deviceContextItems, findDeviceNode, domainContextItems, findDomainNode, actionConfig, setActionConfig } =
    deviceActions;

  // Close terminal panels whose device no longer exists in the lab (matches the old grid behavior).
  // Handles every *later* `detail` change; onDockReady below handles the lab already loaded by the
  // time the dock first mounts, which this effect alone would miss (see its own comment).
  useEffect(() => {
    const dockApi = dockApiRef.current;
    if (!dockApi || !detail) return;
    pruneOrphanTerminals(dockApi, new Set(detail.machines.map((m) => m.name)));
  }, [detail]);

  const onDockReady = useCallback((event: DockviewReadyEvent) => {
    dockApiRef.current = event.api;
    // Restore the saved layout, falling back to the default on absence/parse failure.
    let restored = false;
    const saved = localStorage.getItem(LS_LAYOUT);
    if (saved) {
      try {
        event.api.fromJSON(JSON.parse(saved));
        restored = true;
      } catch {
        /* stale/incompatible layout — fall back to default */
      }
    }
    if (!restored) buildDefaultLayout(event.api);

    // Subscribed before the fixups below run their own `p.api.close()`, on purpose: that close is
    // itself a layout change, and it must be persisted like any other — registering this first is
    // what makes that happen instead of leaving a since-pruned panel stuck in localStorage until
    // some *later*, unrelated layout change happens to resave over it.
    event.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(LS_LAYOUT, JSON.stringify(event.api.toJSON()));
      } catch {
        /* ignore quota/serialization errors */
      }
    });

    // DockviewReact only mounts once a lab is already loaded (see the `ctxValue && coreCtxValue`
    // check below), so `detailRef.current` is always populated by the time this runs — do the same
    // two restored-terminal fixups the rest of the component does on a *later* `detail` change:
    // seed termCounter so a new terminal can't collide with a restored one's id, and prune any
    // restored terminal for a device that's since been removed from the lab. Reading `detailRef`
    // (not `detail`) is what makes this correct despite onDockReady's own `[]` deps — dockview only
    // calls onReady once, so that's a constraint on this callback, not something to work around.
    seedTermCounterFromPanels(event.api, termCounter.current);
    if (detailRef.current) {
      pruneOrphanTerminals(event.api, new Set(detailRef.current.machines.map((m) => m.name)));
    }
  }, []);

  const filteredLabs = useMemo(() => {
    if (!labs) return labs;
    const q = labFilter.trim().toLowerCase();
    if (!q) return labs;
    return labs.filter((l) => (l.name ?? "").toLowerCase().includes(q));
  }, [labs, labFilter]);

  async function handleDeployToggle() {
    if (!detail) return;
    setDeployAction(detail.deployed ? "undeploy" : "deploy");
    try {
      await deployToggle({ name, deployed: detail.deployed, machines: detail.machines }, setBusy, async () => {
        await load();
        await reloadLabs();
      });
    } finally {
      setDeployAction(null);
    }
  }

  // After an elevation-triggered restart (see ElevationContext.tsx / services/desktop's
  // main.ts), the shell reloads straight into /workspace/<name>?resumeDeploy=1 — continue the
  // deploy the user was trying to do automatically instead of leaving them to notice the reload
  // finished and click Deploy again. Guarded by a ref, not just stripping the query param, so
  // this can only ever fire once per page load.
  const resumedDeployRef = useRef(false);
  useEffect(() => {
    if (resumedDeployRef.current || !detail || searchParams.get("resumeDeploy") !== "1") return;
    resumedDeployRef.current = true;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("resumeDeploy");
        return next;
      },
      { replace: true },
    );
    if (!detail.deployed) {
      toast.show("Administrator privileges granted — deploying now.", "success");
      void handleDeployToggle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, searchParams, setSearchParams]);

  // `labName` defaults to the open lab (the header button); the rail's context menu passes the
  // right-clicked lab, which may be a different one — in that case the open lab stays put.
  async function handleDelete(labName: string = name) {
    await deleteLab(labName, setBusy, async () => {
      await reloadLabs();
      if (localStorage.getItem(LS_LAST_LAB) === labName) localStorage.removeItem(LS_LAST_LAB);
      if (labName === name) navigate("/workspace");
    });
  }

  async function handleRename(labName: string) {
    await renameLab(labName, setBusy, async (newName) => {
      await reloadLabs();
      // Follow the lab only if it's the one currently open (the route holds its old name).
      if (labName === name) navigate(`/workspace/${encodeURIComponent(newName)}`, { replace: true });
    });
  }

  // Undeploys every running lab (not just this one) — the labs themselves (lab.conf etc.) stay on
  // disk, so refresh the list + the currently open lab's deployed state rather than navigating away.
  async function handleWipeAll() {
    await wipeAll(name || undefined, setBusy, async () => {
      await reloadLabs();
      await load();
    });
  }

  // Electron's native menu (File / Lab) drives the same handlers as the on-screen controls.
  // No-ops in the browser build. Deploy and Undeploy are separate menu items over one toggle,
  // so each checks the current state — otherwise "Deploy" on a running lab would tear it down.
  useDesktopCommand("lab:new", () => setShowNew(true));
  useDesktopCommand("lab:import", () => setShowUpload(true));
  useDesktopCommand("lab:deploy", () => {
    if (detail && !detail.deployed) void handleDeployToggle();
  });
  useDesktopCommand("lab:undeploy", () => {
    if (detail?.deployed) void handleDeployToggle();
  });
  useDesktopCommand("lab:reload", async () => {
    await load();
    await reloadLabs();
  });

  async function handleDownload(labName: string = name) {
    try {
      saveBlob(await api.downloadLab(labName), `${labName}.zip`);
    } catch (e) {
      toast.reportError("Download lab", e);
    }
  }

  // Right-click actions for a lab row in the rail. Acts on the clicked lab, which need not be the
  // one currently open.
  function openLabMenu(e: React.MouseEvent, lab: LabSummary) {
    if (!lab.name) return;
    const labName = lab.name;
    e.preventDefault();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Rename…",
          disabled: busy || lab.deployed,
          title: lab.deployed ? "Undeploy the lab to rename it" : undefined,
          action: () => void handleRename(labName),
        },
        { label: "Download .zip", disabled: busy, action: () => void handleDownload(labName) },
        { label: "Remove", danger: true, disabled: busy, action: () => void handleDelete(labName) },
      ],
    });
  }

  // Same menu as a right-click on this device in the topology canvas (useDeviceActions).
  function openDeviceMenu(e: React.MouseEvent, machine: string) {
    e.preventDefault();
    const nd = findDeviceNode(machine);
    if (!nd) return;
    setCtxMenu({ x: e.clientX, y: e.clientY, items: deviceContextItems(nd) });
  }

  // Same menu as a right-click on this collision domain in the topology canvas (useDeviceActions).
  function openDomainMenu(e: React.MouseEvent, domain: string) {
    e.preventDefault();
    const nd = findDomainNode(domain);
    if (!nd) return;
    setCtxMenu({ x: e.clientX, y: e.clientY, items: domainContextItems(nd) });
  }

  const deviceMachines = detail?.machines ?? [];
  const nonHostLinks = visibleLinks(detail?.links ?? []);

  const ctxValue = detail
    ? {
        labName: name,
        detail,
        onRefresh: load,
        selectedId,
        setSelectedId,
        openFilesPanel,
        openTerminal,
        openRuntimeFsPanel,
        runtimeFsPreferredMachine,
        nodeInfoHost,
        setNodeInfoHost,
        deviceActions,
        setContextMenu: setCtxMenu,
      }
    : null;

  // Unlike `ctxValue` above (rebuilt fresh every render because it bundles the genuinely-volatile
  // `deviceActions`), every field here is independently stable across unrelated re-renders — so
  // `useMemo` actually keeps this object's identity stable for the tree-heavy Files/Runtime FS
  // panels, instead of them re-rendering on every unrelated workspace interaction.
  const coreCtxValue = useMemo(
    () => (detail ? { labName: name, detail, onRefresh: load, runtimeFsPreferredMachine, setContextMenu: setCtxMenu } : null),
    [name, detail, load, runtimeFsPreferredMachine],
  );

  const runningMachines = deviceMachines.filter((m) => m.running);

  function applyPreset(preset: "default" | "topology" | "editing" | "terminals") {
    const dockApi = dockApiRef.current;
    if (!dockApi) return;
    if (preset === "default") {
      resetLayout(dockApi);
    } else if (preset === "topology") {
      focusTopology(dockApi);
    } else if (preset === "editing") {
      focusEditing(dockApi);
    } else if (preset === "terminals") {
      focusTerminals(dockApi);
    }
  }

  return (
    <div className="kt-ws">
      {railOpen ? (
        <>
        <aside className="kt-ws-rail" ref={railRef} style={{ flexBasis: railWidth }}>
          <div className="kt-ws-rail-sec">
            <div className="kt-ws-rail-head">
              <span>Labs</span>
              <button className="kt-ws-collapse-btn" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={() => setRailOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 3v18" />
                  <path d="m16 15-3-3 3-3" />
                </svg>
              </button>
            </div>
            <div className="d-flex gap-1 mb-2">
              <Button size="sm" variant="primary" className="flex-fill" onClick={() => setShowNew(true)}>
                + New
              </Button>
              <Button size="sm" variant="outline-secondary" className="flex-fill" onClick={() => setShowUpload(true)}>
                Upload
              </Button>
            </div>
            {/* Hidden with no labs: on a first run this red, destructive button was the most
                prominent control on an otherwise empty screen. Deliberately gated on "has labs"
                rather than "has deployed labs" — this is also the recovery tool for when the
                registry disagrees with reality (containers alive, list says undeployed), which
                is exactly the case the tighter check would hide it in. */}
            {labs != null && labs.length > 0 && (
              <Button
                size="sm"
                variant="outline-danger"
                className="w-100 mb-2"
                disabled={busy}
                onClick={handleWipeAll}
                title="Force-undeploys every lab running in kathara-ide, not just this one"
              >
                Wipe all labs
              </Button>
            )}
            <Form.Control
              size="sm"
              type="search"
              placeholder="Filter labs…"
              value={labFilter}
              onChange={(e) => setLabFilter(e.target.value)}
              className="mb-2"
            />
            <div className="kt-ws-list">
              {labs == null ? (
                <div className="kt-ws-muted">Loading…</div>
              ) : filteredLabs && filteredLabs.length === 0 ? (
                <div className="kt-ws-muted">{labs.length === 0 ? "No labs yet." : "No matches."}</div>
              ) : (
                filteredLabs?.map((l) => (
                  <button
                    key={l.name ?? l.hash}
                    className={`kt-ws-row ${l.name === name ? "active" : ""}`}
                    onClick={() => l.name && navigate(`/workspace/${encodeURIComponent(l.name)}`)}
                    onContextMenu={(e) => openLabMenu(e, l)}
                    title={l.name ? `${l.name} — click to open · right-click for actions` : ""}
                  >
                    <span className={`kt-ws-dot ${l.deployed ? "running" : "stopped"}`} />
                    <span className="kt-ws-row-name">{l.name || "(unnamed)"}</span>
                    <span className="kt-ws-row-meta">{l.n_machines}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {detail && (
            <div className="kt-ws-rail-sec">
              <div className="kt-ws-rail-head">
                <span>Devices</span>
              </div>
              <div className="kt-ws-list">
                {deviceMachines.length === 0 ? (
                  <div className="kt-ws-muted">No devices.</div>
                ) : (
                  deviceMachines.map((m) => (
                    <button
                      key={m.name}
                      className={`kt-ws-row ${selectedId === `dev:${m.name}` ? "active" : ""}`}
                      onClick={() => setSelectedId(`dev:${m.name}`)}
                      onContextMenu={(e) => openDeviceMenu(e, m.name)}
                      title="Click to select · right-click for actions"
                    >
                      <span className={`kt-ws-dot ${m.running ? "running" : "stopped"}`} />
                      <span className="kt-ws-row-name">{m.name}</span>
                      {m.running && (
                        <span
                          className="kt-ws-mini-btn"
                          role="button"
                          title="Open terminal"
                          onClick={(e) => {
                            e.stopPropagation();
                            openTerminal(m.name);
                          }}
                        >
                          <SquareTerminal size={14} />
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
              {nonHostLinks.length > 0 && (
                <>
                  <div className="kt-ws-rail-head mt-2">
                    <span>Collision domains</span>
                  </div>
                  <div className="kt-ws-list">
                    {nonHostLinks.map((lk) => (
                      <button
                        key={lk.name}
                        className={`kt-ws-row ${selectedId === `cd:${lk.name}` ? "active" : ""}`}
                        onClick={() => setSelectedId(`cd:${lk.name}`)}
                        onContextMenu={(e) => openDomainMenu(e, lk.name)}
                        title="Click to select · right-click for actions"
                      >
                        <span className={`kt-ws-dot ${lk.running ? "running" : "stopped"}`} />
                        <span className="kt-ws-row-name">{lk.name}</span>
                        <span className="kt-ws-row-meta">{lk.machines.length}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
          <div
            className="kt-ws-rail-resizer"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onMouseDown={startRailResize}
          />
        </>
      ) : (
        <button className="kt-ws-rail-reopen" title="Show sidebar" aria-label="Show sidebar" onClick={() => setRailOpen(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d="m14 9 3 3-3 3" />
          </svg>
        </button>
      )}

      <div className="kt-ws-main">
        <header className="kt-ws-header">
          {detail ? (
            <>
              <h5
                className="mb-0 me-1"
                style={{ cursor: "pointer" }}
                title={detail.deployed ? "Undeploy the lab to rename it" : "Click to rename"}
                onClick={() => {
                  if (detail.deployed) {
                    toast.show("Undeploy the lab to rename it.", "info");
                    return;
                  }
                  void handleRename(name);
                }}
              >
                {detail.name || "(unnamed)"}
              </h5>
              <Badge bg={detail.deployed ? "success" : "secondary"}>{detail.deployed ? "deployed" : "undeployed"}</Badge>
              {detail.machines.some((m) => m.privileged) && (
                <Badge
                  bg="warning"
                  text="dark"
                  className="d-flex align-items-center gap-1"
                  title="This lab has privileged devices — deploying it requires administrator privileges."
                >
                  <ShieldAlert size={12} />
                  privileged
                </Badge>
              )}
              <div className="ms-auto d-flex gap-2">
                <DropdownButton
                  size="sm"
                  variant="outline-secondary"
                  title="+ Terminal"
                  disabled={!runningMachines.length}
                >
                  {runningMachines.map((m) => (
                    <Dropdown.Item key={m.name} onClick={() => openTerminal(m.name)}>
                      {m.name}
                    </Dropdown.Item>
                  ))}
                </DropdownButton>
                <DropdownButton size="sm" variant="outline-secondary" title="Layout">
                  <Dropdown.Item onClick={() => applyPreset("default")}>Default</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("topology")}>Focus topology</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("editing")}>Focus editing</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("terminals")}>Focus terminals</Dropdown.Item>
                </DropdownButton>
                <Button
                  size="sm"
                  variant={detail.deployed ? "outline-warning" : "primary"}
                  disabled={busy}
                  onClick={handleDeployToggle}
                  className="d-flex align-items-center gap-1"
                >
                  {deployAction && <Loader2 size={14} className="kt-explorer-spin" />}
                  {deployAction === "deploy"
                    ? "Deploying…"
                    : deployAction === "undeploy"
                      ? "Undeploying…"
                      : detail.deployed
                        ? "Undeploy"
                        : "Deploy"}
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={() => void handleDownload()}>
                  Download
                </Button>
                <Button size="sm" variant="outline-danger" disabled={busy} onClick={() => void handleDelete()}>
                  Delete
                </Button>
              </div>
            </>
          ) : (
            <h5 className="mb-0 kt-ws-muted">{notFound ? `Lab "${name}" not found` : "No lab selected"}</h5>
          )}
        </header>

        <div className="kt-ws-dockarea">
          {ctxValue && coreCtxValue ? (
            <WorkspaceProvider value={ctxValue}>
              <WorkspaceCoreProvider value={coreCtxValue}>
                <DockviewReact
                  components={DOCK_COMPONENTS}
                  tabComponents={DOCK_TAB_COMPONENTS}
                  defaultTabComponent={DockTab}
                  rightHeaderActionsComponent={GroupHeaderActions}
                  onReady={onDockReady}
                  theme={ktTheme === "dark" ? themeDark : themeLight}
                />
              </WorkspaceCoreProvider>
            </WorkspaceProvider>
          ) : notFound ? (
            <div className="kt-ws-empty">
              <p className="kt-ws-muted">
                Lab <code>{name}</code> was not found.
              </p>
              <Button size="sm" variant="outline-secondary" onClick={() => navigate("/workspace")}>
                Clear selection
              </Button>
            </div>
          ) : showWelcome ? (
            <WelcomeScreen
              onNewLab={() => setShowNew(true)}
              onImportLab={() => setShowUpload(true)}
              onLabCreated={handleLabCreated}
              // Nothing to fall back on for a genuine first run (labs.length === 0): dismissing
              // would just show this exact same screen again on the next render.
              onDismiss={labs != null && labs.length > 0 ? () => setSearchParams({}) : undefined}
            />
          ) : labs == null ? (
            <div className="kt-ws-empty">
              <p className="kt-ws-muted">Loading…</p>
            </div>
          ) : (
            <div className="kt-ws-empty">
              <p className="kt-ws-muted">
                Select a lab from the left, or{" "}
                <Button variant="link" size="sm" className="p-0 align-baseline" onClick={() => setSearchParams({ welcome: "1" })}>
                  show the welcome screen
                </Button>
                .
              </p>
            </div>
          )}
        </div>
      </div>

      <TopologyContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      <TopologyActionModal config={actionConfig} onClose={() => setActionConfig(null)} />
      {detail && (
        <MachineOptionsEditor
          show={!!optionsEditorMachine}
          labName={name}
          machine={optionsEditorMachine ? detail.machines.find((m) => m.name === optionsEditorMachine) ?? null : null}
          deployed={detail.deployed}
          onClose={closeOptionsEditor}
          onSaved={load}
        />
      )}
      {detail && (
        <AddDeviceModal
          show={addDeviceLink.show}
          labName={name}
          prefillLink={addDeviceLink.prefillLink}
          onClose={closeAddDeviceModal}
          onAdded={load}
        />
      )}

      <NewLabModal show={showNew} onClose={() => setShowNew(false)} onCreated={handleLabCreated} />
      <UploadLabModal show={showUpload} onClose={() => setShowUpload(false)} onCreated={handleLabCreated} />
    </div>
  );
}
