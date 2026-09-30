import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, Dropdown, DropdownButton } from "react-bootstrap";
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import type { UseDeviceActions } from "../hooks/useDeviceActions";
import { useForceLayout } from "../hooks/useForceLayout";
import { api, isAbortError } from "../services/api";
import { plural } from "../services/format";
import { machineStartupText } from "../services/labfs";
import { CATEGORY_ICON, CATEGORY_LABEL, type DeviceCategory } from "../services/deviceIcon";
import { deviceIpMismatches, ipMismatches, matchesSavedLayout, type NodePositions } from "../services/topology";
import {
  LEGACY_IPS_KEY,
  LEGACY_MACS_KEY,
  parseTopoDisplay,
  TOPO_DISPLAY_KEY,
  type TopoDisplay,
} from "../services/topologyDisplay";
import type { LabDetail, LiveAddresses } from "../services/types";
import "./TopologyGraph.css";
import { DeviceInfoTabs, type SelectionGuard } from "./DeviceInfoTabs";
import { Kv } from "./Kv";
import type { ContextMenuState } from "./TopologyContextMenu";
import { TopologyDisplayMenu } from "./TopologyDisplayMenu";

// Device/domain actions (deploy, remove, add/remove interface, open a terminal, …) and the
// context-menu item lists live in useDeviceActions — a single instance owned by the workspace page
// (shared with the sidebar's device list, so a right-click means the same thing in both places, and
// there's one startup-scripts fetch / one action modal instead of two hand-synced copies).
type DeviceActionsProps = Pick<
  UseDeviceActions,
  | "model"
  | "startups"
  | "refreshStartups"
  | "deviceContextItems"
  | "domainContextItems"
  | "openAddDevice"
  | "openAddDomain"
  | "openAddInterface"
  | "openConnectExisting"
  | "openDisconnect"
  | "deployDevice"
  | "undeployDevice"
  | "pendingDevices"
  | "removeDevice"
  | "openRuntimeFs"
  | "openOptions"
  | "openTerminalPopup"
  | "openWorkspaceTerminal"
  | "machineNames"
>;

interface TopologyGraphProps extends DeviceActionsProps {
  labId: string;
  detail: LabDetail;
  /** Selects the device and brings its configuration forward in the Inspector. */
  onConfigureDevice: (device: string) => void;
  /** The latest "Configure Device" request, for the Inspector to act on. */
  configureRequest: { device: string; seq: number } | null;
  /** Installs the guard the workspace asks before selecting another node — see DeviceInfoTabs. */
  registerSelectionGuard: (guard: SelectionGuard | null) => void;
  /** Shows/dismisses the shared context menu (rendered once by the workspace page). */
  setContextMenu: (menu: ContextMenuState | null) => void;
  /** Optional controlled selection (node id `dev:<name>` / `cd:<name>`). When provided, an external
   *  list (e.g. the Workspace rail) can drive/read the selected node. Omit for internal selection,
   *  where the component tracks the selected node itself. */
  selectedId?: string | null;
  /** May refuse (resolving false): the canvas then puts its highlight back on the current node. */
  onSelectId?: (id: string | null) => void | Promise<boolean>;
  /** DOM node of the Inspector dock panel. When set, the inspector is portaled into it
   *  (so it can be dragged/closed like any dock panel); when null (panel closed) the inspector is
   *  hidden and the canvas takes the full width. */
  nodeInfoHost?: HTMLElement | null;
}

// The viewer's saved Display preferences. Storage can be unavailable (a private window, blocked
// site data): the graph then just starts from the defaults.
function readDisplay(): TopoDisplay {
  try {
    return parseTopoDisplay(localStorage.getItem(TOPO_DISPLAY_KEY), {
      ips: localStorage.getItem(LEGACY_IPS_KEY),
      macs: localStorage.getItem(LEGACY_MACS_KEY),
    });
  } catch {
    return parseTopoDisplay(null);
  }
}

// How often the running devices' addresses are re-read to compare with their startups, and how
// soon again while a running device is still booting (the backend leaves it out until it is done).
const LIVE_ADDRESSES_POLL_MS = 15_000;
const LIVE_ADDRESSES_BOOT_POLL_MS = 3_000;

// Below this canvas width, each toolbar collapses from its row of buttons into a single "more
// actions" dropdown (see the ResizeObserver effect below) — the panel is user-resizable (dockview),
// so the buttons must react to it shrinking, not just the browser window.
const TOOLBAR_COMPACT_WIDTH = 480;

// The Topology panel: the graph canvas with its toolbars and legend, and the Inspector portaled
// into its own dock panel. The graph itself — physics, drag/pan/zoom, the node DOM, updated every
// frame outside React state — is useForceLayout's; this component holds the low-frequency state
// around it: the selection, the Display preferences, the lab's fixed layout and its local draft,
// the polled live addresses, and (via the setContextMenu/deviceContextItems props) the context menu.
export function TopologyGraph({
  labId,
  detail,
  onConfigureDevice,
  configureRequest,
  registerSelectionGuard,
  model,
  startups,
  refreshStartups,
  deviceContextItems,
  domainContextItems,
  openAddDevice,
  openAddDomain,
  openAddInterface,
  openConnectExisting,
  openDisconnect,
  deployDevice,
  undeployDevice,
  pendingDevices,
  removeDevice,
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
  const [display, setDisplay] = useState(readDisplay);
  const [liveAddresses, setLiveAddresses] = useState<LiveAddresses>({});
  const legendId = useId();
  const { ips: showIps, macs: showMacs } = display;
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
  const draftKey = `kt-topo-pos:${labId}`;
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
  // The lab whose fixed layout a fresh arrangement leaves out: set when a layout is picked from the
  // Display menu, so the pick shows even on a lab with a fixed layout — as unsaved moves against it.
  // Cleared by Re-layout, Save and Unfix; naming the lab keeps it from carrying over to another one.
  const [ignoreFixedFor, setIgnoreFixedFor] = useState<string | null>(null);
  const ignoreFixed = ignoreFixedFor === labId;
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [savingLayout, setSavingLayout] = useState(false);
  // Latest positions reported by the engine — what "Save layout" writes to the lab directory.
  const livePositions = useRef<NodePositions>({});
  const [dirty, setDirty] = useState(false);
  const { run: runBusy } = useBusyAction();

  // Fetch the lab's fixed layout. It can land after the engine's first build, so bump a nonce to
  // make the graph rebuild against it (the engine effect reads seeds through a ref).
  useEffect(() => {
    if (!labId) return;
    let live = true;
    setSavedLayout(null);
    api
      .getLayout(labId)
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
  }, [labId, toast]);

  // What a *fresh* layout starts from. The draft lives in localStorage, outside React, so it is
  // re-read at each moment it may have changed: a lab switch (`labId`), a new `detail`, Re-layout
  // (`relayoutNonce`) and the fixed layout arriving (`layoutNonce`, `savedLayout`) — which is why
  // the list names values the body never reads. Right after a layout is picked, the fixed layout is
  // left out (`ignoreFixed`) and the draft alone decides. A rebuild that only carries new data (a device
  // added, a startup saved) doesn't depend on it being current: the engine carries its own live
  // positions across those (useForceLayout).
  const initialPositions = useMemo(
    () => ({ ...(ignoreFixed ? {} : savedLayout ?? {}), ...readDraft() }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labId, detail, relayoutNonce, layoutNonce, savedLayout, readDraft, ignoreFixed],
  );

  // Called only when the graph comes to rest and when a drag ends, so the draft is written straight
  // away: a delayed write would leave a window in which a rebuild reads an outdated draft, and
  // could land after Re-layout or Save had already cleared it.
  const savePositions = useCallback(
    (map: NodePositions) => {
      livePositions.current = map;
      // "Unsaved" only means something once the lab *has* a fixed layout to diverge from.
      const hasFixed = !!savedLayout && Object.keys(savedLayout).length > 0;
      const matchesFixed = hasFixed && matchesSavedLayout(map, savedLayout);
      setDirty(hasFixed && !matchesFixed);
      if (matchesFixed) {
        clearDraft(); // the graph is exactly the fixed layout — nothing local left to remember
        return;
      }
      try {
        localStorage.setItem(draftKey, JSON.stringify(map));
      } catch {
        /* ignore quota/serialization errors */
      }
    },
    [clearDraft, draftKey, savedLayout],
  );

  // Fix the current arrangement in the lab directory (lab.layout), so it travels with the lab.
  async function handleSaveLayout() {
    await runBusy(setSavingLayout, "Save layout", async () => {
      const map = livePositions.current;
      const { nodes } = await api.saveLayout(labId, map);
      setSavedLayout(nodes);
      setIgnoreFixedFor(null);
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
      await api.deleteLayout(labId);
      setSavedLayout({});
      setIgnoreFixedFor(null);
      clearDraft();
      setDirty(false);
      setRelayoutNonce((n) => n + 1);
      toast.show("Fixed layout removed.", "success");
    });
  }

  // A selection the workspace refuses (an edit in the Inspector the user keeps) must not leave
  // the canvas highlighting the node that was clicked: put the highlight back on the current one.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectRef = useRef<(id: string | null) => void>(() => {});
  const handleGraphSelect = useCallback(
    (id: string | null) => {
      const result = setSelectedId(id);
      if (result instanceof Promise) {
        void result.then((ok) => {
          if (!ok) selectRef.current(selectedIdRef.current ?? null);
        });
      }
    },
    [setSelectedId],
  );

  // The running devices' own addresses, re-read while any device runs (see the constants above),
  // and where they differ from what each interface's startup declares.
  const runningDevices = detail.machines
    .filter((m) => m.running)
    .map((m) => m.name)
    .sort()
    .join("\n");
  useEffect(() => {
    setLiveAddresses({});
    if (!runningDevices) return;
    const expected = runningDevices.split("\n").length;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      api
        .getLiveAddresses(labId, controller.signal)
        .then((live) => {
          setLiveAddresses(live);
          const booting = Object.keys(live).length < expected;
          timer = setTimeout(poll, booting ? LIVE_ADDRESSES_BOOT_POLL_MS : LIVE_ADDRESSES_POLL_MS);
        })
        .catch((e) => {
          // Best effort: a failed read just waits for the next one, with no toast.
          if (!isAbortError(e)) timer = setTimeout(poll, LIVE_ADDRESSES_POLL_MS);
        });
    };
    poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [labId, runningDevices]);
  const ipWarnings = useMemo(() => ipMismatches(model.edges, liveAddresses), [model, liveAddresses]);

  const { canvasRef, fit: handleFit, select, zoom } = useForceLayout(
    model,
    // Rebuild token: Re-layout bumps one counter, the arrival of the lab's fixed layout the other
    // (it can resolve after the engine's first build). Both only ever increase.
    relayoutNonce + layoutNonce,
    {
      onSelect: handleGraphSelect,
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
        if (nd.type === "dev") onConfigureDevice(nd.name);
        else openAddDevice(nd.name);
      },
    },
    {
      initialPositions,
      onPositionsChange: savePositions,
      selectedId,
      scopeKey: labId,
      labelLines: { ips: showIps, macs: showMacs },
      cdNames: display.cdNames,
      nodeScale: display.scale,
      ipWarnings,
      layout: display.layout,
      layeredDirection: display.layeredDirection,
      collapseP2p: display.collapseP2p,
    },
  );

  useEffect(() => {
    try {
      localStorage.setItem(TOPO_DISPLAY_KEY, JSON.stringify(display));
    } catch {
      /* ignore: storage unavailable or full — the choice lasts for this page only */
    }
  }, [display]);

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

  selectRef.current = select;

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
    setIgnoreFixedFor(null);
    setRelayoutNonce((n) => n + 1);
  }

  // Picking another layout arranges the graph afresh with it straight away, the lab's fixed layout
  // included — Re-layout brings that back. So does, for the layered one, another direction or
  // collapsing the point-to-point domains, which takes their rows away.
  function handleDisplayChange(next: TopoDisplay) {
    const rearrange =
      next.layout !== display.layout ||
      (next.layout === "layered" &&
        (next.layeredDirection !== display.layeredDirection || next.collapseP2p !== display.collapseP2p));
    setDisplay(next);
    if (!rearrange) return;
    clearDraft();
    setIgnoreFixedFor(labId);
    setRelayoutNonce((n) => n + 1);
  }

  const selectedNode = selectedId ? model.nodes.find((n) => n.id === selectedId) ?? null : null;
  const selectedMachine =
    selectedNode?.type === "dev" ? detail.machines.find((m) => m.name === selectedNode.name) ?? null : null;
  const startupText = selectedMachine ? machineStartupText(selectedMachine, startups[selectedMachine.name]) : "";
  const isEmpty = !model.nodes.length;
  const hasFixedLayout = !!savedLayout && Object.keys(savedLayout).length > 0;

  return (
    <div>
      <div className="kt-topo-wrap">
        <div className="kt-topo-canvas" ref={canvasWrapRef}>
          <div
            className={
              "kt-topo-svg-mount" +
              (showIps ? "" : " kt-topo-hide-ips") +
              (showMacs ? "" : " kt-topo-hide-macs") +
              (display.cdNames ? "" : " kt-topo-hide-cd-names") +
              (display.highContrast ? " kt-topo-high-contrast" : "")
            }
            style={{ "--kt-topo-scale": display.scale, "--kt-topo-line": display.lineWidth } as CSSProperties}
            ref={canvasRef}
          />
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
          <div className="kt-topo-toolbar" data-topo-overlay>
            {compactToolbar ? (
              <DropdownButton
                size="sm"
                variant="outline-secondary"
                title={
                  <span title="Add a device or collision domain" className="d-inline-flex align-items-center gap-1">
                    <MoreHorizontal size={16} aria-label="Topology actions" />
                    Edit
                  </span>
                }
                align="end"
              >
                <Dropdown.Header>Add elements to the topology</Dropdown.Header>
                <Dropdown.Item onClick={() => openAddDevice()}>+ Device</Dropdown.Item>
                <Dropdown.Item onClick={openAddDomain}>+ Domain</Dropdown.Item>
              </DropdownButton>
            ) : (
              <>
                <Button size="sm" variant="outline-secondary" onClick={() => openAddDevice()}>
                  + Device
                </Button>
                <Button size="sm" variant="outline-secondary" onClick={openAddDomain}>
                  + Domain
                </Button>
              </>
            )}
            <TopologyDisplayMenu value={display} onChange={handleDisplayChange} compact={compactToolbar} />
          </div>
          <div className="kt-topo-layout-toolbar" data-topo-overlay>
            {compactToolbar ? (
              <DropdownButton
                size="sm"
                variant="outline-secondary"
                title={
                  <span
                    title="Zoom, fit, re-layout, or save/fix the graph layout"
                    className="d-inline-flex align-items-center gap-1"
                  >
                    <MoreHorizontal size={16} aria-label="Layout actions" />
                    Layout
                  </span>
                }
                align="end"
              >
                <Dropdown.Header>View</Dropdown.Header>
                <Dropdown.Item onClick={() => zoom(1.2)}>Zoom In</Dropdown.Item>
                <Dropdown.Item onClick={() => zoom(1 / 1.2)}>Zoom Out</Dropdown.Item>
                <Dropdown.Item onClick={handleFit}>Fit to screen</Dropdown.Item>
                <Dropdown.Divider />
                <Dropdown.Header>Layout</Dropdown.Header>
                <Dropdown.Item
                  onClick={handleRelayout}
                  title={
                    hasFixedLayout
                      ? "Restore the lab's fixed layout, discarding unsaved moves"
                      : "Lay the graph out again from scratch"
                  }
                >
                  Re-layout
                </Dropdown.Item>
                <Dropdown.Item
                  onClick={handleSaveLayout}
                  disabled={savingLayout || isEmpty}
                  title={
                    hasFixedLayout
                      ? "Update the lab's fixed layout (lab.layout in the lab directory)"
                      : "Fix this layout for the lab — stores it as lab.layout in the lab directory"
                  }
                >
                  {hasFixedLayout ? (dirty ? "Save Layout •" : "Save Layout") : "Fix Layout"}
                </Dropdown.Item>
                {hasFixedLayout && (
                  <Dropdown.Item
                    onClick={handleClearLayout}
                    disabled={savingLayout}
                    title="Remove the lab's fixed layout (lab.layout) and lay the graph out automatically"
                  >
                    Unfix
                  </Dropdown.Item>
                )}
              </DropdownButton>
            ) : (
              <>
                <div className="kt-topo-zoom">
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={() => zoom(1 / 1.2)}
                    title="Zoom out"
                    aria-label="Zoom out"
                  >
                    −
                  </Button>
                  <Button size="sm" variant="outline-secondary" onClick={() => zoom(1.2)} title="Zoom in" aria-label="Zoom in">
                    +
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
                  {hasFixedLayout ? (dirty ? "Save Layout •" : "Save Layout") : "Fix Layout"}
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
          <div className="kt-topo-legend" data-topo-overlay>
            <button
              type="button"
              className="kt-topo-legend-head"
              aria-expanded={!display.legendCollapsed}
              aria-controls={legendId}
              onClick={() => setDisplay((d) => ({ ...d, legendCollapsed: !d.legendCollapsed }))}
            >
              {display.legendCollapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
              Legend
            </button>
            {!display.legendCollapsed && (
              <div className="kt-topo-legend-items" id={legendId}>
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
                {model.nodes.some((nd) => nd.type === "cd" && nd.draft) && (
                  <div className="lg">
                    <span className="swatch cd domain-draft" />
                    draft domain (not saved)
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {nodeInfoHost &&
        createPortal(
          <div className="kt-topo-side">
            {!selectedNode ? (
            <>
              <div className="hint">
                {plural(model.nodes.filter((n) => n.type === "dev").length, "device")},{" "}
                {plural(model.nodes.filter((n) => n.type === "cd").length, "collision domain")}.
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                Click a node to inspect its topological details.
              </div>
            </>
          ) : selectedNode.type === "dev" ? (
            <DeviceInfoTabs
              key={selectedNode.name}
              labId={labId}
              detail={detail}
              node={selectedNode}
              machine={selectedMachine}
              startupPreview={startupText}
              actions={{
                openWorkspaceTerminal,
                openTerminalPopup,
                openRuntimeFs,
                openAddInterface,
                openDisconnect,
                openOptions,
                deployDevice,
                undeployDevice,
                pendingDevices,
                removeDevice,
                refreshStartups,
              }}
              registerSelectionGuard={registerSelectionGuard}
              configureRequest={configureRequest}
              ipMismatches={deviceIpMismatches(model.edges, ipWarnings, selectedNode.name)}
            />
          ) : (
            <>
              <h4>{selectedNode.name}</h4>
              <div className="kt-card">
                <div className="kt-card-head">
                  <span className="kt-card-title">General</span>
                </div>
                <Kv
                  k="Type"
                  v={
                    selectedNode.networkPlugin ? (
                      <>
                        {selectedNode.networkPlugin}
                        {/* Stopped, it is the configured plugin: the network does not exist yet. */}
                        {!selectedNode.running && <span className="hint"> (on deploy)</span>}
                      </>
                    ) : (
                      "—"
                    )
                  }
                />
                <div className="kv">
                  <span className="k">State</span>
                  <span className={`kt-state ${selectedNode.running ? "running" : "stopped"}`}>
                    {selectedNode.running ? "up" : "down"}
                  </span>
                </div>
                {selectedNode.external.length > 0 && <Kv k="External" v={selectedNode.external.join(", ")} />}
              </div>
              <div className="kt-card">
                <div className="kt-card-head">
                  <span className="kt-card-title">Devices ({selectedNode.members.length})</span>
                  {machineNames().length > 0 && (
                    <Button size="sm" variant="outline-secondary" onClick={() => openConnectExisting(selectedNode)}>
                      Connect Device
                    </Button>
                  )}
                </div>
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
