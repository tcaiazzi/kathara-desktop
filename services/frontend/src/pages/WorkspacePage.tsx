// The Workspace screen and everything that arranges it: the dockview panel area, the panels'
// thin wrappers around the real components, and the layout commands behind the Layout menu
// (default, focus presets, terminal tiling, maximize).
//
// Most of this file is dockview bookkeeping rather than UI. dockview owns the panel tree
// imperatively through a `DockviewApi`, not as React children, so adding, moving, closing and
// measuring panels all happen in plain functions against that api — which is why they live at
// module level here, taking the api as an argument, instead of inside the component.
//
// A saved layout is replayed from localStorage under `LS_LAYOUT`; see its own comment for the
// one rule that keeps a stale one from outliving a redesign.

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
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  Globe,
  LayoutGrid,
  List,
  Loader2,
  Maximize,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
  SquareTerminal,
  SquareX,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dropdown, DropdownButton, Form } from "react-bootstrap";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { DevicesTable } from "../components/DevicesTable";
import { LabExplorer } from "../components/LabExplorer";
import { LinksTable } from "../components/LinksTable";
import { AddDeviceModal } from "../components/AddDeviceModal";
import { MachineOptionsEditor } from "../components/MachineOptionsEditor";
import { GalleryModal } from "../components/GalleryModal";
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
import { desktop, isDesktop, type DesktopDockerStatus } from "../desktop/bridge";
import { useDockerStatus } from "../desktop/DockerStatusContext";
import { usePublishOpenLabName } from "../context/OpenLabNameContext";
import { WorkspaceProvider, useWorkspace } from "../context/WorkspaceContext";
import { WorkspaceCoreProvider, useWorkspaceCore, type StartupChange } from "../context/WorkspaceCoreContext";
import { useLabEvents } from "../hooks/useLabEvents";
import {
  useOnboardingTour,
  useOnboardingTourFocusPanel,
  useOnboardingTourReady,
  useOnboardingTourSelectFirstDevice,
} from "../context/OnboardingTourContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { useDeviceActions } from "../hooks/useDeviceActions";
import { useElementSize } from "../hooks/useElementSize";
import { useIsAdmin } from "../hooks/useIsAdmin";
import { useTheme } from "../hooks/useTheme";
import { useLabLifecycleActions } from "../hooks/useLabLifecycleActions";
import { api, ApiError, isAbortError } from "../services/api";
import { visibleLinks } from "../services/constants";
import { saveBlob } from "../services/download";
import { deployButtonLabel } from "../services/imagePull";
import { changedStartupPaths, labEventNotice } from "../services/labEvents";
import { labFolderHint } from "../services/labPlace";
import type { LabDetail, LabRef, LabSummary } from "../services/types";
import "./WorkspacePage.css";

// --- Dock panels (each reads live lab data from WorkspaceContext) ---
function TopologyPanel() {
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel-fill" data-tour="topology-panel">
      <TopologyGraph
        labId={ws.labId}
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
      <DevicesTable labId={ws.labId} machines={ws.detail.machines} />
      <LinksTable links={ws.detail.links} />
    </div>
  );
}
function FilesPanel() {
  const ws = useWorkspaceCore();
  return (
    <div className="kt-ws-panel-fill">
      <LabExplorer
        labId={ws.labId}
        detail={ws.detail}
        onStructuralChange={ws.onRefresh}
        onStartupFileSaved={ws.refreshStartups}
        startupChange={ws.startupChange}
      />
    </div>
  );
}
function RuntimeFsPanel() {
  const ws = useWorkspaceCore();
  return (
    <div className="kt-ws-panel-fill">
      <RuntimeFilesystemEditor
        labId={ws.labId}
        detail={ws.detail}
        preferredMachine={ws.runtimeFsPreferredMachine}
        onSelectMachine={(m) => ws.setSelectedId(`dev:${m}`)}
      />
    </div>
  );
}
function StatsPanel_() {
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel">
      <StatsPanel labId={ws.labId} deployed={ws.detail.deployed} />
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

// Onboarding tour targets for the shared tab strip (node-info/devices/files/runtime-fs/stats) —
// the tab itself, not its (usually hidden, since only one tab in the group is active) content, so
// the spotlight always lands on something clickable and visible. See DockTab below.
const TOUR_TAB_ID: Record<string, string> = {
  "node-info": "node-info-tab",
  devices: "devices-tab",
  files: "files-tab",
  "runtime-fs": "runtime-fs-tab",
  stats: "stats-tab",
};

// Tab renderer for every panel: the close button appears only on the panels that are actually
// closable. Wired as dockview's `defaultTabComponent` rather than per-panel, so it also governs a
// layout restored from localStorage — a saved layout replays each panel's own `tabComponent`, so
// a per-panel opt-in could never reach a panel that was already persisted without one, leaving
// it with a close button its siblings lack.
function DockTab(props: IDockviewPanelHeaderProps) {
  return (
    <DockviewDefaultTab
      {...props}
      hideClose={isFixedPanel(props.api.id)}
      data-tour={TOUR_TAB_ID[props.api.id]}
    />
  );
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
        <Maximize size={14} aria-hidden="true" />
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
        {collapsed ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

// dockview replays a saved layout wholesale — the arrangement and each panel's persisted title —
// and onDockReady below accepts anything that parses, with no schema check beyond this key. Bump
// the version suffix whenever the default arrangement changes or a persisted panel title changes,
// or everyone with a saved layout keeps both the old arrangement and the old tab names for good.
const LS_LAYOUT = "kt-ws-layout-v7";
const LS_RAIL = "kt-ws-rail-open";
const LS_RAIL_W = "kt-ws-rail-width";
const LS_LAST_LAB = "kt-ws-last-lab";

// Left explorer (rail) resize bounds.
const RAIL_MIN_W = 180;
const RAIL_MAX_W = 560;
// Comfortably above IMPORT_ROW_COMPACT_WIDTH (plus the rail's own 10px side padding) so a fresh
// install never shows the import row's compact dropdown at startup — only a manually narrowed rail.
const RAIL_DEFAULT_W = 365;

// The manual per-group "Collapse panel" toggle shrinks a group to (about) its header height;
// clicking it again (or its header strip) restores it to a usable height.
const COLLAPSED_GROUP_HEIGHT = 35;
const RESTORE_GROUP_HEIGHT = 280;
// The layout presets, in menu order. One list, rendered by both header variants, so the compact
// and the wide menu cannot drift apart on a label's spelling. The wording is the wide branch's,
// because a normal window shows that branch and it is what most users already know.
const LAYOUT_PRESETS = [
  { key: "default", label: "Default" },
  { key: "topology", label: "Focus topology" },
  { key: "editing", label: "Focus editing" },
  { key: "terminals", label: "Focus terminals" },
] as const;

type LayoutPreset = (typeof LAYOUT_PRESETS)[number]["key"];

// A group at/under this height is considered collapsed (header strip only).
const COLLAPSE_THRESHOLD = 60;

// Below this width, the lab header's action row (Terminal/Layout/Deploy/Download/Delete) collapses
// into a single dropdown — see the `compactActions` header ref below.
const HEADER_ACTIONS_COMPACT_WIDTH = 900;

// Below this width, the rail's import row (New/Open/Upload/Browse) collapses into a single
// "Add Lab" dropdown instead of squeezing/deforming — same pattern as compactActions above. ~242px
// is the row's natural unsquished width with 3 sm buttons (icon+label), ~324px with the desktop
// app's 4th, Open; padded for font-rendering variance.
const IMPORT_ROW_COMPACT_WIDTH = isDesktop() ? 340 : 260;

// Fraction of the total height the topology row gets when it's first split off from the shared
// tab group below it — matches the shipped default screenshot (topology noticeably taller than
// the tabs).
const TOPOLOGY_HEIGHT_FRACTION = 0.62;

// Matches an `openTerminal`-minted panel id (`terminal:<machine>:<n>`) so a restored layout's
// terminals can be told apart from every other panel.
const TERMINAL_ID_RE = /^terminal:(.*):(\d+)$/;

function buildDefaultLayout(api: DockviewApi) {
  // Topology first: its own full-width row on top, with nothing else yet so it fills the canvas.
  api.addPanel({ id: "topology", component: "topology", title: "Topology" });
  // One shared tab group below it: the inspector plus every tool panel. Device Information goes in first
  // so it lands as the left-most tab.
  api.addPanel({
    id: "node-info",
    component: "node-info",
    title: "Device Information",
    position: { referencePanel: "topology", direction: "below" },
  });
  api.addPanel({ id: "devices", component: "devices", title: "Lab Details", position: { referencePanel: "node-info", direction: "within" } });
  api.addPanel({ id: "files", component: "files", title: "Lab Configuration", position: { referencePanel: "devices", direction: "within" } });
  api.addPanel({ id: "runtime-fs", component: "runtime-fs", title: "Runtime Filesystem", position: { referencePanel: "devices", direction: "within" } });
  api.addPanel({ id: "stats", component: "stats", title: "Statistics", position: { referencePanel: "devices", direction: "within" } });
  if (api.height) {
    api.getPanel("topology")?.api.group.api.setSize({ height: Math.round(api.height * TOPOLOGY_HEIGHT_FRACTION) });
  }
  api.getPanel("devices")?.api.setActive();
}

// Re-open the Device Information panel if it was closed (as a tab alongside Lab Details/Lab
// Configuration/…).
// No-op if it already exists. Doesn't foreground it when it's sharing a tab group with Topology —
// e.g. dragged there manually — since that would hide the topology view a selection likely just
// came from; the node-info content itself is a portal (NodeInfoPanel) that updates regardless of
// which tab is active.
function showNodeInfo(api: DockviewApi) {
  const nodeInfo = api.getPanel("node-info");
  if (nodeInfo) {
    const topology = api.getPanel("topology");
    const dockedWithTopology = topology && topology.api.group === nodeInfo.api.group;
    if (!dockedWithTopology) nodeInfo.api.setActive();
    return;
  }
  const devices = api.getPanel("devices");
  api.addPanel({
    id: "node-info",
    component: "node-info",
    title: "Device Information",
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
// mergeOthersInto activates whichever panel it moves in last, so re-assert the tab that was
// active before the merge (same pattern as focusTopology/focusEditing/focusTerminals below).
function maximizeGroup(api: DockviewApi, group: DockviewGroupPanel) {
  const active = group.activePanel;
  mergeOthersInto(api, group, new Set([group]));
  active?.api.setActive();
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

// Close any terminal panel whose device no longer exists in this lab. Shared by the effect below
// (reacts to a later `detail` change) and `onDockReady` (handles a lab already loaded by the
// time a restored layout's terminals first appear).
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

// Default: one shared tab group below with the inspector, every tool panel, and every open
// terminal; the topology full-width on top. Without unmounting anything.
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
  topo.api.moveTo({ group: devices.api.group, position: "top" as const });
  // Undo any collapse pinning left by the manual per-group "Collapse panel" toggle, on every
  // group (not just tools) — any of them can end up shrunk depending on what ran last.
  for (const g of api.groups) {
    g.api.setConstraints({ minimumHeight: 100, minimumWidth: 100 });
  }
  topo.api.group.api.setSize({ height: Math.round(api.height * TOPOLOGY_HEIGHT_FRACTION) });
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

interface LabRowLabelProps {
  lab: LabSummary;
}

// A rail row's name, plus — for a folder opened from outside the labs folder — where it is, which
// is what tells two such labs with the same name apart (services/labPlace.ts).
function LabRowLabel({ lab }: LabRowLabelProps) {
  const folder = !lab.managed && lab.path ? labFolderHint(lab.path) : null;
  const problem = lab.problem ? PROBLEM_LABEL[lab.problem] ?? lab.problem : null;
  const hint = [folder, problem].filter(Boolean).join(" · ");
  return (
    <span className="kt-ws-row-name">
      {lab.name || "(unnamed)"}
      {hint && <span className="kt-ws-row-path">{hint}</span>}
    </span>
  );
}

// LabSummary.problem, as the rail says it — and what a click on such a row explains instead of
// opening a lab that isn't loaded.
const PROBLEM_LABEL: Record<string, string> = { missing: "missing", unloadable: "can't be loaded" };
const PROBLEM_EXPLANATION: Record<string, string> = {
  missing:
    "can't be opened: its folder isn't there any more. It loads by itself if the folder comes back; Close removes it from the list.",
  unloadable:
    "can't be opened: its lab.conf doesn't load. Fix it in another editor and it loads by itself; Close removes it from the list.",
};

// The Workspace (see App.tsx's routes): left rail (labs + devices) + a dockview panel area
// (topology, devices, files, runtime-fs, terminals, stats) whose layout is freely rearrangeable
// by dragging.
export function WorkspacePage() {
  const { labId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { theme: ktTheme } = useTheme();
  const { run: runBusy } = useBusyAction();
  const { deployToggle, deleteLab, closeLab, renameLab, wipeAll } = useLabLifecycleActions();

  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [labsError, setLabsError] = useState<string | null>(null);
  const [labFilter, setLabFilter] = useState("");
  const [labPickerOpen, setLabPickerOpen] = useState(false);
  const [detail, setDetail] = useState<LabDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Mirrors `detail` for the two stable `useCallback([])` consumers that can't read fresh state
  // from their own closure: onDockReady (which prunes restored terminals against it, and must keep
  // its identity) and the tour's select-first-device registration.
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  // Separate from `busy` (shared with delete/rename/wipe-all) so the Deploy/Undeploy button only
  // spins for its own action, not whichever lifecycle action currently has the buttons disabled.
  // Fixed at the action's start rather than read live off `detail.deployed`: the toggle's onDone
  // callback refreshes `detail` (so it already flips to the new state) before this clears, and
  // recomputing the label from live state would flash "Undeploying…" right after a deploy finishes.
  // "checking" is the image pre-check that runs before a deploy: it can take a couple of seconds
  // (a registry round-trip per image, unless image_update_policy is Never), and labelling it as
  // "Deploying…" would make a slow network look like a stuck deploy.
  const [deployAction, setDeployAction] = useState<"checking" | "deploy" | "undeploy" | null>(null);
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem(LS_RAIL) !== "false");
  const [railWidth, setRailWidth] = useState(() => {
    const saved = Number(localStorage.getItem(LS_RAIL_W));
    return Number.isFinite(saved) && saved >= RAIL_MIN_W && saved <= RAIL_MAX_W ? saved : RAIL_DEFAULT_W;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeInfoHost, setNodeInfoHost] = useState<HTMLElement | null>(null);
  const railRef = useRef<HTMLElement>(null);
  // Set while a rail-resize drag is in flight (see startRailResize below), so the unmount effect
  // can force-remove the drag's window listeners if this component unmounts mid-drag (a lab
  // import unmounting WorkspacePage, an ErrorBoundary catch, a route change) — same leaked-
  // listener shape useForceLayout.ts's activeDragCleanup guards against for the topology canvas.
  const railDragCleanupRef = useRef<(() => void) | null>(null);
  // Below this header width, the whole lab-action row (Terminal/Layout/Deploy/Download/Delete)
  // collapses into a single "more actions" dropdown instead of squeezing/deforming — same pattern
  // as TopologyGraph's own compact toolbar, measured via ResizeObserver rather than viewport width
  // since this reacts to the sidebar being resized too, not just the browser window.
  const { ref: headerRef, width: headerWidth } = useElementSize<HTMLElement>();
  const compactActions = headerWidth > 0 && headerWidth < HEADER_ACTIONS_COMPACT_WIDTH;
  const { ref: importRowRef, width: importRowWidth } = useElementSize<HTMLDivElement>();
  const compactImportRow = importRowWidth > 0 && importRowWidth < IMPORT_ROW_COMPACT_WIDTH;
  const didRedirect = useRef(false);
  const setTourReady = useOnboardingTourReady();
  const { requestTour } = useOnboardingTour();
  const registerTourFocusPanel = useOnboardingTourFocusPanel();
  const registerTourSelectFirstDevice = useOnboardingTourSelectFirstDevice();
  const autoTourRequested = useRef(false);
  const isAdmin = useIsAdmin();

  const [showNew, setShowNew] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  // WorkspacePage isn't remounted on lab change (unkeyed route), so a menu built for the
  // previous lab's items would otherwise stay open and act on it after navigation.
  useEffect(() => setCtxMenu(null), [labId]);

  const dockApiRef = useRef<DockviewApi | null>(null);

  // Selecting a node (topology graph or sidebar rail) should bring its details forward — the
  // Device Information tab might be sitting behind Lab Details/Lab Configuration/… or be closed
  // entirely.
  const selectNode = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id !== null && dockApiRef.current) showNodeInfo(dockApiRef.current);
  }, []);

  // Same out-of-order guard as `load` below: lab events (useLabEvents) start a reload at any time,
  // and a slow one started before a close must not land after the close's own and list the lab
  // again.
  const reloadGenRef = useRef(0);
  const reloadLabs = useCallback(async () => {
    const gen = ++reloadGenRef.current;
    setLabsError(null);
    try {
      const next = await api.listLabs();
      if (reloadGenRef.current === gen) setLabs(next);
    } catch (e) {
      if (reloadGenRef.current !== gen) return;
      toast.reportError("List labs", e);
      setLabsError(e instanceof ApiError ? e.message : "Couldn't load labs.");
    }
  }, [toast]);

  // Guards against out-of-order responses: switching lab A -> B quickly could otherwise let A's
  // slower fetch land after B's and clobber the workspace with the wrong lab's data. The
  // generation counter alone only guarded the `setState` calls; `loadAbortRef` additionally
  // aborts the actual in-flight fetch (superseded or the component unmounting) instead of just
  // ignoring its result.
  const loadGenRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const gen = ++loadGenRef.current;
    if (!labId) {
      setDetail(null);
      setNotFound(false);
      setDetailError(null);
      return;
    }
    setDetailError(null);
    try {
      const nextDetail = await api.getLab(labId, controller.signal);
      if (loadGenRef.current !== gen) return;
      setDetail(nextDetail);
      setNotFound(false);
    } catch (e) {
      if (isAbortError(e)) return;
      if (loadGenRef.current !== gen) return;
      if (e instanceof ApiError && e.status === 404) {
        setDetail(null);
        setNotFound(true);
        return;
      }
      toast.reportError("Load lab", e);
      setDetailError(e instanceof ApiError ? e.message : "Couldn't load this lab.");
    }
  }, [labId, toast]);

  useEffect(() => () => loadAbortRef.current?.abort(), []);

  useEffect(() => {
    reloadLabs();
  }, [reloadLabs]);

  // Docker being installed-but-stopped doesn't make those fetches fail: the backend answers them
  // from the on-disk model with nothing marked running (KatharaService._facade_or_offline), so the
  // workspace opens and everything that doesn't need a daemon still works. What it *can't* report
  // is live state, so a lab that comes up while the app is open would keep showing as stopped. The
  // health badge only proves the FastAPI process is alive, not that Docker answers, so it never
  // signals this; useDockerStatus() is the one thing that polls real Docker readiness, so reload
  // on recovery to pick up the live state (and to recover any genuinely failed load). Only a
  // genuine "stopped"/"missing" -> "ok" transition qualifies — the initial `null` -> "ok"
  // resolution on a normal startup would just duplicate the mount-time fetch above.
  const prevDockerState = useRef<DesktopDockerStatus["state"] | null>(null);
  const dockerStatus = useDockerStatus();
  useEffect(() => {
    const prev = prevDockerState.current;
    const next = dockerStatus?.state ?? null;
    if (prev && prev !== "ok" && next === "ok") {
      void reloadLabs();
      if (labId) void load();
    }
    prevDockerState.current = next;
  }, [dockerStatus?.state, reloadLabs, load, labId]);

  useEffect(() => {
    setDetail(null);
    setNotFound(false);
    setSelectedId(null);
    setLabPickerOpen(false);
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
    if (labId) localStorage.setItem(LS_LAST_LAB, labId);
  }, [labId]);
  // Every `data-tour` target below lives inside the dock area, which only mounts once `detail`
  // is truthy (see `ctxValue && coreCtxValue` further down) — so "a lab is open" is exactly the
  // readiness signal the onboarding tour needs, both for its one-time auto-trigger and to no-op
  // a manual replay (Help menu / navbar) gracefully when there's nothing to highlight yet.
  useEffect(() => {
    setTourReady(!!detail);
  }, [detail, setTourReady]);
  // Skipped entirely when running privileged (isAdmin === true) — walking a new user through the
  // UI while the backend already has root feels like the wrong first impression to lead with.
  // `isAdmin === false` (not just falsy) so this waits for useIsAdmin's check to actually resolve
  // rather than firing on its "still checking" default and racing the real answer.
  useEffect(() => {
    if (detail && !autoTourRequested.current && isAdmin === false) {
      autoTourRequested.current = true;
      requestTour({ auto: true });
    }
  }, [detail, requestTour, isAdmin]);
  // "Lab Details" and "Lab Configuration" share one tab group (see buildDefaultLayout) — only one is
  // ever visually on top, so the tour brings the right one forward as it reaches each step.
  useEffect(() => {
    registerTourFocusPanel((panelId) => dockApiRef.current?.getPanel(panelId)?.api.setActive());
  }, [registerTourFocusPanel]);
  // "Device Information" shows nothing until a device is selected — the tour picks the first one so that
  // step has real content to point at.
  useEffect(() => {
    registerTourSelectFirstDevice(() => {
      const first = detailRef.current?.machines[0];
      if (first) setSelectedId(`dev:${first.name}`);
    });
  }, [registerTourSelectFirstDevice]);
  // The shell can land the window on a lab this page has never listed — a folder it just opened
  // (File → Open Lab Folder…, `kathara-desktop <folder>`) — so a route naming an id the list
  // doesn't have refreshes the list — once while it stays missing, and again if it goes missing
  // later: a folder closed and opened again comes back under the same id.
  const refreshedForId = useRef<string | null>(null);
  useEffect(() => {
    if (!labId || labs == null) return;
    if (labs.some((l) => l.id === labId)) {
      refreshedForId.current = null;
      return;
    }
    if (refreshedForId.current === labId) return;
    refreshedForId.current = labId;
    void reloadLabs();
  }, [labId, labs, reloadLabs]);

  useEffect(() => {
    if (didRedirect.current || labId || labs == null) return;
    didRedirect.current = true;
    // An explicit request to see the welcome screen (Help menu, or its own "show it again" link)
    // wins over jumping back into the last-open lab — set *after* didRedirect so dismissing the
    // welcome later doesn't then trigger a surprise redirect on its own re-render.
    if (searchParams.get("welcome") === "1") return;
    const last = localStorage.getItem(LS_LAST_LAB);
    if (last && labs.some((l) => l.id === last && !l.problem)) {
      navigate(`/workspace/${encodeURIComponent(last)}`, { replace: true });
    }
  }, [labs, labId, navigate, searchParams]);

  // Zero labs is the only trigger for the welcome screen — no persisted "seen" flag: it's
  // self-healing (it comes back if the user empties their workspace, which is exactly when they
  // want the on-ramp again) and works identically whether or not localStorage survives a relaunch
  // (see backend.ts's stable-port handling for why that matters).
  // `?welcome=1` (Help menu, or the "show it again" link below) reopens it on demand even with
  // labs present.
  const welcomeRequested = searchParams.get("welcome") === "1";
  const showWelcome = !detail && !notFound && labs != null && (labs.length === 0 || welcomeRequested);

  const handleLabCreated = useCallback(
    (createdId: string) => {
      reloadLabs();
      navigate(`/workspace/${encodeURIComponent(createdId)}`);
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

  // Keep the Runtime Filesystem device selector coherent with whatever node is selected elsewhere
  // (topology graph or sidebar) — without stealing focus onto the runtime-fs panel itself (unlike
  // openRuntimeFsPanel above, this never calls .setActive()). Collision domains and deselection
  // have no Runtime Filesystem equivalent, so they're left alone.
  useEffect(() => {
    if (selectedId?.startsWith("dev:")) setRuntimeFsPreferredMachine(selectedId.slice(4));
  }, [selectedId]);

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
      railDragCleanupRef.current = null;
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Let the unmount effect below remove these listeners and restore body styles if this
    // component unmounts before onUp ever fires — onUp itself already nulls this out on the
    // normal (mouseup) path, so this ref only matters for the abnormal one.
    railDragCleanupRef.current = onUp;
  }, []);

  // Force-remove any still-attached rail-resize listeners left by an in-flight drag if
  // WorkspacePage unmounts mid-drag — otherwise they keep firing against a stale railRef/
  // setRailWidth and never restore document.body's cursor/userSelect, leaving the whole app
  // stuck with a resize cursor and unselectable text.
  useEffect(() => {
    return () => railDragCleanupRef.current?.();
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

  const closeAllTerminals = useCallback(() => {
    const dockApi = dockApiRef.current;
    if (!dockApi) return;
    for (const p of terminalPanelsOf(dockApi)) p.api.close();
  }, []);

  // Single useDeviceActions instance for the whole workspace — shared by the topology canvas (via
  // WorkspaceContext) and the device rail below, so right-clicking a device in either place means
  // exactly the same thing and there's one `pending`-files fetch / one action modal, not two.
  const deviceActions = useDeviceActions({
    labId,
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

  // A lab's lab.conf or startup scripts changed on disk outside the app, or its folder went away
  // (hooks/useLabEvents; the backend has already reloaded the lab, or says why it didn't). The
  // list refreshes for any lab whose topology was reloaded — its device count may have changed —
  // or whose folder is gone, which moves it to "missing" or off the list; the open lab also
  // reloads its detail (LabExplorer then follows lab.conf, with its own conflict check; a lab no
  // longer loaded lands on the not-found screen) or hands the changed startup scripts to the
  // device preview and the file editor.
  const [startupChange, setStartupChange] = useState<StartupChange | null>(null);
  useEffect(() => setStartupChange(null), [labId]);
  useLabEvents((event) => {
    const listChanged = event.kind === "conf-reloaded" || event.kind === "missing";
    if (listChanged) void reloadLabs();
    if (event.lab_id !== labId) return;
    const notice = labEventNotice(event);
    if (notice) toast.show(notice.message, notice.variant, "Changed on disk");
    if (listChanged) void load();
    if (event.kind === "startup") {
      void deviceActions.refreshStartups();
      setStartupChange((prev) => ({ paths: changedStartupPaths(event), seq: (prev?.seq ?? 0) + 1 }));
    }
  });

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

  const currentLab = useMemo(() => labs?.find((l) => l.id === labId) ?? null, [labs, labId]);
  const showLabList = !currentLab || labPickerOpen;

  async function handleDeployToggle(opts?: { skipImageCheck?: boolean }) {
    if (!detail) return;
    setDeployAction(detail.deployed ? "undeploy" : "deploy");
    try {
      await deployToggle(
        { id: detail.id, name: detail.name, deployed: detail.deployed, machines: detail.machines },
        setBusy,
        async () => {
          await load();
          await reloadLabs();
        },
        setDeployAction,
        opts,
      );
    } finally {
      setDeployAction(null);
    }
  }

  // After an elevation-triggered restart (see ElevationContext.tsx / services/desktop's
  // main.ts), the shell reloads straight into /workspace/<id>?resumeDeploy=1 — continue the
  // deploy the user was trying to do automatically instead of leaving them to notice the reload
  // finished and click Deploy again. Guarded by a ref, not just stripping the query param, so
  // this can only ever fire once per page load. `skipImageCheck: true` because the image
  // pre-check already ran (and was satisfied or explicitly skipped) before elevation was
  // requested — re-running it here would ask about the same images again, right after the user
  // just granted privileges.
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
      void handleDeployToggle({ skipImageCheck: true }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, searchParams, setSearchParams]);

  // The header buttons pass the open lab; the rail's context menu passes the right-clicked lab,
  // which may be a different one — in that case the open lab stays put. A managed lab is deleted
  // with its directory; a folder opened from elsewhere is the user's own, so it is only closed —
  // the backend refuses the other way round for each (see LabSummary.managed).
  async function handleRemove(lab: LabRef & { managed: boolean }) {
    const remove = lab.managed ? deleteLab : closeLab;
    await remove(lab, setBusy, async () => {
      await reloadLabs();
      if (localStorage.getItem(LS_LAST_LAB) === lab.id) localStorage.removeItem(LS_LAST_LAB);
      if (lab.id === labId) navigate("/workspace");
    });
  }

  // File → Open Lab Folder…, from the rail and the welcome screen. The shell picks the folder in
  // its own dialog and lands the window on the lab itself (services/desktop's openFolderAsLab), so
  // there is nothing to do here with the result. Desktop only: the browser build has no way to
  // hand the backend a folder it may trust.
  const openLabFolder = isDesktop()
    ? () => void desktop()?.openLabFolder().catch((e) => toast.reportError("Open lab folder", e))
    : undefined;

  async function handleRename(lab: LabRef) {
    await renameLab(lab, setBusy, async (renamed) => {
      await reloadLabs();
      if (localStorage.getItem(LS_LAST_LAB) === lab.id) localStorage.setItem(LS_LAST_LAB, renamed.id);
      // A rename moves the directory, and the id is derived from its path: follow the lab to its
      // new id, but only if it's the one currently open (the route still holds the old one).
      if (lab.id === labId) navigate(`/workspace/${encodeURIComponent(renamed.id)}`, { replace: true });
    });
  }

  // Undeploys every running lab (not just this one) — the labs themselves (lab.conf etc.) stay on
  // disk, so refresh the list + the currently open lab's deployed state rather than navigating away.
  async function handleWipeAll() {
    await wipeAll(labId || undefined, setBusy, async () => {
      await reloadLabs();
      await load();
    });
  }

  // Electron's native menu (File / Lab) drives the same handlers as the on-screen controls.
  // No-ops in the browser build. Deploy and Undeploy are separate menu items over one toggle,
  // so each checks the current state — otherwise "Deploy" on a running lab would tear it down.
  useDesktopCommand("lab:new", () => setShowNew(true));
  useDesktopCommand("lab:import", () => setShowUpload(true));
  useDesktopCommand("lab:browse", () => setShowGallery(true));
  useDesktopCommand("lab:deploy", () => {
    if (detail && !detail.deployed) void handleDeployToggle().catch(() => {});
  });
  useDesktopCommand("lab:undeploy", () => {
    if (detail?.deployed) void handleDeployToggle().catch(() => {});
  });
  useDesktopCommand("lab:reload", async () => {
    await load();
    await reloadLabs();
  });

  async function handleDownload(lab: LabRef) {
    await runBusy(setBusy, "Download lab", async () => {
      saveBlob(await api.downloadLab(lab.id), `${lab.name ?? lab.id}.zip`);
    });
  }

  // Right-click actions for a lab row in the rail. Acts on the clicked lab, which need not be the
  // one currently open.
  function openLabMenu(e: React.MouseEvent, lab: LabSummary) {
    e.preventDefault();
    // An opened folder that isn't loaded has nothing to rename, download or show: only Close.
    if (lab.problem) {
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: "Close",
            title: "Remove it from the list; the folder, if it is still somewhere, stays where it is",
            disabled: busy,
            action: () => void handleRemove(lab),
          },
        ],
      });
      return;
    }
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Rename…",
          disabled: busy || lab.deployed,
          title: lab.deployed ? "Undeploy the lab to rename it" : undefined,
          action: () => void handleRename(lab),
        },
        { label: "Download .zip", disabled: busy, action: () => void handleDownload(lab) },
        ...(isDesktop()
          ? [
              { label: "Show in File Manager", action: () => void desktop()?.revealLab(lab.id) },
              {
                label: "Open Terminal Here",
                action: () =>
                  void desktop()
                    ?.openTerminalHere(lab.id)
                    ?.catch((e) => toast.reportError("Open terminal", e)),
              },
            ]
          : []),
        lab.managed
          ? { label: "Delete…", danger: true, disabled: busy, action: () => void handleRemove(lab) }
          : {
              label: "Close",
              title: "Remove it from the list; the folder stays where it is",
              disabled: busy,
              action: () => void handleRemove(lab),
            },
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

  // Guards against the one-render window where the route's `labId` has already changed (e.g.
  // navigating back to /workspace after deleting the open lab) but `detail` still holds the
  // previous lab's data — that state only gets cleared in a later effect (below). Without this
  // check, the dock panels would briefly see a mismatched labId/detail pairing — e.g.
  // LabExplorer firing `getLabConf("")` at `/api/labs//lab-conf`.
  const currentDetail = detail && detail.id === labId ? detail : null;
  usePublishOpenLabName(currentDetail?.name ?? null);

  const ctxValue = currentDetail
    ? {
        labId,
        detail: currentDetail,
        selectedId,
        setSelectedId: selectNode,
        openFilesPanel,
        openTerminal,
        openRuntimeFsPanel,
        nodeInfoHost,
        setNodeInfoHost,
        deviceActions,
        setContextMenu: setCtxMenu,
      }
    : null;

  // Unlike `ctxValue` above (rebuilt fresh every render because it bundles the genuinely-volatile
  // `deviceActions`), every field here is independently stable across unrelated re-renders — so
  // `useMemo` actually keeps this object's identity stable for the tree-heavy Lab Configuration
  // and Runtime Filesystem panels, instead of them re-rendering on every unrelated workspace
  // interaction.
  const coreCtxValue = useMemo(
    () =>
      currentDetail
        ? {
            labId,
            detail: currentDetail,
            onRefresh: load,
            refreshStartups: deviceActions.refreshStartups,
            startupChange,
            runtimeFsPreferredMachine,
            setSelectedId,
            setContextMenu: setCtxMenu,
          }
        : null,
    [labId, currentDetail, load, deviceActions.refreshStartups, startupChange, runtimeFsPreferredMachine],
  );

  const runningMachines = deviceMachines.filter((m) => m.running);

  const layoutPresetItems = LAYOUT_PRESETS.map((preset) => (
    <Dropdown.Item key={preset.key} onClick={() => applyPreset(preset.key)}>
      {preset.label}
    </Dropdown.Item>
  ));

  function applyPreset(preset: LayoutPreset) {
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
        <aside className="kt-ws-rail" ref={railRef} data-tour="rail" style={{ flexBasis: railWidth }}>
          <div>
            <div className="kt-ws-rail-head">
              <span>Labs</span>
              <button className="kt-ws-collapse-btn" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={() => setRailOpen(false)}>
                <PanelLeftClose size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="d-flex gap-1 mb-2" data-tour="import-row" ref={importRowRef}>
              {compactImportRow ? (
                // DropdownButton's own `className` only reaches its outer wrapper, not the visible
                // toggle button (see react-bootstrap's DropdownButton source), so a plain w-100
                // there leaves the button itself content-sized — build it from Dropdown +
                // Dropdown.Toggle instead so the toggle can be widened directly, matching the
                // full-width "Wipe All Labs" button below it.
                <Dropdown className="w-100">
                  <Dropdown.Toggle size="sm" variant="primary" className="w-100">
                    <span className="d-inline-flex align-items-center gap-1">
                      <Plus size={14} />
                      Add Lab
                    </span>
                  </Dropdown.Toggle>
                  <Dropdown.Menu className="w-100">
                    <Dropdown.Item onClick={() => setShowNew(true)}>
                      <Plus size={14} className="me-2" />
                      New lab
                    </Dropdown.Item>
                    {openLabFolder && (
                      <Dropdown.Item onClick={openLabFolder}>
                        <FolderOpen size={14} className="me-2" />
                        Open lab folder
                      </Dropdown.Item>
                    )}
                    <Dropdown.Item onClick={() => setShowUpload(true)}>
                      <Upload size={14} className="me-2" />
                      Upload lab
                    </Dropdown.Item>
                    <Dropdown.Item onClick={() => setShowGallery(true)}>
                      <Globe size={14} className="me-2" />
                      Browse Kathara-Labs
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="primary"
                    className="flex-fill"
                    onClick={() => setShowNew(true)}
                    title="Create a new empty lab from scratch"
                  >
                    <Plus size={14} className="me-1" />
                    New
                  </Button>
                  {openLabFolder && (
                    <Button
                      size="sm"
                      variant="outline-secondary"
                      className="flex-fill"
                      onClick={openLabFolder}
                      title="Open a folder anywhere on your computer as a lab, where it is"
                    >
                      <FolderOpen size={14} className="me-1" />
                      Open
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    className="flex-fill"
                    onClick={() => setShowUpload(true)}
                    title="Upload a lab from a .zip archive or folder on your computer"
                  >
                    <Upload size={14} className="me-1" />
                    Upload
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    className="flex-fill"
                    onClick={() => setShowGallery(true)}
                    title="Browse and import a ready-made lab from the Kathara-Labs gallery"
                  >
                    <Globe size={14} className="me-1" />
                    Browse
                  </Button>
                </>
              )}
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
                title="Force-undeploys every lab running in kathara-desktop, not just this one"
              >
                <Trash2 size={14} className="me-1" />
                Wipe All Labs
              </Button>
            )}
            {showLabList ? (
              <>
                <Form.Control
                  size="sm"
                  type="search"
                  placeholder="Filter labs…"
                  value={labFilter}
                  onChange={(e) => setLabFilter(e.target.value)}
                  className="mb-2"
                />
                <div className="kt-ws-list">
                  {labs == null && labsError ? (
                    <div className="kt-ws-error">
                      <AlertTriangle size={15} className="kt-ws-error-icon" />
                      <p className="kt-ws-error-text">{labsError}</p>
                      <Button
                        variant="outline-danger"
                        size="sm"
                        className="kt-ws-error-retry"
                        onClick={() => void reloadLabs()}
                      >
                        <RefreshCw size={13} className="me-1" />
                        Retry
                      </Button>
                    </div>
                  ) : labs == null ? (
                    <div className="kt-ws-muted">Loading…</div>
                  ) : filteredLabs && filteredLabs.length === 0 ? (
                    <div className="kt-ws-muted">{labs.length === 0 ? "No labs yet." : "No matches."}</div>
                  ) : (
                    filteredLabs?.map((l) => (
                      <button
                        key={l.id}
                        className={`kt-ws-row ${l.id === labId ? "active" : ""} ${l.problem ? "kt-ws-row--problem" : ""}`}
                        onClick={() => {
                          if (l.problem) {
                            toast.show(
                              `"${l.name || "(unnamed)"}" ${PROBLEM_EXPLANATION[l.problem] ?? "isn't loaded."}`,
                              "info",
                            );
                          } else if (l.id === labId) {
                            setLabPickerOpen(false);
                          } else {
                            navigate(`/workspace/${encodeURIComponent(l.id)}`);
                          }
                        }}
                        onContextMenu={(e) => openLabMenu(e, l)}
                        title={
                          (l.id === labId
                            ? `${l.name || "(unnamed)"} — click to hide other labs · right-click for actions`
                            : `${l.name || "(unnamed)"} — click to open · right-click for actions`) +
                          (!l.managed && l.path ? `\n${l.path}` : "")
                        }
                      >
                        <span className={`kt-ws-dot ${l.deployed ? "running" : "stopped"}`} />
                        <LabRowLabel lab={l} />
                        <span className="kt-ws-row-meta">{l.n_machines}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              currentLab && (
                <>
                  <div className="kt-ws-list">
                    <div
                      className="kt-ws-row kt-ws-row--static"
                      onContextMenu={(e) => openLabMenu(e, currentLab)}
                      title={!currentLab.managed && currentLab.path ? currentLab.path : undefined}
                    >
                      <span className={`kt-ws-dot ${currentLab.deployed ? "running" : "stopped"}`} />
                      <LabRowLabel lab={currentLab} />
                      <span className="kt-ws-row-meta">{currentLab.n_machines}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    className="w-100 mt-2"
                    onClick={() => setLabPickerOpen(true)}
                  >
                    <List size={14} className="me-1" />
                    Select other labs
                  </Button>
                </>
              )
            )}
          </div>

          {detail && (
            <div>
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
                      onClick={() => selectNode(`dev:${m.name}`)}
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
                        onClick={() => selectNode(`cd:${lk.name}`)}
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
          <PanelLeftOpen size={16} aria-hidden="true" />
        </button>
      )}

      <div className="kt-ws-main">
        <header className="kt-ws-header" ref={headerRef}>
          {detail ? (
            <>
              <h5
                className="mb-0 me-1 text-truncate"
                style={{ cursor: "pointer", minWidth: 0 }}
                title={
                  detail.deployed
                    ? "Undeploy the lab to rename it"
                    : `${detail.name || "(unnamed)"} — click to rename`
                }
                onClick={() => {
                  if (detail.deployed) {
                    toast.show("Undeploy the lab to rename it.", "info");
                    return;
                  }
                  void handleRename(detail);
                }}
              >
                {detail.name || "(unnamed)"}
              </h5>
              <Badge bg={detail.deployed ? "success" : "secondary"} className="flex-shrink-0">
                {detail.deployed ? "deployed" : "undeployed"}
              </Badge>
              {detail.machines.some((m) => m.privileged) && (
                <Badge
                  bg="warning"
                  text="dark"
                  className="d-flex align-items-center gap-1 flex-shrink-0"
                  title="This lab has privileged devices — deploying it requires administrator privileges."
                >
                  <ShieldAlert size={12} />
                  privileged
                </Badge>
              )}
              <div className="ms-auto d-flex gap-2 flex-shrink-0">
                {compactActions ? (
                  <>
                    <DropdownButton
                      size="sm"
                      variant="outline-secondary"
                      title={
                        <span className="d-inline-flex align-items-center gap-1">
                          <MoreHorizontal size={16} />
                          Menu
                        </span>
                      }
                      align="end"
                    >
                      <Dropdown.Header>Terminals</Dropdown.Header>
                      {runningMachines.length ? (
                        runningMachines.map((m) => (
                          <Dropdown.Item key={m.name} onClick={() => openTerminal(m.name)}>
                            Open terminal: {m.name}
                          </Dropdown.Item>
                        ))
                      ) : (
                        <Dropdown.Item disabled>No running devices</Dropdown.Item>
                      )}
                      <Dropdown.Item onClick={closeAllTerminals}>Close All Terminals</Dropdown.Item>
                      <Dropdown.Divider />
                      <Dropdown.Header>Layout</Dropdown.Header>
                      {layoutPresetItems}
                      <Dropdown.Divider />
                      <Dropdown.Header>Lab</Dropdown.Header>
                      <Dropdown.Item disabled={busy} onClick={() => void handleDeployToggle().catch(() => {})}>
                        {deployButtonLabel(deployAction, detail.deployed)}
                      </Dropdown.Item>
                      <Dropdown.Item disabled={busy} onClick={() => void handleDownload(detail)}>
                        Download
                      </Dropdown.Item>
                      <Dropdown.Item
                        className={detail.managed ? "text-danger" : undefined}
                        disabled={busy}
                        onClick={() => void handleRemove(detail)}
                      >
                        {detail.managed ? "Delete" : "Close"}
                      </Dropdown.Item>
                    </DropdownButton>
                    {/* Kept in the DOM (display:none, so zero-size) rather than omitted: the
                        onboarding tour looks these up by data-tour and already treats a zero-size
                        target as "skip to next step" (see OnboardingTour.tsx), so a tour run at a
                        narrow width steps past them instead of getting stuck on a selector that
                        matches nothing. */}
                    <span data-tour="terminal-btn" style={{ display: "none" }} />
                    <span data-tour="layout-btn" style={{ display: "none" }} />
                    <span data-tour="deploy-btn" style={{ display: "none" }} />
                    <span data-tour="download-btn" style={{ display: "none" }} />
                    <span data-tour="delete-btn" style={{ display: "none" }} />
                  </>
                ) : (
                  <>
                    <span data-tour="terminal-btn" className="d-inline-flex">
                      <DropdownButton
                        size="sm"
                        variant="outline-secondary"
                        title={
                          <>
                            <SquareTerminal size={14} className="me-1" />
                            Terminal
                          </>
                        }
                        disabled={!runningMachines.length}
                      >
                        {runningMachines.map((m) => (
                          <Dropdown.Item key={m.name} onClick={() => openTerminal(m.name)}>
                            {m.name}
                          </Dropdown.Item>
                        ))}
                      </DropdownButton>
                    </span>
                    <Button size="sm" variant="outline-secondary" onClick={closeAllTerminals}>
                      <SquareX size={14} className="me-1" />
                      Close All Terminals
                    </Button>
                    <span data-tour="layout-btn" className="d-inline-flex">
                      <DropdownButton
                        size="sm"
                        variant="outline-secondary"
                        title={
                          <>
                            <LayoutGrid size={14} className="me-1" />
                            Layout
                          </>
                        }
                      >
                        {layoutPresetItems}
                      </DropdownButton>
                    </span>
                    <span data-tour="deploy-btn" className="d-inline-flex">
                      <Button
                        size="sm"
                        variant={detail.deployed ? "warning" : "primary"}
                        disabled={busy}
                        onClick={() => void handleDeployToggle().catch(() => {})}
                        className="d-flex align-items-center gap-1"
                      >
                        {deployAction ? (
                          <Loader2 size={14} className="kt-explorer-spin" />
                        ) : detail.deployed ? (
                          <Square size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {deployButtonLabel(deployAction, detail.deployed)}
                      </Button>
                    </span>
                    <span data-tour="download-btn" className="d-inline-flex">
                      <Button
                        size="sm"
                        variant="outline-secondary"
                        disabled={busy}
                        onClick={() => void handleDownload(detail)}
                      >
                        <Download size={14} className="me-1" />
                        Download
                      </Button>
                    </span>
                    <span data-tour="delete-btn" className="d-inline-flex">
                      {detail.managed ? (
                        <Button size="sm" variant="outline-danger" disabled={busy} onClick={() => void handleRemove(detail)}>
                          <Trash2 size={14} className="me-1" />
                          Delete
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline-secondary"
                          disabled={busy}
                          onClick={() => void handleRemove(detail)}
                          title="Remove it from the list; the folder stays where it is"
                        >
                          <X size={14} className="me-1" />
                          Close
                        </Button>
                      )}
                    </span>
                  </>
                )}
              </div>
            </>
          ) : (
            <h5 className="mb-0 kt-ws-muted">
              {notFound ? "Lab not found" : labId && detailError ? "Couldn't load this lab" : "No lab selected"}
            </h5>
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
                This lab was not found. It may have been deleted, renamed or moved.
              </p>
              <Button size="sm" variant="outline-secondary" onClick={() => navigate("/workspace")}>
                <X size={14} className="me-1" />
                Clear Selection
              </Button>
            </div>
          ) : labId && detailError ? (
            <div className="kt-ws-empty">
              <p className="kt-ws-muted">{detailError}</p>
              <Button size="sm" variant="outline-secondary" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : showWelcome ? (
            <WelcomeScreen
              onNewLab={() => setShowNew(true)}
              onImportLab={() => setShowUpload(true)}
              onBrowseGallery={() => setShowGallery(true)}
              onOpenFolder={openLabFolder}
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
          labId={labId}
          machine={optionsEditorMachine ? detail.machines.find((m) => m.name === optionsEditorMachine) ?? null : null}
          deployed={detail.deployed}
          onClose={closeOptionsEditor}
          onSaved={load}
        />
      )}
      {detail && (
        <AddDeviceModal
          show={addDeviceLink.show}
          labId={labId}
          prefillLink={addDeviceLink.prefillLink}
          onClose={closeAddDeviceModal}
          onAdded={load}
        />
      )}

      <NewLabModal show={showNew} onClose={() => setShowNew(false)} onCreated={handleLabCreated} />
      <UploadLabModal show={showUpload} onClose={() => setShowUpload(false)} onCreated={handleLabCreated} />
      <GalleryModal show={showGallery} onClose={() => setShowGallery(false)} onCreated={handleLabCreated} />
    </div>
  );
}
