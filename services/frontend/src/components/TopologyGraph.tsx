import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Form } from "react-bootstrap";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { useDeviceActions } from "../hooks/useDeviceActions";
import { useForceLayout, type NodePositions } from "../hooks/useForceLayout";
import { api } from "../services/api";
import { machineStartupText } from "../services/labfs";
import { CATEGORY_ICON, CATEGORY_LABEL, type DeviceCategory } from "../services/deviceIcon";
import type { LabDetail } from "../services/types";
import "./TopologyGraph.css";
import { TopologyActionModal } from "./TopologyActionModal";
import { TopologyContextMenu, type ContextMenuState } from "./TopologyContextMenu";

interface TopologyGraphProps {
  labName: string;
  detail: LabDetail;
  onRefresh: () => Promise<void>;
  onEditFiles: () => void;
  // Opens a terminal for `machine` as a panel in the workspace dock (as opposed to
  // openTerminalWindow's separate browser popup — see "Open terminal" vs "Open terminal popup").
  onOpenTerminal: (machine: string) => void;
  // Opens the Runtime Filesystem dock panel, preselecting `machine` (no in-topology popup).
  onOpenRuntimeFs: (machine: string) => void;
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

// Force-directed SVG topology graph (device + collision-domain nodes, edges = interfaces), no
// charting library. The simulation/render loop manipulates SVG DOM attributes directly every
// animation frame rather than going through React state: dozens of position updates per second
// per node is not a good fit for React re-renders. React only owns the low-frequency parts: the
// side panel, the context menu, and the action modal.
//
// Device/domain actions (deploy, remove, add/remove interface, open a terminal, …) and the
// context-menu item lists live in useDeviceActions — shared with the workspace sidebar's device
// list, so a right-click means the same thing in both places.
export function TopologyGraph({
  labName,
  detail,
  onRefresh,
  onEditFiles,
  onOpenTerminal,
  onOpenRuntimeFs,
  selectedId: controlledSelectedId,
  onSelectId,
  nodeInfoHost,
}: TopologyGraphProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  const selectedId = controlledSelectedId !== undefined ? controlledSelectedId : internalSelectedId;
  const setSelectedId = onSelectId ?? setInternalSelectedId;
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showIps, setShowIps] = useState(() => localStorage.getItem("kt-topo-ips") !== "false");
  const [search, setSearch] = useState("");
  const [relayoutNonce, setRelayoutNonce] = useState(0);
  const toast = useToast();
  const confirm = useConfirm();

  const {
    model,
    pending,
    actionConfig,
    setActionConfig,
    deviceContextItems,
    domainContextItems,
    openAddDevice,
    openAddDomain,
    openAddInterface,
    openConnectExisting,
    openDisconnect,
    openRuntimeFs,
    openTerminalPopup,
    machineNames,
  } = useDeviceActions({ labName, detail, onRefresh, onEditFiles, onOpenTerminal, onOpenRuntimeFs });

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
    let live = true;
    setSavedLayout(null);
    api
      .getLayout(labName)
      .then((l) => {
        if (!live) return;
        setSavedLayout(l.nodes);
        if (Object.keys(l.nodes).length) setLayoutNonce((v) => v + 1);
      })
      .catch((e) => toast.reportError("Load layout", e));
    return () => {
      live = false;
    };
  }, [labName]);

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

  const { canvasRef, fit: handleFit, select, zoom, centerOn } = useForceLayout(
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
      onNodeDoubleClick: (nd) => {
        if (nd.type === "dev") onEditFiles();
        else openAddDevice(nd.name);
      },
    },
    { initialPositions, onPositionsChange: savePositions },
  );

  useEffect(() => {
    localStorage.setItem("kt-topo-ips", String(showIps));
  }, [showIps]);

  // Jump to a device typed/picked in the search box (exact name match → select + center).
  function onSearch(value: string) {
    setSearch(value);
    const id = `dev:${value.trim()}`;
    if (model.nodes.some((n) => n.id === id)) {
      setSelectedId(id);
      centerOn(id);
    }
  }

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
  const startupText = selectedMachine ? machineStartupText(selectedMachine, pending[selectedMachine.name]) : "";
  const isEmpty = !model.nodes.length;
  const hasFixedLayout = !!savedLayout && Object.keys(savedLayout).length > 0;

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
        <div className="kt-topo-canvas">
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
            <Form.Control
              size="sm"
              type="search"
              className="kt-topo-search"
              placeholder="Find device…"
              list="kt-topo-devices"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              aria-label="Find device"
            />
            <datalist id="kt-topo-devices">
              {model.nodes.filter((n) => n.type === "dev").map((n) => (
                <option key={n.id} value={n.name} />
              ))}
            </datalist>
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
              <Button size="sm" variant="outline-secondary" onClick={() => zoom(1 / 1.2)} title="Zoom out" aria-label="Zoom out">
                −
              </Button>
            </div>
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
              <h4>{selectedNode.name}</h4>
              <div className="kv">
                <span className="k">type</span>
                <span className="v">{selectedNode.typeLabel}</span>
              </div>
              <div className="kv">
                <span className="k">image</span>
                <span className="v">{selectedNode.image || "—"}</span>
              </div>
              <div className="kv">
                <span className="k">state</span>
                <span className={`kt-state ${selectedNode.running ? "running" : "stopped"}`}>
                  {selectedNode.running ? selectedNode.status || "running" : "stopped"}
                </span>
              </div>
              <div className="kv">
                <span className="k">ifaces</span>
                <span className="v">{selectedNode.ifaces.length}</span>
              </div>
              {selectedMachine?.bridged && (
                <div className="kv">
                  <span className="k">bridged</span>
                  <span className="v">yes (host bridge)</span>
                </div>
              )}
              <div className="d-flex gap-2 mt-2 flex-wrap">
                {selectedNode.running && (
                  <Button size="sm" variant="dark" onClick={() => openTerminalPopup(selectedNode)}>
                    Open terminal popup
                  </Button>
                )}
                {selectedNode.running && (
                  <Button size="sm" variant="outline-secondary" onClick={() => openRuntimeFs(selectedNode)}>
                    Show runtime FS
                  </Button>
                )}
                <Button size="sm" variant="outline-secondary" onClick={() => openAddInterface(selectedNode)}>
                  {selectedNode.running ? "Add interface (runtime)" : "Add interface (lab.conf)"}
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={() => openDisconnect(selectedNode)}>
                  {selectedNode.running ? "Disconnect interface (runtime)" : "Remove interface (lab.conf)"}
                </Button>
                <Button size="sm" variant="primary" onClick={onEditFiles}>
                  Edit configuration
                </Button>
              </div>
              {selectedNode.ifaces.map((it) => (
                <div className="iface" key={it.num}>
                  <div style={{ fontWeight: 600, fontFamily: "monospace" }}>
                    eth{it.num} → {it.link}
                  </div>
                  {it.ips.length > 0 && (
                    <div className="kv">
                      <span className="k">ip</span>
                      <span className="v">{it.ips.join(", ")}</span>
                    </div>
                  )}
                  {it.mac && (
                    <div className="kv">
                      <span className="k">mac</span>
                      <span className="v">{it.mac}</span>
                    </div>
                  )}
                </div>
              ))}
              {selectedMachine?.ports && selectedMachine.ports.length > 0 && (
                <div className="iface">
                  <div style={{ fontWeight: 600 }}>ports</div>
                  {selectedMachine.ports.map((p) => (
                    <div className="kv" key={`${p.host_port}/${p.protocol}`}>
                      <span className="k">
                        {p.host_port}→{p.guest_port}/{p.protocol}
                      </span>
                      <span className="v">
                        {selectedNode.running && p.protocol === "tcp" ? (
                          <a
                            href={`http://${window.location.hostname}:${p.host_port}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            open ↗
                          </a>
                        ) : (
                          <span className="hint">{selectedNode.running ? "—" : "deploy to open"}</span>
                        )}
                      </span>
                    </div>
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
            </>
          ) : (
            <>
              <h4>{selectedNode.name}</h4>
              <div className="kv">
                <span className="k">type</span>
                <span className="v">{selectedNode.external.length ? "external" : "internal"}</span>
              </div>
              <div className="kv">
                <span className="k">state</span>
                <span className={`kt-state ${selectedNode.running ? "running" : "stopped"}`}>
                  {selectedNode.running ? "up" : "down"}
                </span>
              </div>
              {selectedNode.external.length > 0 && (
                <div className="kv">
                  <span className="k">external</span>
                  <span className="v">{selectedNode.external.join(", ")}</span>
                </div>
              )}
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
      <TopologyContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      <TopologyActionModal config={actionConfig} onClose={() => setActionConfig(null)} />
    </div>
  );
}
