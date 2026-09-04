import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, DropdownButton } from "react-bootstrap";
import {
  AppWindow,
  FileEdit,
  FolderOpen,
  MoreHorizontal,
  Plug,
  SlidersHorizontal,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import type { UseDeviceActions } from "../hooks/useDeviceActions";
import { useForceLayout, type NodePositions } from "../hooks/useForceLayout";
import { api } from "../services/api";
import { machineStartupText } from "../services/labfs";
import { CATEGORY_ICON, CATEGORY_LABEL, type DeviceCategory } from "../services/deviceIcon";
import { deviceStateLabel, formatIface, formatPort } from "../services/topology";
import type { LabDetail, StartupStatus } from "../services/types";
import "./TopologyGraph.css";
import type { ContextMenuState } from "./TopologyContextMenu";

// Device/domain actions (deploy, remove, add/remove interface, open a terminal, …) and the
// context-menu item lists live in useDeviceActions — a single instance owned by the workspace page
// (shared with the sidebar's device list, so a right-click means the same thing in both places, and
// there's one startup-scripts fetch / one action modal instead of two hand-synced copies).
type DeviceActionsProps = Pick<
  UseDeviceActions,
  | "model"
  | "startups"
  | "deviceContextItems"
  | "domainContextItems"
  | "openAddDevice"
  | "openAddDomain"
  | "openAddInterface"
  | "openConnectExisting"
  | "openDisconnect"
  | "openRuntimeFs"
  | "openOptions"
  | "openTerminalPopup"
  | "openWorkspaceTerminal"
  | "machineNames"
>;

interface TopologyGraphProps extends DeviceActionsProps {
  labName: string;
  detail: LabDetail;
  onEditFiles: () => void;
  // Shows/dismisses the shared context menu (rendered once by the workspace page).
  setContextMenu: (menu: ContextMenuState | null) => void;
  // Optional controlled selection (node id `dev:<name>` / `cd:<name>`). When provided, an external
  // list (e.g. the Workspace rail) can drive/read the selected node. Omit for internal selection —
  // the classic tabbed page passes neither and behaves exactly as before.
  selectedId?: string | null;
  onSelectId?: (id: string | null) => void;
  // DOM node of the "Node info" dock panel. When set, the inspector is portaled into it (so it can
  // be dragged/closed like any dock panel); when null (panel closed) the inspector is hidden and the
  // canvas takes the full width.
  nodeInfoHost?: HTMLElement | null;
}

// Two-column key/value row used throughout the Node-Info panel below.
function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

// Do two position maps describe the same layout? Coordinates are compared as integers (that is what
// the engine reports and what is stored), so a sub-pixel drift never marks the layout as unsaved.
function samePositions(a: NodePositions, b: NodePositions | null): boolean {
  if (!b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (id) => b[id] && Math.round(a[id].x) === Math.round(b[id].x) && Math.round(a[id].y) === Math.round(b[id].y),
  );
}

// Below this canvas width, each toolbar collapses from its row of buttons into a single "more
// actions" dropdown (see the ResizeObserver effect below) — the panel is user-resizable (dockview),
// so the buttons must react to it shrinking, not just the browser window.
const TOOLBAR_COMPACT_WIDTH = 480;

// Force-directed SVG topology graph (device + collision-domain nodes, edges = interfaces), no
// charting library. The simulation/render loop manipulates SVG DOM attributes directly every
// animation frame rather than going through React state: dozens of position updates per second
// per node is not a good fit for React re-renders. React only owns the low-frequency parts: the
// side panel and (via the setContextMenu/deviceContextItems props) the context menu.
export function TopologyGraph({
  labName,
  detail,
  onEditFiles,
  model,
  startups,
  deviceContextItems,
  domainContextItems,
  openAddDevice,
  openAddDomain,
  openAddInterface,
  openConnectExisting,
  openDisconnect,
  openRuntimeFs,
  openOptions,
  openTerminalPopup,
  openWorkspaceTerminal,
  machineNames,
  setContextMenu,
  selectedId: controlledSelectedId,
  onSelectId,
  nodeInfoHost,
}: TopologyGraphProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;
  const setSelectedId = onSelectId ?? setInternalSelectedId;
  const [showIps, setShowIps] = useState(() => localStorage.getItem("kt-topo-ips") !== "false");
  const [relayoutNonce, setRelayoutNonce] = useState(0);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [compactToolbar, setCompactToolbar] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  // Distinct device categories present (for a legend that only lists what's on screen) + whether any
  // device is bridged.
  const legend = useMemo(() => {
    const cats = new Set<DeviceCategory>();
    let bridged = false;
    for (const n of model.nodes) {
      if (n.type !== "dev") continue;
      cats.add(n.category);
      if (n.bridged) bridged = true;
    }
    return { categories: [...cats], bridged };
  }, [model]);

  // Node positions come from two places: the lab's *fixed* layout (its `lab.layout` file, shared
  // with anyone who opens the lab) and a per-browser draft in localStorage holding not-yet-saved
  // moves. The draft wins while it exists; "Save layout" promotes it to the file and "Re-layout"
  // throws it away — falling back to the fixed layout when the lab has one.
  const draftKey = `kt-topo-pos:${labName}`;
  const readDraft = useCallback((): NodePositions => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) || "{}") as NodePositions;
    } catch {
      return {};
    }
  }, [draftKey]);
  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  }, [draftKey]);

  const [savedLayout, setSavedLayout] = useState<NodePositions | null>(null);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [savingLayout, setSavingLayout] = useState(false);
  // Latest positions reported by the engine — what "Save layout" writes to the lab directory.
  const livePositions = useRef<NodePositions>({});
  const [dirty, setDirty] = useState(false);
  const runBusy = useBusyAction();

  // Fetch the lab's fixed layout. It can land after the engine's first build, so bump a nonce to
  // make the graph rebuild against it (the engine effect reads seeds through a ref).
  useEffect(() => {
    if (!labName) return;
    let live = true;
    setSavedLayout(null);
    api
      .getLayout(labName)
      .then((l) => {
        if (!live) return;
        setSavedLayout(l.nodes);
        if (Object.keys(l.nodes).length) setLayoutNonce((v) => v + 1);
      })
      .catch((e) => {
        if (!live) return;
        toast.reportError("Load layout", e);
      });
    return () => {
      live = false;
    };
  }, [labName, toast]);

  // Re-read on lab switch, model change (a device added), Re-layout, and layout arrival.
  const initialPositions = useMemo(
    () => ({ ...(savedLayout ?? {}), ...readDraft() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labName, detail, relayoutNonce, layoutNonce, savedLayout, readDraft],
  );

  const posTimer = useRef<number | null>(null);
  const savePositions = useCallback(
    (map: NodePositions) => {
      livePositions.current = map;
      // "Unsaved" only means something once the lab *has* a fixed layout to diverge from.
      const hasFixed = !!savedLayout && Object.keys(savedLayout).length > 0;
      const matchesFixed = hasFixed && samePositions(map, savedLayout);
      setDirty(hasFixed && !matchesFixed);
      if (matchesFixed) {
        clearDraft(); // the graph is exactly the fixed layout — nothing local left to remember
        return;
      }
      if (posTimer.current) window.clearTimeout(posTimer.current);
      posTimer.current = window.setTimeout(() => {
        try {
          localStorage.setItem(draftKey, JSON.stringify(map));
        } catch {
          /* ignore quota/serialization errors */
        }
      }, 400);
    },
    [clearDraft, draftKey, savedLayout],
  );

  // Fix the current arrangement in the lab directory (lab.layout), so it travels with the lab.
  async function handleSaveLayout() {
    await runBusy(setSavingLayout, "Save layout", async () => {
      const map = livePositions.current;
      const { nodes } = await api.saveLayout(labName, map);
      setSavedLayout(nodes);
      setDirty(false);
      clearDraft();
      toast.show("Layout fixed — saved to the lab's lab.layout file.", "success");
    });
  }

  async function handleClearLayout() {
    const ok = await confirm({
      title: "Remove the fixed layout?",
      message: "Deletes lab.layout from the lab directory; the graph goes back to laying itself out.",
      okLabel: "Remove",
    });
    if (!ok) return;
    await runBusy(setSavingLayout, "Remove layout", async () => {
      await api.deleteLayout(labName);
      setSavedLayout({});
      clearDraft();
      setDirty(false);
      setRelayoutNonce((n) => n + 1);
      toast.show("Fixed layout removed.", "success");
    });
  }

  const { canvasRef, fit: handleFit, select, zoom } = useForceLayout(
    model,
    // Rebuild token: Re-layout bumps one counter, the arrival of the lab's fixed layout the other
    // (it can resolve after the engine's first build). Both only ever increase.
    relayoutNonce + layoutNonce,
    {
      onSelect: setSelectedId,
      onDismissContextMenu: () => setContextMenu(null),
      onNodeContextMenu: (nd, x, y) => {
        const items = nd.type === "dev" ? deviceContextItems(nd) : domainContextItems(nd);
        setContextMenu({ x, y, items });
      },
      onPaneContextMenu: (x, y) => {
        setContextMenu({
          x,
          y,
          items: [
            { label: "New device", action: () => openAddDevice() },
            { label: "New collision domain", action: openAddDomain },
          ],
        });
      },
      onNodeDoubleClick: (nd) => {
        if (nd.type === "dev") onEditFiles();
        else openAddDevice(nd.name);
      },
    },
    { initialPositions, onPositionsChange: savePositions, selectedId },
  );

  useEffect(() => {
    localStorage.setItem("kt-topo-ips", String(showIps));
  }, [showIps]);

  // Collapse each toolbar into a single dropdown once the (user-resizable) canvas gets too narrow
  // to show its buttons in a row.
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setCompactToolbar(width < TOOLBAR_COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Sync the SVG highlight when selection is driven externally (controlled mode). Guarded inside
  // the hook so a graph-originated selection doesn't loop back through here.
  useEffect(() => {
    select(selectedId ?? null);
  }, [selectedId, select]);

  // Drop the local draft and re-run the init effect against the same model. With a fixed layout the
  // graph snaps back to it (so this doubles as "discard my unsaved moves"); without one it restarts
  // from fresh randomized positions and auto-fits.
  function handleRelayout() {
    clearDraft();
    setRelayoutNonce((n) => n + 1);
  }

  const selectedNode = selectedId ? model.nodes.find((n) => n.id === selectedId) ?? null : null;
  const selectedMachine =
    selectedNode?.type === "dev" ? detail.machines.find((m) => m.name === selectedNode.name) ?? null : null;
  const startupText = selectedMachine ? machineStartupText(selectedMachine, startups[selectedMachine.name]) : "";
  const isEmpty = !model.nodes.length;
  const hasFixedLayout = !!savedLayout && Object.keys(savedLayout).length > 0;

  const selectedDeviceName = selectedNode?.type === "dev" ? selectedNode.name : null;
  const selectedDeviceRunning = selectedNode?.type === "dev" ? selectedNode.running : false;
  const [startupStatus, setStartupStatus] = useState<StartupStatus | null>(null);

  // Poll the running device's boot-time startup log (/var/log/startup.log) until its startup
  // commands finish — signaled by the /tmp/EOS marker Kathara's own startup sequence touches last
  // (see KatharaService.is_startup_finished). Stops as soon as `finished` comes back true, or
  // immediately when the selection changes or the device stops running, so nothing keeps polling
  // in the background for a node the user isn't even looking at anymore. Depends on primitives
  // (name/running), not the node/machine objects themselves, which get new identities on every
  // unrelated lab refresh — an object dependency here would restart polling (and briefly show
  // "Loading…") on every such refresh instead of only on an actual selection change.
  useEffect(() => {
    setStartupStatus(null);
    if (!selectedDeviceName || !selectedDeviceRunning) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      api
        .getStartupStatus(labName, selectedDeviceName)
        .then((status) => {
          if (cancelled) return;
          setStartupStatus(status);
          if (!status.finished) timer = setTimeout(poll, 1500);
        })
        .catch(() => {
          if (cancelled) return;
          timer = setTimeout(poll, 1500);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [labName, selectedDeviceName, selectedDeviceRunning]);

  return (
    <div className="mt-3">
      <div className="kt-topo-hints">
        {(
          [
            ["drag", "nodes"],
            ["scroll", "zoom"],
            ["click", "inspect"],
            ["dbl-click", "edit"],
            ["right-click", "actions"],
          ] as const
        ).map(([key, label]) => (
          <span className="kt-topo-hint" key={key}>
            <kbd>{key}</kbd> {label}
          </span>
        ))}
      </div>
      <div className="kt-topo-wrap">
        <div className="kt-topo-canvas" ref={canvasWrapRef}>
          <div className={`kt-topo-svg-mount${showIps ? "" : " kt-topo-hide-ips"}`} ref={canvasRef} />
          {isEmpty && (
            <div className="kt-topo-empty">
              <p className="mb-2">This lab is empty.</p>
              <div className="d-flex gap-2 justify-content-center">
                <Button size="sm" variant="primary" onClick={() => openAddDevice()}>
                  + Device
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={openAddDomain}>
                  + Domain
                </Button>
              </div>
            </div>
          )}
          <div className="kt-topo-toolbar">
            {compactToolbar ? (
              <DropdownButton size="sm" variant="outline-secondary" title={<MoreHorizontal size={16} />} align="end">
                <Dropdown.Item onClick={() => openAddDevice()}>+ Device</Dropdown.Item>
                <Dropdown.Item onClick={openAddDomain}>+ Domain</Dropdown.Item>
                <Dropdown.Item active={showIps} onClick={() => setShowIps((v) => !v)}>
                  IPs
                </Dropdown.Item>
                <Dropdown.Item onClick={() => zoom(1.2)}>Zoom in</Dropdown.Item>
                <Dropdown.Item onClick={() => zoom(1 / 1.2)}>Zoom out</Dropdown.Item>
              </DropdownButton>
            ) : (
              <>
                <Button size="sm" variant="outline-secondary" onClick={() => openAddDevice()}>
                  + Device
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={openAddDomain}>
                  + Domain
                </Button>
                <Button
                  size="sm"
                  variant={showIps ? "secondary" : "outline-secondary"}
                  onClick={() => setShowIps((v) => !v)}
                  title="Show interface IPs on the graph"
                >
                  IPs
                </Button>
                <div className="kt-topo-zoom">
                  <Button size="sm" variant="outline-secondary" onClick={() => zoom(1.2)} title="Zoom in" aria-label="Zoom in">
                    +
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={() => zoom(1 / 1.2)}
                    title="Zoom out"
                    aria-label="Zoom out"
                  >
                    −
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="kt-topo-layout-toolbar">
            {compactToolbar ? (
              <DropdownButton size="sm" variant="outline-secondary" title={<MoreHorizontal size={16} />} align="end">
                <Dropdown.Item onClick={handleFit}>Fit</Dropdown.Item>
                <Dropdown.Item onClick={handleRelayout}>Re-layout</Dropdown.Item>
                <Dropdown.Item onClick={handleSaveLayout} disabled={savingLayout || isEmpty}>
                  {hasFixedLayout ? (dirty ? "Save layout •" : "Save layout") : "Fix layout"}
                </Dropdown.Item>
                {hasFixedLayout && (
                  <Dropdown.Item onClick={handleClearLayout} disabled={savingLayout}>
                    Unfix
                  </Dropdown.Item>
                )}
              </DropdownButton>
            ) : (
              <>
                <Button size="sm" variant="outline-secondary" onClick={handleFit}>
                  Fit
                </Button>
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={handleRelayout}
                  title={
                    hasFixedLayout
                      ? "Restore the lab's fixed layout, discarding unsaved moves"
                      : "Lay the graph out again from scratch"
                  }
                >
                  Re-layout
                </Button>
                <Button
                  size="sm"
                  variant={dirty ? "primary" : "outline-secondary"}
                  onClick={handleSaveLayout}
                  disabled={savingLayout || isEmpty}
                  title={
                    hasFixedLayout
                      ? "Update the lab's fixed layout (lab.layout in the lab directory)"
                      : "Fix this layout for the lab — stores it as lab.layout in the lab directory"
                  }
                >
                  {hasFixedLayout ? (dirty ? "Save layout •" : "Save layout") : "Fix layout"}
                </Button>
                {hasFixedLayout && (
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={handleClearLayout}
                    disabled={savingLayout}
                    title="Remove the lab's fixed layout (lab.layout) and lay the graph out automatically"
                  >
                    Unfix
                  </Button>
                )}
              </>
            )}
          </div>
          <div className="kt-topo-legend">
            {legend.categories.map((cat) => (
              <div className="lg" key={cat}>
                <svg className={`kt-legend-icon n-${cat}`} viewBox="0 0 16 16">
                  {CATEGORY_ICON[cat].map(([tag, attrs], i) => {
                    if (tag === "rect") return <rect key={i} {...attrs} />;
                    if (tag === "circle") return <circle key={i} {...attrs} />;
                    return <path key={i} {...attrs} />;
                  })}
                </svg>
                {CATEGORY_LABEL[cat]}
              </div>
            ))}
            {legend.bridged && (
              <div className="lg">
                <span className="swatch badge">B</span>
                bridged
              </div>
            )}
            <div className="lg">
              <span className="swatch running" />
              running
            </div>
            <div className="lg">
              <span className="swatch stopped" />
              stopped
            </div>
            <div className="lg">
              <span className="swatch cd domain" />
              collision domain
            </div>
            <div className="lg">
              <span className="swatch cd domain-external" />
              external domain
            </div>
          </div>
        </div>
      </div>
      {nodeInfoHost &&
        createPortal(
          <div className="kt-topo-side">
            {!selectedNode ? (
            <>
              <div className="hint">
                {model.nodes.filter((n) => n.type === "dev").length} device(s),{" "}
                {model.nodes.filter((n) => n.type === "cd").length} collision domain(s).
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                Click a node to inspect its topological details.
              </div>
            </>
          ) : selectedNode.type === "dev" ? (
            <>
              <h4 className="mb-2">{selectedNode.name}</h4>
              <div className="d-flex gap-2 mb-2">
                {selectedNode.running && (
                  <Button size="sm" variant="dark" onClick={() => openWorkspaceTerminal(selectedNode)}>
                    <SquareTerminal size={14} className="me-1" />
                    Open terminal
                  </Button>
                )}
                <DropdownButton size="sm" variant="outline-secondary" title="Actions" data-tour="node-actions-btn">
                  {selectedNode.running && (
                    <Dropdown.Item onClick={() => openTerminalPopup(selectedNode)}>
                      <AppWindow size={14} className="me-2" />
                      Open terminal popup
                    </Dropdown.Item>
                  )}
                  {selectedNode.running && (
                    <Dropdown.Item onClick={() => openRuntimeFs(selectedNode)}>
                      <FolderOpen size={14} className="me-2" />
                      Show runtime FS
                    </Dropdown.Item>
                  )}
                  {selectedNode.running && <Dropdown.Divider />}
                  <Dropdown.Item onClick={() => openAddInterface(selectedNode)}>
                    <Plug size={14} className="me-2" />
                    {selectedNode.running ? "Add interface (runtime)" : "Add interface (lab.conf)"}
                  </Dropdown.Item>
                  <Dropdown.Item className="text-danger" onClick={() => openDisconnect(selectedNode)}>
                    <Unplug size={14} className="me-2" />
                    {selectedNode.running ? "Disconnect interface (runtime)" : "Remove interface (lab.conf)"}
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  <Dropdown.Item onClick={() => openOptions(selectedNode)}>
                    <SlidersHorizontal size={14} className="me-2" />
                    {detail.deployed ? "View options" : "Edit options"}
                  </Dropdown.Item>
                  <Dropdown.Item onClick={onEditFiles}>
                    <FileEdit size={14} className="me-2" />
                    Edit configuration
                  </Dropdown.Item>
                </DropdownButton>
              </div>
              <Kv k="type" v={selectedNode.typeLabel} />
              <Kv k="image" v={selectedNode.image || "—"} />
              <div className="kv">
                <span className="k">state</span>
                <span className={`kt-state ${selectedNode.running ? "running" : "stopped"}`}>
                  {deviceStateLabel(selectedNode)}
                </span>
              </div>
              <Kv k="ifaces" v={selectedNode.ifaces.length} />
              {selectedMachine?.bridged && <Kv k="bridged" v="yes (host bridge)" />}
              {selectedMachine?.privileged && <Kv k="privileged" v="yes" />}
              {selectedMachine?.ipv6 != null && <Kv k="ipv6" v={selectedMachine.ipv6 ? "enabled" : "disabled"} />}
              {selectedMachine?.mem && <Kv k="mem" v={selectedMachine.mem} />}
              {selectedMachine?.cpus != null && <Kv k="cpus" v={selectedMachine.cpus} />}
              {selectedMachine?.shell && <Kv k="shell" v={selectedMachine.shell} />}
              {selectedMachine?.num_terms != null && <Kv k="num_terms" v={selectedMachine.num_terms} />}
              {selectedMachine?.entrypoint && <Kv k="entrypoint" v={selectedMachine.entrypoint} />}
              {selectedMachine?.args && <Kv k="args" v={selectedMachine.args} />}
              {selectedNode.ifaces.map((it) => (
                <div className="iface" key={it.num}>
                  <div style={{ fontWeight: 600, fontFamily: "monospace" }}>{formatIface(it.num, it.link)}</div>
                  {it.ips.length > 0 && <Kv k="ip" v={it.ips.join(", ")} />}
                  {it.mac && <Kv k="mac" v={it.mac} />}
                </div>
              ))}
              {selectedMachine?.ports && selectedMachine.ports.length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>ports</div>
                  {selectedMachine.ports.map((p) => (
                    <Kv
                      key={`${p.host_port}/${p.protocol}`}
                      k={formatPort(p)}
                      v={
                        selectedNode.running && p.protocol === "tcp" ? (
                          <a
                            href={`http://${window.location.hostname}:${p.host_port}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            open ↗
                          </a>
                        ) : (
                          <span className="hint">{selectedNode.running ? "—" : "deploy to open"}</span>
                        )
                      }
                    />
                  ))}
                </div>
              )}
              {selectedMachine && Object.keys(selectedMachine.envs).length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>env</div>
                  {Object.entries(selectedMachine.envs).map(([k, v]) => (
                    <Kv key={k} k={k} v={v} />
                  ))}
                </div>
              )}
              {selectedMachine && Object.keys(selectedMachine.sysctls).length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>sysctls</div>
                  {Object.entries(selectedMachine.sysctls).map(([k, v]) => (
                    <Kv key={k} k={k} v={String(v)} />
                  ))}
                </div>
              )}
              {selectedMachine && selectedMachine.ulimits.length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>ulimits</div>
                  {selectedMachine.ulimits.map((u) => (
                    <Kv key={u.name} k={u.name} v={u.hard != null ? `${u.soft} / ${u.hard}` : `${u.soft}`} />
                  ))}
                </div>
              )}
              {selectedMachine && selectedMachine.volumes.length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>volumes</div>
                  {selectedMachine.volumes.map((v) => (
                    <Kv key={`${v.host_path}:${v.guest_path}`} k={v.guest_path} v={`${v.host_path} (${v.mode})`} />
                  ))}
                </div>
              )}
              {selectedMachine && Object.keys(selectedMachine.metas).length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>other options</div>
                  {Object.entries(selectedMachine.metas).map(([k, v]) => (
                    <Kv key={k} k={k} v={v} />
                  ))}
                </div>
              )}
              <div className="iface">
                <div style={{ fontWeight: 600 }}>startup</div>
                {startupText ? (
                  <pre className="startup">{startupText}</pre>
                ) : (
                  <div className="hint">No startup commands.</div>
                )}
              </div>
              {selectedNode.running && (
                <div className="iface">
                  <div className="d-flex align-items-center justify-content-between">
                    <span style={{ fontWeight: 600 }}>startup log</span>
                    <span className={`kt-state ${startupStatus?.finished ? "done" : "pending"}`}>
                      {startupStatus?.finished ? "finished" : "running…"}
                    </span>
                  </div>
                  {startupStatus?.log ? (
                    <pre className="startup">{startupStatus.log}</pre>
                  ) : (
                    <div className="hint">{startupStatus ? "No output yet." : "Loading…"}</div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <h4>{selectedNode.name}</h4>
              <Kv k="type" v={selectedNode.external.length ? "external" : "internal"} />
              <div className="kv">
                <span className="k">state</span>
                <span className={`kt-state ${selectedNode.running ? "running" : "stopped"}`}>
                  {selectedNode.running ? "up" : "down"}
                </span>
              </div>
              {selectedNode.external.length > 0 && <Kv k="external" v={selectedNode.external.join(", ")} />}
              {machineNames().length > 0 && (
                <div className="mt-2">
                  <Button size="sm" variant="outline-secondary" onClick={() => openConnectExisting(selectedNode)}>
                    Connect device
                  </Button>
                </div>
              )}
              <div className="iface">
                <div style={{ fontWeight: 600 }}>Devices ({selectedNode.members.length})</div>
                <div style={{ fontFamily: "monospace" }}>{selectedNode.members.join(", ") || "—"}</div>
              </div>
            </>
          )}
          </div>,
          nodeInfoHost,
        )}
    </div>
  );
}
