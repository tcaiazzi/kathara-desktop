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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dropdown, DropdownButton, Form } from "react-bootstrap";
import { useNavigate, useParams } from "react-router-dom";
import { DevicesTable } from "../components/DevicesTable";
import { LabExplorer } from "../components/LabExplorer";
import { LinksTable } from "../components/LinksTable";
import { MachineOptionsEditor } from "../components/MachineOptionsEditor";
import { NewLabModal } from "../components/NewLabModal";
import { RuntimeFilesystemEditor } from "../components/RuntimeFilesystemEditor";
import { StatsPanel } from "../components/StatsPanel";
import { TerminalPanel } from "../components/TerminalPanel";
import { TopologyActionModal } from "../components/TopologyActionModal";
import { TopologyContextMenu, type ContextMenuState } from "../components/TopologyContextMenu";
import { TopologyGraph } from "../components/TopologyGraph";
import { UploadLabModal } from "../components/UploadLabModal";
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

// A "Focus …" preset collapses the other groups to (about) their header height/width rather than
// hiding them; clicking a collapsed group's header restores it to a usable height.
const COLLAPSED_GROUP_HEIGHT = 35;
const COLLAPSED_GROUP_WIDTH = 44;
const RESTORE_GROUP_HEIGHT = 280;
// A group at/under this height is considered collapsed (header strip only).
const COLLAPSE_THRESHOLD = 60;

// Fraction of the total width the topology column gets when it's first split off from the left
// tab group — matches the shipped default screenshot (topology noticeably wider than the tabs).
const TOPOLOGY_WIDTH_FRACTION = 0.62;

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

// Collapse every group NOT in `keep` to a header strip, in place (no moving/swapping panels).
// Groups stacked above/below the union of the kept groups collapse their height; groups
// side-by-side collapse their width. Resize-only, so terminal sessions survive; each collapsed
// group reopens via its own header chevron (or Layout → Default).
function collapseOthers(api: DockviewApi, keep: Set<DockviewGroupPanel>) {
  const rects = [...keep].map((g) => g.element.getBoundingClientRect());
  const target = {
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  for (const g of api.groups) {
    if (keep.has(g)) continue;
    const r = g.element.getBoundingClientRect();
    const sameRow = r.top < target.bottom - 4 && r.bottom > target.top + 4; // vertical overlap → side-by-side
    if (sameRow) {
      g.api.setConstraints({ minimumWidth: COLLAPSED_GROUP_WIDTH });
      g.api.setSize({ width: COLLAPSED_GROUP_WIDTH });
    } else {
      g.api.setConstraints({ minimumHeight: COLLAPSED_GROUP_HEIGHT });
      g.api.setSize({ height: COLLAPSED_GROUP_HEIGHT });
    }
  }
}

// Maximize a single group in place — used by the per-panel header's "Maximize panel" button.
function maximizeGroup(api: DockviewApi, group: DockviewGroupPanel) {
  collapseOthers(api, new Set([group]));
}

// --- Preset layouts (reposition existing panels via moveTo — no unmount, so terminal sessions
// survive). All are no-ops when there's nothing to arrange. ---
const terminalPanelsOf = (api: DockviewApi) => api.panels.filter((p) => p.id.startsWith("terminal:"));

// All open terminals tiled into a roughly-square grid (tmux-like).
function tileTerminals(api: DockviewApi) {
  const terms = terminalPanelsOf(api);
  if (terms.length < 2) return;
  const cols = Math.ceil(Math.sqrt(terms.length));
  let rowStart = terms[0].api.group;
  let prev = rowStart;
  for (let i = 1; i < terms.length; i++) {
    const p = terms[i];
    if (i % cols === 0) {
      p.api.moveTo({ group: rowStart, position: "bottom" as const });
      rowStart = p.api.group;
      prev = rowStart;
    } else {
      p.api.moveTo({ group: prev, position: "right" as const });
      prev = p.api.group;
    }
  }
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
  topo.api.group.api.moveTo({ group: devices.api.group, position: "right" as const });
  // Undo any collapse pinning left by a "Focus …" preset, on every group (not just tools) — any of
  // them can end up shrunk depending on which preset ran last.
  for (const g of api.groups) {
    g.api.setConstraints({ minimumHeight: 100, minimumWidth: 100 });
  }
  topo.api.group.api.setSize({ width: Math.round(api.width * TOPOLOGY_WIDTH_FRACTION) });
  devices.api.setActive();
}

// Topology takes almost the whole screen; the tool panels and the node-info inspector collapse to
// a strip.
function focusTopology(api: DockviewApi) {
  const topo = api.getPanel("topology");
  if (!topo) return;
  collapseOthers(api, new Set([topo.api.group]));
  topo.api.setActive();
}

// The Files panel takes most of the screen (writing lab.conf/startup scripts); topology, its
// inspector, and any open terminals collapse out of the way.
function focusEditing(api: DockviewApi) {
  const files = api.getPanel("files");
  if (!files) return;
  files.api.setActive();
  collapseOthers(api, new Set([files.api.group]));
}

// All open terminals tiled into a grid taking most of the screen; everything else collapses.
// No-op if none are open (open one via "+ Terminal" first).
function focusTerminals(api: DockviewApi) {
  const terms = terminalPanelsOf(api);
  if (!terms.length) return;
  tileTerminals(api); // arrange them among themselves first
  // Re-fetch: tiling just moved them into new groups.
  const groups = new Set(terminalPanelsOf(api).map((p) => p.api.group));
  collapseOthers(api, groups);
  terms[0].api.setActive();
}

// Experimental integrated "IDE" view: left rail (labs + devices) + a dockview panel area (topology,
// devices, files, runtime-fs, terminals, stats) whose layout can be freely rearranged by dragging.
export function WorkspacePage() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const ktTheme = useKtTheme();
  const { deployToggle, deleteLab, renameLab, wipeAll } = useLabLifecycleActions();

  const [labs, setLabs] = useState<LabSummary[] | null>(null);
  const [labFilter, setLabFilter] = useState("");
  const [detail, setDetail] = useState<LabDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const load = useCallback(async () => {
    if (!name) {
      setDetail(null);
      setNotFound(false);
      return;
    }
    try {
      setDetail(await api.getLab(name));
      setNotFound(false);
    } catch (e) {
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
    const last = localStorage.getItem(LS_LAST_LAB);
    if (last && labs.some((l) => l.name === last)) {
      navigate(`/workspace/${encodeURIComponent(last)}`, { replace: true });
    }
  }, [labs, name, navigate]);

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
  });
  const { deviceContextItems, findDeviceNode, actionConfig, setActionConfig } = deviceActions;

  // Close terminal panels whose device no longer exists in the lab (matches the old grid behavior).
  useEffect(() => {
    const dockApi = dockApiRef.current;
    if (!dockApi || !detail) return;
    const existing = new Set(detail.machines.map((m) => m.name));
    for (const p of dockApi.panels) {
      if (!p.id.startsWith("terminal:")) continue;
      const machine = (p.params as { machine?: string } | undefined)?.machine;
      if (machine && !existing.has(machine)) p.api.close();
    }
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
    event.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(LS_LAYOUT, JSON.stringify(event.api.toJSON()));
      } catch {
        /* ignore quota/serialization errors */
      }
    });
  }, []);

  const filteredLabs = useMemo(() => {
    if (!labs) return labs;
    const q = labFilter.trim().toLowerCase();
    if (!q) return labs;
    return labs.filter((l) => (l.name ?? "").toLowerCase().includes(q));
  }, [labs, labFilter]);

  async function handleDeployToggle() {
    if (!detail) return;
    await deployToggle({ name, deployed: detail.deployed }, setBusy, async () => {
      await load();
      await reloadLabs();
    });
  }

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
    await wipeAll(setBusy, async () => {
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
                          ⌨
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
                        title="Select in topology"
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
              <Badge bg={detail.deployed ? "success" : "secondary"}>{detail.deployed ? "deployed" : "defined"}</Badge>
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
                <Button size="sm" variant={detail.deployed ? "outline-warning" : "primary"} disabled={busy} onClick={handleDeployToggle}>
                  {detail.deployed ? "Undeploy" : "Deploy"}
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
          ) : (
            <div className="kt-ws-empty">
              {notFound ? (
                <>
                  <p className="kt-ws-muted">
                    Lab <code>{name}</code> was not found.
                  </p>
                  <Button size="sm" variant="outline-secondary" onClick={() => navigate("/workspace")}>
                    Clear selection
                  </Button>
                </>
              ) : (
                <p className="kt-ws-muted">Select a lab from the left, or create one to get started.</p>
              )}
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

      <NewLabModal
        show={showNew}
        onClose={() => setShowNew(false)}
        onCreated={(n) => {
          reloadLabs();
          navigate(`/workspace/${encodeURIComponent(n)}`);
        }}
      />
      <UploadLabModal
        show={showUpload}
        onClose={() => setShowUpload(false)}
        onCreated={(n) => {
          reloadLabs();
          navigate(`/workspace/${encodeURIComponent(n)}`);
        }}
      />
    </div>
  );
}
