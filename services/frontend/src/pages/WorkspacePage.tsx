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
import { NewLabModal } from "../components/NewLabModal";
import { RuntimeFilesystemEditor } from "../components/RuntimeFilesystemEditor";
import { StatsPanel } from "../components/StatsPanel";
import { TerminalPanel } from "../components/TerminalPanel";
import { TopologyActionModal } from "../components/TopologyActionModal";
import { TopologyContextMenu, type ContextMenuState } from "../components/TopologyContextMenu";
import { TopologyGraph } from "../components/TopologyGraph";
import { UploadLabModal } from "../components/UploadLabModal";
import { WorkspaceProvider, useWorkspace } from "../context/WorkspaceContext";
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
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel">
      <LabExplorer labName={ws.labName} detail={ws.detail} onStructuralChange={ws.onRefresh} />
    </div>
  );
}
function RuntimeFsPanel() {
  const ws = useWorkspace();
  return (
    <div className="kt-ws-panel">
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

// Tab renderer without a close button — used for the fixed core panels so they can't be closed
// (only on-demand terminal panels, which use the default closable tab, can be).
function FixedTab(props: IDockviewPanelHeaderProps) {
  return <DockviewDefaultTab {...props} hideClose />;
}
const DOCK_TAB_COMPONENTS = { fixed: FixedTab };

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

// v4: node info moved out of the topology into its own closable "Node info" dock panel; ignore
// older saved layouts (v3 core tabs, v2 closable core tabs, v1 removed "terminals" panel) so the
// fresh default (which includes node-info) applies.
const LS_LAYOUT = "kt-ws-layout-v4";
const LS_RAIL = "kt-ws-rail-open";
const LS_RAIL_W = "kt-ws-rail-width";
const LS_LAST_LAB = "kt-ws-last-lab";

// Left explorer (rail) resize bounds.
const RAIL_MIN_W = 180;
const RAIL_MAX_W = 560;
const RAIL_DEFAULT_W = 264;

// "Maximize topology" collapses the other groups to (about) their header height rather than hiding
// them; clicking a collapsed group's header restores it to a usable height.
const COLLAPSED_GROUP_HEIGHT = 35;
const COLLAPSED_GROUP_WIDTH = 44;
const RESTORE_GROUP_HEIGHT = 280;
// A group at/under this height is considered collapsed (header strip only).
const COLLAPSE_THRESHOLD = 60;

function buildDefaultLayout(api: DockviewApi) {
  api.addPanel({ id: "topology", component: "topology", title: "Topology", tabComponent: "fixed" });
  api.addPanel({ id: "devices", component: "devices", title: "Devices", tabComponent: "fixed", position: { referencePanel: "topology", direction: "below" } });
  api.addPanel({ id: "files", component: "files", title: "Files", tabComponent: "fixed", position: { referencePanel: "devices", direction: "within" } });
  api.addPanel({ id: "runtime-fs", component: "runtime-fs", title: "Runtime FS", tabComponent: "fixed", position: { referencePanel: "devices", direction: "within" } });
  api.addPanel({ id: "stats", component: "stats", title: "Stats", tabComponent: "fixed", position: { referencePanel: "devices", direction: "within" } });
  // Node info: a closable panel to the right of the topology (drag it anywhere; close it to give the
  // topology the full width).
  api.addPanel({ id: "node-info", component: "node-info", title: "Node info", position: { referencePanel: "topology", direction: "right" } });
  api.getPanel("devices")?.api.setActive();
}

// Re-open the Node info panel if it was closed (right of the topology). No-op if it already exists.
function showNodeInfo(api: DockviewApi) {
  if (api.getPanel("node-info")) {
    api.getPanel("node-info")?.api.setActive();
    return;
  }
  const topo = api.getPanel("topology");
  api.addPanel({
    id: "node-info",
    component: "node-info",
    title: "Node info",
    position: topo ? { referencePanel: "topology", direction: "right" } : undefined,
  });
}

// Maximize a group **in place**: the group fills, every other group collapses to a header strip
// where it already sits (no moving/swapping). Groups stacked above/below the target collapse their
// height; groups side-by-side collapse their width. Resize-only, so terminal sessions survive; each
// collapsed group reopens via its own header chevron (or Layout → Reset).
function maximizeGroup(api: DockviewApi, group: DockviewGroupPanel) {
  const target = group.element.getBoundingClientRect();
  for (const g of api.groups) {
    if (g === group) continue;
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

// --- Preset layouts (reposition existing panels via moveTo — no unmount, so terminal sessions
// survive). All are no-ops when there's nothing to arrange. ---
const terminalPanelsOf = (api: DockviewApi) => api.panels.filter((p) => p.id.startsWith("terminal:"));

// All open terminals as tabs in a single group.
function stackTerminals(api: DockviewApi) {
  const terms = terminalPanelsOf(api);
  if (terms.length < 2) return;
  const target = terms[0].api.group;
  for (const p of terms.slice(1)) p.api.moveTo({ group: target });
}

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

// Best-effort default arrangement without unmounting anything: topology on top, the tool panels
// stacked below, and all terminals grouped to the right of the topology.
function resetLayout(api: DockviewApi) {
  const topo = api.getPanel("topology");
  const devices = api.getPanel("devices");
  if (!topo || !devices) return;
  for (const id of ["files", "runtime-fs", "stats"]) {
    api.getPanel(id)?.api.moveTo({ group: devices.api.group });
  }
  devices.api.group.api.moveTo({ group: topo.api.group, position: "bottom" as const });
  const terms = terminalPanelsOf(api);
  if (terms.length) {
    // Extract the first terminal into a fresh group right of topology (this pulls it out even if it
    // was merged with the tools group, e.g. after "Maximize topology"), then gather the rest into it.
    terms[0].api.moveTo({ group: topo.api.group, position: "right" as const });
    const tg = terms[0].api.group;
    for (const p of terms.slice(1)) p.api.moveTo({ group: tg });
  }
  // Undo any collapse/maximize pinning: give the tools group a normal height (topology fills the
  // rest) and clear the tiny min-height so nothing stays stuck as a header strip.
  const toolsGroupApi = api.getPanel("devices")?.api.group.api;
  toolsGroupApi?.setConstraints({ minimumHeight: 100 });
  toolsGroupApi?.setSize({ height: RESTORE_GROUP_HEIGHT });
  // Reset shouldn't leave the inspector hidden — bring it back if it was closed.
  if (!api.getPanel("node-info")) showNodeInfo(api);
}

// Experimental integrated "IDE" view: left rail (labs + devices) + a dockview panel area (topology,
// devices, files, runtime-fs, terminals, stats) whose layout can be freely rearranged by dragging.
export function WorkspacePage() {
  const { name = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const ktTheme = useKtTheme();
  const { deployToggle, deleteLab, wipeAll } = useLabLifecycleActions();

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
    const topology = dockApi.getPanel("topology");
    dockApi.addPanel({
      id: `terminal:${machine}:${num}`,
      component: "terminal",
      title: `${machine} #${num}`,
      params: { machine },
      // Group with existing terminals (as tabs) if any; else split to the right of the topology;
      // else just drop into a new/active group.
      position: existingTerminal
        ? { referenceGroup: existingTerminal.group, direction: "within" }
        : topology
          ? { referencePanel: "topology", direction: "right" }
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

  async function handleDelete() {
    await deleteLab(name, setBusy, async () => {
      await reloadLabs();
      navigate("/workspace");
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

  async function handleDownload() {
    try {
      saveBlob(await api.downloadLab(name), `${name}.zip`);
    } catch (e) {
      toast.reportError("Download lab", e);
    }
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

  const runningMachines = deviceMachines.filter((m) => m.running);

  function applyPreset(preset: "reset" | "tile" | "stack" | "maximize" | "node-info") {
    const dockApi = dockApiRef.current;
    if (!dockApi) return;
    if (preset === "reset") {
      resetLayout(dockApi);
    } else if (preset === "tile") {
      tileTerminals(dockApi);
    } else if (preset === "stack") {
      stackTerminals(dockApi);
    } else if (preset === "node-info") {
      showNodeInfo(dockApi);
    } else if (preset === "maximize") {
      const topo = dockApi.getPanel("topology");
      if (topo) {
        maximizeGroup(dockApi, topo.api.group);
        topo.api.setActive();
      }
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
              title="kathara wipe — force-undeploys every running lab, not just this one"
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
                    title={l.name ?? ""}
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
              <h5 className="mb-0 me-1">{detail.name || "(unnamed)"}</h5>
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
                  <Dropdown.Item onClick={() => applyPreset("node-info")}>Show node info</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("reset")}>Reset layout</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("tile")}>Tile terminals</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("stack")}>Stack terminals</Dropdown.Item>
                  <Dropdown.Item onClick={() => applyPreset("maximize")}>Maximize topology</Dropdown.Item>
                </DropdownButton>
                <Button size="sm" variant={detail.deployed ? "outline-warning" : "primary"} disabled={busy} onClick={handleDeployToggle}>
                  {detail.deployed ? "Undeploy" : "Deploy"}
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={handleDownload}>
                  Download
                </Button>
                <Button size="sm" variant="outline-danger" disabled={busy} onClick={handleDelete}>
                  Delete
                </Button>
              </div>
            </>
          ) : (
            <h5 className="mb-0 kt-ws-muted">{notFound ? `Lab "${name}" not found` : "No lab selected"}</h5>
          )}
        </header>

        <div className="kt-ws-dockarea">
          {ctxValue ? (
            <WorkspaceProvider value={ctxValue}>
              <DockviewReact
                components={DOCK_COMPONENTS}
                tabComponents={DOCK_TAB_COMPONENTS}
                rightHeaderActionsComponent={GroupHeaderActions}
                onReady={onDockReady}
                theme={ktTheme === "dark" ? themeDark : themeLight}
              />
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
