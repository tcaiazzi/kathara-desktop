import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Dropdown, OverlayTrigger, SplitButton, Tab, Tabs, Tooltip } from "react-bootstrap";
import {
  AlertTriangle,
  FileTerminal,
  Folder,
  FolderOpen,
  Info,
  Network,
  Play,
  Plug,
  SlidersHorizontal,
  SquareTerminal,
  Square,
  Trash2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useConfirm } from "../context/ConfirmContext";
import { useElementSize } from "../hooks/useElementSize";
import { useStartupStatus } from "../hooks/useStartupStatus";
import type { UseDeviceActions } from "../hooks/useDeviceActions";
import { api } from "../services/api";
import { savedDeviceTab, type DeviceInfoTab } from "../services/deviceInfoTabs";
import { deviceFilesOnDisk } from "../services/labfs";
import { hasDeployFailure } from "../services/labRunState";
import { deviceStateLabel, formatIface, formatPort, type DeviceNode, type IfaceIpMismatch } from "../services/topology";
import { IP_MISMATCH_HINT } from "../services/topologyTooltip";
import type { LabDetail, MachineDetail } from "../services/types";
import { describeUnsaved } from "../services/unsaved";
import { DeviceFilesSection } from "./DeviceFilesSection";
import { DeviceScriptSection } from "./DeviceScriptSection";
import { DeviceStartupLog } from "./DeviceStartupLog";
import { Kv } from "./Kv";

/** Asks whether the selection may move off the device shown: true when nothing is lost. */
export type SelectionGuard = () => Promise<boolean>;

type DeviceInfoActions = Pick<
  UseDeviceActions,
  | "openWorkspaceTerminal"
  | "openTerminalPopup"
  | "openRuntimeFs"
  | "openAddInterface"
  | "openDisconnect"
  | "openOptions"
  | "deployDevice"
  | "undeployDevice"
  | "removeDevice"
  | "refreshStartups"
>;

interface DeviceInfoTabsProps {
  labId: string;
  detail: LabDetail;
  node: DeviceNode;
  machine: MachineDetail | null;
  /** What the Inspector shows for the startup script (machineStartupText). */
  startupPreview: string;
  actions: DeviceInfoActions;
  /** Installs the guard the workspace consults before selecting another node; null removes it. */
  registerSelectionGuard: (guard: SelectionGuard | null) => void;
  /** The latest "Configure Device" request; a new one for this device opens Scripts and its editor. */
  configureRequest: { device: string; seq: number } | null;
  /** Interfaces whose running addresses differ from the startup's, by number (deviceIpMismatches). */
  ipMismatches: Record<number, IfaceIpMismatch>;
}

const LS_TAB = "kt-device-info-tab";
// Below this width the Files tab puts the editor under the tree instead of beside it.
const FILES_SIDE_BY_SIDE_WIDTH = 640;

function readSavedTab(): DeviceInfoTab {
  try {
    return savedDeviceTab(localStorage.getItem(LS_TAB));
  } catch {
    return "overview";
  }
}

function saveTab(tab: DeviceInfoTab) {
  try {
    localStorage.setItem(LS_TAB, tab);
  } catch {
    // A remembered tab is a convenience: without storage every device just opens on Overview.
  }
}

// The Inspector for one device: a fixed header with its state and the actions on the device
// as a whole (deploy/undeploy, terminal, options, remove), then four tabs — Overview (options and
// startup log), Network (interfaces), Scripts (boot scripts and startup log) and Files
// (the device's own folder). Mounted per device (keyed by name), so switching device starts afresh.
// Every tab stays mounted while another is shown, so an editor left open keeps its text; the
// workspace asks this component first (the selection guard) whenever changing device would drop one.
export function DeviceInfoTabs({
  labId,
  detail,
  node,
  machine,
  startupPreview,
  actions,
  registerSelectionGuard,
  configureRequest,
  ipMismatches,
}: DeviceInfoTabsProps) {
  const confirm = useConfirm();
  const device = node.name;

  const [tab, setTab] = useState<DeviceInfoTab>(readSavedTab);
  const selectTab = useCallback((next: DeviceInfoTab) => {
    setTab(next);
    saveTab(next);
  }, []);

  // A "Configure Device" request newer than this mount opens Scripts; the startup section opens
  // its editor from the same value.
  const editRequest = configureRequest?.device === device ? configureRequest.seq : undefined;
  const seenRequest = useRef(editRequest);
  useEffect(() => {
    if (editRequest === undefined || editRequest === seenRequest.current) return;
    seenRequest.current = editRequest;
    selectTab("scripts");
  }, [editRequest, selectTab]);

  // Which of the device's scripts (and its folder) exist, from the lab root's listing —
  // `get_startup_scripts` answers "" for a missing file too, so it can't say. Null until known.
  const [onDisk, setOnDisk] = useState<{ startup: boolean; shutdown: boolean; folder: boolean } | null>(null);
  const [listing, setListing] = useState(0);
  const relist = useCallback(() => setListing((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    api
      .fsListOffline(labId, "/", controller.signal)
      .then(({ entries }) => {
        const files = deviceFilesOnDisk(device, entries);
        setOnDisk({
          startup: files.includes(`${device}.startup`),
          shutdown: files.includes(`${device}.shutdown`),
          folder: files.includes(`${device}/`),
        });
      })
      .catch(() => {
        // Unknown: the sections offer Create, and saving an existing file just overwrites it.
        if (!controller.signal.aborted) setOnDisk({ startup: false, shutdown: false, folder: true });
      });
    return () => controller.abort();
    // `startupPreview` changes when a startup script changes on disk, from here or elsewhere.
  }, [labId, device, listing, startupPreview]);

  // The unsaved buffers of the three editing sections, by section: state for the tabs' ●, and a
  // ref for the selection guard, which runs outside any render.
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const reportDirty = useCallback((key: string, label: string | null) => {
    setDirty((prev) => {
      if ((prev[key] ?? null) === label) return prev;
      const next = { ...prev };
      if (label === null) delete next[key];
      else next[key] = label;
      return next;
    });
  }, []);
  const onStartupDirty = useCallback((label: string | null) => reportDirty("startup", label), [reportDirty]);
  const onShutdownDirty = useCallback((label: string | null) => reportDirty("shutdown", label), [reportDirty]);
  const onFilesDirty = useCallback((label: string | null) => reportDirty("files", label), [reportDirty]);

  useEffect(() => {
    registerSelectionGuard(async () => {
      const labels = Object.values(dirtyRef.current);
      if (labels.length === 0) return true;
      return confirm({ title: "Discard unsaved changes?", message: describeUnsaved(labels), okLabel: "Discard" });
    });
    return () => registerSelectionGuard(null);
  }, [confirm, registerSelectionGuard]);

  const { refreshStartups } = actions;
  // Saving a script that exists only changes what is in it; which scripts exist changes on the
  // Save that creates one, so only that one re-lists the lab root.
  const startupExists = onDisk?.startup === true;
  const shutdownExists = onDisk?.shutdown === true;
  const onStartupSaved = useCallback(() => {
    if (!startupExists) relist();
    void refreshStartups();
  }, [startupExists, relist, refreshStartups]);
  const onShutdownSaved = useCallback(() => {
    if (!shutdownExists) relist();
  }, [shutdownExists, relist]);

  const { ref: filesRef, width: filesWidth } = useElementSize<HTMLDivElement>();

  // Polled here, once, since both Overview and Scripts show it.
  const startupStatus = useStartupStatus(labId, device, node.running);
  const startupLog = node.running && (
    <DeviceStartupLog status={startupStatus} hasCommands={startupPreview.trim() !== ""} />
  );

  const runningHint = node.running && (
    <div className="hint mb-2">Changes to these files apply the next time {device} starts.</div>
  );
  const deployFailed = !node.running && hasDeployFailure(detail) && detail.deploy_failed_machines.includes(device);

  return (
    <div className="kt-devinfo">
      <div className="kt-devinfo-head">
        <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
          <h4 className="mb-0 me-1">{device}</h4>
          <span className={`kt-state ${node.running ? "running" : "stopped"}`}>{deviceStateLabel(node)}</span>
          <div className="d-flex gap-2 ms-auto flex-wrap">
            {node.running ? (
              <>
                <SplitButton
                  size="sm"
                  variant="dark"
                  title={
                    <span className="d-inline-flex align-items-center">
                      <SquareTerminal size={14} className="me-1" />
                      Open Terminal
                    </span>
                  }
                  onClick={() => actions.openWorkspaceTerminal(node)}
                >
                  <Dropdown.Item onClick={() => actions.openTerminalPopup(node)}>Open in a popup window</Dropdown.Item>
                </SplitButton>
                <Button size="sm" variant="outline-danger" onClick={() => void actions.undeployDevice(node)}>
                  <Square size={13} className="me-1" />
                  Undeploy
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline-success" onClick={() => void actions.deployDevice(node)}>
                <Play size={13} className="me-1" />
                Deploy
              </Button>
            )}
            <Button size="sm" variant="outline-secondary" onClick={() => actions.openOptions(node)}>
              <SlidersHorizontal size={13} className="me-1" />
              {detail.deployed ? "View Options" : "Edit Options"}
            </Button>
            <Button size="sm" variant="outline-danger" onClick={() => void actions.removeDevice(node)}>
              <Trash2 size={13} className="me-1" />
              Remove
            </Button>
          </div>
        </div>
        {deployFailed && <div className="kt-topo-deploy-error">Not started — {detail.deploy_error}</div>}
      </div>

      <div className="kt-devinfo-tabs" data-tour="node-info-tabs">
        <Tabs activeKey={tab} onSelect={(k) => k && selectTab(k as DeviceInfoTab)} className="mb-2">
          <Tab eventKey="overview" title={<TabTitle icon={Info} label="Overview" />}>
            <OverviewTab node={node} machine={machine} />
            {startupLog}
          </Tab>
          <Tab eventKey="network" title={<TabTitle icon={Network} label="Network" />}>
            <NetworkTab node={node} actions={actions} ipMismatches={ipMismatches} />
          </Tab>
          <Tab eventKey="scripts" title={<TabTitle icon={FileTerminal} label="Scripts" dirty={!!(dirty.startup || dirty.shutdown)} />}>
            {runningHint}
            <DeviceScriptSection
              labId={labId}
              device={device}
              kind="startup"
              exists={onDisk?.startup ?? null}
              preview={startupPreview}
              onSaved={onStartupSaved}
              onDirtyChange={onStartupDirty}
              editRequest={editRequest}
            />
            {startupLog}
            <DeviceScriptSection
              labId={labId}
              device={device}
              kind="shutdown"
              exists={onDisk?.shutdown ?? null}
              onSaved={onShutdownSaved}
              onDirtyChange={onShutdownDirty}
            />
          </Tab>
          <Tab eventKey="files" title={<TabTitle icon={Folder} label="Files" dirty={!!dirty.files} />}>
            <div className="kt-devinfo-files">
              {runningHint}
              {node.running && (
                <Button size="sm" variant="link" className="p-0 mb-2 align-self-start" onClick={() => actions.openRuntimeFs(node)}>
                  <FolderOpen size={13} className="me-1" />
                  Browse the running device's filesystem
                </Button>
              )}
              {onDisk?.folder === false && (
                <div className="hint mb-2">
                  No files yet. Create or upload one here: it is copied into {device} when it starts.
                </div>
              )}
              <div ref={filesRef} className="kt-devinfo-files-tree">
                <DeviceFilesSection
                  labId={labId}
                  device={device}
                  layout={filesWidth >= FILES_SIDE_BY_SIDE_WIDTH ? "side" : "stacked"}
                  onDirtyChange={onFilesDirty}
                  onChanged={relist}
                />
              </div>
            </div>
          </Tab>
        </Tabs>
      </div>
    </div>
  );
}

function TabTitle({ icon: Icon, label, dirty = false }: { icon: LucideIcon; label: string; dirty?: boolean }) {
  return (
    <span className="d-inline-flex align-items-center">
      <Icon size={14} className="me-1" aria-hidden />
      {label}
      {dirty && (
        <span className="text-warning" title="Unsaved changes" aria-label="Unsaved changes">
          {"\u00a0"}●
        </span>
      )}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="iface">
      <div style={{ fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  );
}

function OverviewTab({ node, machine }: { node: DeviceNode; machine: MachineDetail | null }) {
  return (
    <>
      <Kv k="Type" v={node.typeLabel} />
      <Kv k="Image" v={node.image || "—"} />
      <Kv k="Ifaces" v={node.ifaces.length} />
      {machine?.bridged && <Kv k="Bridged" v="yes (host bridge)" />}
      {machine?.privileged && <Kv k="Privileged" v="yes" />}
      {machine?.ipv6 != null && <Kv k="IPv6" v={machine.ipv6 ? "enabled" : "disabled"} />}
      {machine?.mem && <Kv k="Mem" v={machine.mem} />}
      {machine?.cpus != null && <Kv k="CPUs" v={machine.cpus} />}
      {machine?.shell && <Kv k="Shell" v={machine.shell} />}
      {machine?.num_terms != null && <Kv k="Num Terms" v={machine.num_terms} />}
      {machine?.entrypoint && <Kv k="Entrypoint" v={machine.entrypoint} />}
      {machine?.args && <Kv k="Args" v={machine.args} />}
      {machine && machine.ports.length > 0 && (
        <Section title="Ports">
          {machine.ports.map((p) => (
            <Kv
              key={`${p.host_port}/${p.protocol}`}
              k={formatPort(p)}
              v={
                node.running && p.protocol === "tcp" ? (
                  <a href={`http://${window.location.hostname}:${p.host_port}`} target="_blank" rel="noopener noreferrer">
                    open ↗
                  </a>
                ) : (
                  <span className="hint">{node.running ? "—" : "deploy to open"}</span>
                )
              }
            />
          ))}
        </Section>
      )}
      {machine && Object.keys(machine.envs).length > 0 && (
        <Section title="Env">
          {Object.entries(machine.envs).map(([k, v]) => (
            <Kv key={k} k={k} v={v} />
          ))}
        </Section>
      )}
      {machine && Object.keys(machine.sysctls).length > 0 && (
        <Section title="Sysctls">
          {Object.entries(machine.sysctls).map(([k, v]) => (
            <Kv key={k} k={k} v={String(v)} />
          ))}
        </Section>
      )}
      {machine && machine.ulimits.length > 0 && (
        <Section title="Ulimits">
          {machine.ulimits.map((u) => (
            <Kv key={u.name} k={u.name} v={u.hard != null ? `${u.soft} / ${u.hard}` : `${u.soft}`} />
          ))}
        </Section>
      )}
      {machine && machine.volumes.length > 0 && (
        <Section title="Volumes">
          {machine.volumes.map((v) => (
            <Kv key={`${v.host_path}:${v.guest_path}`} k={v.guest_path} v={`${v.host_path} (${v.mode})`} />
          ))}
        </Section>
      )}
      {machine && Object.keys(machine.metas).length > 0 && (
        <Section title="Other Options">
          {Object.entries(machine.metas).map(([k, v]) => (
            <Kv key={k} k={k} v={v} />
          ))}
        </Section>
      )}
    </>
  );
}

// The warning beside an interface's startup IP when the running device has other addresses on it.
function IpMismatchNote({ mismatch }: { mismatch: IfaceIpMismatch }) {
  const id = useId();
  const running = mismatch.live.join(", ") || "no address";
  const text = `Running ${running}, startup ${mismatch.declared.join(", ")}. ${IP_MISMATCH_HINT}`;
  return (
    <OverlayTrigger placement="top" overlay={<Tooltip id={`ip-mismatch-${id}`}>{text}</Tooltip>}>
      <AlertTriangle size={13} className="text-warning ms-1 align-text-top" tabIndex={0} aria-label={text} />
    </OverlayTrigger>
  );
}

interface NetworkTabProps {
  node: DeviceNode;
  actions: DeviceInfoActions;
  ipMismatches: Record<number, IfaceIpMismatch>;
}

function NetworkTab({ node, actions, ipMismatches }: NetworkTabProps) {
  const running = node.running;
  return (
    <>
      <div className="d-flex align-items-center justify-content-between gap-2 mb-1">
        <span className="hint">
          {running ? "Changes apply to the running device only, not to lab.conf." : "Changes are saved to lab.conf."}
        </span>
        <Button size="sm" variant="outline-secondary" onClick={() => actions.openAddInterface(node)}>
          <Plug size={13} className="me-1" />
          Add Interface
        </Button>
      </div>
      {node.ifaces.length === 0 && <div className="hint">No interfaces.</div>}
      {node.ifaces.map((it) => (
        <div className="iface" key={it.num}>
          <div className="d-flex align-items-center justify-content-between gap-2">
            <span style={{ fontWeight: 600, fontFamily: "monospace" }}>{formatIface(it.num, it.link)}</span>
            <Button
              size="sm"
              variant="outline-danger"
              className="py-0"
              onClick={() => actions.openDisconnect(node, it.link)}
            >
              <Unplug size={13} className="me-1" />
              {running ? "Disconnect" : "Remove"}
            </Button>
          </div>
          {it.ips.length > 0 && (
            <Kv
              k="IP"
              v={
                <>
                  {it.ips.join(", ")}
                  {ipMismatches[it.num] && <IpMismatchNote mismatch={ipMismatches[it.num]} />}
                </>
              }
            />
          )}
          {ipMismatches[it.num] && <Kv k="Running" v={ipMismatches[it.num].live.join(", ") || "no address"} />}
          {it.mac && <Kv k="MAC" v={it.mac} />}
        </div>
      ))}
    </>
  );
}
