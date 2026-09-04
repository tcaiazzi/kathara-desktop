import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useDeployAuthorization } from "../desktop/ElevationContext";
import { api } from "../services/api";
import { visibleLinks } from "../services/constants";
import { openTerminalWindow } from "../services/terminalWindow";
import { computeTopology, type DeviceNode, type DomainNode, type TopoModel } from "../services/topology";
import type { LabDetail } from "../services/types";
import type { TopoActionConfig, TopoActionField } from "../components/TopologyActionModal";
import type { ContextMenuItem } from "../components/TopologyContextMenu";

export interface UseDeviceActionsOptions {
  labName: string;
  // null while the lab detail hasn't loaded yet — every derived value degrades to empty/no-op.
  detail: LabDetail | null;
  onRefresh: () => Promise<void>;
  onEditFiles: () => void;
  // Opens a terminal for `machine` as a panel in the workspace dock (as opposed to
  // openTerminalWindow's separate browser popup — see "Open terminal" vs "Open terminal popup").
  onOpenTerminal: (machine: string) => void;
  // Opens the Runtime Filesystem dock panel, preselecting `machine`.
  onOpenRuntimeFs: (machine: string) => void;
  // Opens the machine-options editor modal for `machine`.
  onOpenOptions: (machine: string) => void;
  // Opens the add-device modal, prefilling "attach to domain" when opened from a domain's context menu.
  onOpenAddDevice: (prefillLink: string | null) => void;
}

const EMPTY_MODEL: TopoModel = { nodes: [], edges: [] };

// Every device/domain action (deploy, remove, add/remove interface, open a terminal, …) and the
// context-menu item lists that expose them, shared by the topology canvas and the workspace
// sidebar's device list — so "right-click a device" means the exact same thing in both places
// instead of two hand-synced copies that inevitably drift apart.
export function useDeviceActions({
  labName,
  detail,
  onRefresh,
  onEditFiles,
  onOpenTerminal,
  onOpenRuntimeFs,
  onOpenOptions,
  onOpenAddDevice,
}: UseDeviceActionsOptions) {
  const toast = useToast();
  const confirm = useConfirm();
  const requestDeployAuth = useDeployAuthorization();
  const [actionConfig, setActionConfig] = useState<TopoActionConfig | null>(null);
  const [startups, setStartups] = useState<Record<string, string>>({});

  // Best-effort fetch of each device's real `<name>.startup` content so callers (the node-info
  // panel) can show it (same source + precedence as the Lab Configuration tab). Inspection-only,
  // errors are ignored.
  //
  // Keyed on `labName` alone, not `detail` — startup *scripts* are lab-static content that only
  // changes via an explicit file edit, unlike `detail` (device/link runtime state), which gets a
  // new object identity on every refresh (deploy, undeploy, connect, a stats poll, ...). Refetching
  // on every one of those was strictly wasted work, and worse, it made `model` below settle in two
  // steps per refresh instead of one — `detail` changing recomputes it immediately with the *old*
  // `startups`, then this fetch resolving recomputes it *again* moments later, and each recompute
  // is a full topology-canvas rebuild in TopologyGraph/useForceLayout (a real, visible flicker;
  // camera-reset was the other half of that, fixed separately in useForceLayout).
  useEffect(() => {
    if (!labName) {
      setStartups({});
      return;
    }
    let live = true;
    api
      .getStartupScripts(labName)
      .then((s) => {
        if (live) setStartups(s);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [labName]);

  const model = useMemo(() => (detail ? computeTopology(detail, startups) : EMPTY_MODEL), [detail, startups]);

  function findDeviceNode(name: string): DeviceNode | null {
    const nd = model.nodes.find((n) => n.id === `dev:${name}`);
    return nd && nd.type === "dev" ? nd : null;
  }

  function findDomainNode(name: string): DomainNode | null {
    const nd = model.nodes.find((n) => n.id === `cd:${name}`);
    return nd && nd.type === "cd" ? nd : null;
  }

  async function withRefresh(work: () => Promise<unknown>, okMsg: string): Promise<boolean> {
    try {
      await work();
      toast.show(okMsg, "success");
      await onRefresh();
      return true;
    } catch (e) {
      toast.reportError("Topology action", e);
      return false;
    }
  }

  function machineNames(): string[] {
    return detail?.machines.map((m) => m.name) ?? [];
  }
  function domainNames(): string[] {
    return visibleLinks(detail?.links ?? [])
      .map((l) => l.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  function openAddDevice(prefillLink: string | null = null) {
    onOpenAddDevice(prefillLink);
  }

  function openAddDomain() {
    setActionConfig({
      title: "Add collision domain",
      submitLabel: "Add Domain",
      fields: [{ name: "name", label: "Domain name", required: true, placeholder: "A" }],
      onSubmit: async ({ name }) => {
        const clean = name.trim();
        if (!clean) return false;
        return withRefresh(() => api.addLink(labName, clean), `Collision domain "${clean}" added.`);
      },
    });
  }

  function openAddInterface(deviceNode: DeviceNode, prefillLink = "") {
    const used = deviceNode.ifaces.map((i) => i.num);
    const nextIf = used.length ? Math.max(...used) + 1 : 0;
    const domains = domainNames();
    const running = deviceNode.running;
    const linkField: TopoActionField = domains.length
      ? {
          name: "link",
          label: "Collision Domain",
          options: domains.map((v) => ({ value: v, label: v })),
          value: domains.includes(prefillLink) ? prefillLink : domains[0],
        }
      : { name: "link", label: "Collision Domain", required: true, placeholder: "A", hint: "No domains found — create one first." };
    const macField: TopoActionField = { name: "mac_address", label: "MAC Address (Optional)", placeholder: "02:00:00:00:00:01" };
    setActionConfig({
      title: running ? `Add interface on ${deviceNode.name} (runtime)` : `Add interface on ${deviceNode.name} (lab.conf)`,
      hint: running
        ? "Live change on the running device — the interface number is assigned automatically and this is not saved to lab.conf."
        : "Static edit — saved to lab.conf and applied on the next deploy.",
      submitLabel: "Add Interface",
      // Only a stopped device can take an explicit interface number (Kathara auto-numbers at runtime).
      fields: running
        ? [linkField, macField]
        : [linkField, { name: "interface_number", label: "Interface Number", type: "number", value: String(nextIf), required: true, min: 0 }, macField],
      onSubmit: async ({ link, interface_number, mac_address }) => {
        const clean = link.trim();
        if (!clean) return false;
        const mac = mac_address.trim() || undefined;
        if (running) {
          return withRefresh(
            () => api.connectMachine(labName, deviceNode.name, clean, undefined, mac),
            `Added interface on ${deviceNode.name} → ${clean} (runtime).`,
          );
        }
        const num = Number.parseInt(interface_number, 10);
        if (!Number.isInteger(num) || num < 0) {
          toast.show("Interface number must be an integer >= 0.", "danger");
          return false;
        }
        return withRefresh(
          () => api.connectMachine(labName, deviceNode.name, clean, num, mac),
          `Added eth${num} on ${deviceNode.name} to ${clean}.`,
        );
      },
    });
  }

  function openConnectExisting(domainNode: DomainNode) {
    const names = machineNames();
    if (!names.length) {
      toast.show("No devices available in this lab.", "danger");
      return;
    }
    setActionConfig({
      title: `Add interface to ${domainNode.name}`,
      hint: "Mode follows the chosen device's state: a stopped device edits lab.conf (uses the interface number); a running device is a runtime change (auto-numbered, not saved to lab.conf).",
      submitLabel: "Add Interface",
      fields: [
        { name: "machine", label: "Device", options: names.map((v) => ({ value: v, label: v })), value: names[0] },
        // Deliberately left empty rather than pre-filled with the first device's next free
        // number: this modal's device is a dropdown, and a pre-filled number would go stale the
        // moment the user picks a different device — submitting a number that device already
        // uses. Empty means "next free one", resolved server-side against the real lab.conf.
        {
          name: "interface_number",
          label: "Interface Number (Stopped Devices Only)",
          type: "number",
          value: "",
          min: 0,
          hint: "Leave empty to use the device's next free interface number.",
        },
        { name: "mac_address", label: "MAC Address (Optional)", placeholder: "02:00:00:00:00:01" },
      ],
      onSubmit: async ({ machine, interface_number, mac_address }) => {
        const clean = machine.trim();
        if (!clean) return false;
        const running = detail?.machines.find((m) => m.name === clean)?.running ?? false;
        const mac = mac_address.trim() || undefined;
        let num: number | undefined;
        if (!running && interface_number.trim()) {
          num = Number.parseInt(interface_number, 10);
          if (!Number.isInteger(num) || num < 0) {
            toast.show("Interface number must be an integer >= 0.", "danger");
            return false;
          }
        }
        return withRefresh(
          () => api.connectMachine(labName, clean, domainNode.name, num, mac),
          running
            ? `Added interface on ${clean} → ${domainNode.name} (runtime).`
            : `Added ${num === undefined ? "an interface" : `eth${num}`} on ${clean} to ${domainNode.name}.`,
        );
      },
    });
  }

  function openDisconnect(deviceNode: DeviceNode) {
    const links = [...new Set(deviceNode.ifaces.map((i) => i.link))];
    if (!links.length) {
      toast.show(`${deviceNode.name} has no interfaces to disconnect.`, "danger");
      return;
    }
    const running = deviceNode.running;
    setActionConfig({
      title: running ? `Disconnect interface on ${deviceNode.name} (runtime)` : `Remove interface on ${deviceNode.name} (lab.conf)`,
      hint: running
        ? "Live change on the running device — not saved to lab.conf."
        : "Static edit — saved to lab.conf and applied on the next deploy.",
      submitLabel: running ? "Disconnect" : "Remove Interface",
      fields: [{ name: "link", label: "Domain", options: links.map((v) => ({ value: v, label: v })), value: links[0] }],
      onSubmit: async ({ link }) => {
        const clean = link.trim();
        if (!clean) return false;
        return withRefresh(
          () => api.disconnectMachine(labName, deviceNode.name, clean),
          running ? `Disconnected ${deviceNode.name} from ${clean} (runtime).` : `Removed ${deviceNode.name}'s interface on ${clean}.`,
        );
      },
    });
  }

  async function removeDevice(deviceNode: DeviceNode) {
    const ok = await confirm({
      title: `Remove ${deviceNode.name}?`,
      message: "This undeploys the device and removes it from the lab topology.",
      okLabel: "Remove",
    });
    if (!ok) return;
    await withRefresh(() => api.removeMachine(labName, deviceNode.name), `Device ${deviceNode.name} removed.`);
  }

  async function deployDevice(deviceNode: DeviceNode) {
    // Only ever requests the "volumes" case — never "both", even if this device happens to also
    // be privileged: that would need the same resume-after-reload machinery the full-lab deploy
    // has (see useLabLifecycleActions.ts), which a single device redeploy has no way to resume
    // into. A privileged device deployed from here fails with the same unhandled PrivilegeError
    // it would today — a pre-existing, narrower gap this doesn't widen.
    const machine = detail?.machines.find((m) => m.name === deviceNode.name);
    // hosthome_mount applies to this device too, same as a full-lab deploy — see
    // useLabLifecycleActions.ts's identical check for why it's fetched fresh rather than cached.
    const hosthomeMount = await api
      .getSettings()
      .then((s) => !!s.hosthome_mount)
      .catch(() => false);
    if ((machine && machine.volumes.length > 0) || hosthomeMount) {
      const outcome = await requestDeployAuth({
        privileged: false,
        volumeMachines: machine ? [machine] : [],
        hosthomeMount,
      });
      if (outcome !== "proceed") return;
    }
    await withRefresh(() => api.deployDevice(labName, deviceNode.name), `Device ${deviceNode.name} deployed.`);
  }

  async function undeployDevice(deviceNode: DeviceNode) {
    const ok = await confirm({
      title: `Undeploy ${deviceNode.name}?`,
      message: "Undeploy the device.",
      okLabel: "Undeploy",
    });
    if (!ok) return;
    await withRefresh(() => api.undeployDevice(labName, deviceNode.name), `Device ${deviceNode.name} undeployed.`);
  }

  async function removeDomain(domainNode: DomainNode) {
    const ok = await confirm({
      title: `Remove ${domainNode.name}?`,
      message: "The domain will be undeployed and removed.",
      okLabel: "Remove",
    });
    if (!ok) return;
    await withRefresh(() => api.removeLink(labName, domainNode.name), `Collision domain ${domainNode.name} removed.`);
  }

  function runningGate(nd: DeviceNode): { disabled?: boolean; title?: string } {
    return nd.running ? {} : { disabled: true, title: "Machine is stopped. Deploy/start it first." };
  }

  function requireRunning(nd: DeviceNode): boolean {
    if (nd.running) return true;
    toast.show(`Machine ${nd.name} is stopped. Deploy/start it first.`, "danger");
    return false;
  }

  function openRuntimeFs(deviceNode: DeviceNode) {
    if (!requireRunning(deviceNode)) return;
    onOpenRuntimeFs(deviceNode.name);
  }

  // No running-gate here (unlike openRuntimeFs/openTerminalPopup) — editing options requires the
  // lab to be *stopped*, the opposite condition, and the modal itself already shows a clear
  // undeploy-first message and a read-only view when the lab is deployed.
  function openOptions(deviceNode: DeviceNode) {
    onOpenOptions(deviceNode.name);
  }

  function openTerminalPopup(deviceNode: DeviceNode) {
    if (!requireRunning(deviceNode)) return;
    openTerminalWindow(labName, deviceNode.name);
  }

  function openWorkspaceTerminal(deviceNode: DeviceNode) {
    if (!requireRunning(deviceNode)) return;
    onOpenTerminal(deviceNode.name);
  }

  function deviceContextItems(nd: DeviceNode): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: "Edit Configuration", action: onEditFiles },
      { label: detail?.deployed ? "View Options" : "Edit Options", action: () => openOptions(nd) },
    ];
    if (!nd.running) {
      items.push({ label: "Deploy Device", success: true, action: () => deployDevice(nd) });
    }
    items.push(
      { label: "Show Runtime Filesystem", ...runningGate(nd), action: () => openRuntimeFs(nd) },
      { label: "Open Terminal", ...runningGate(nd), action: () => openWorkspaceTerminal(nd) },
      { label: "Open Terminal Popup", ...runningGate(nd), action: () => openTerminalPopup(nd) },
      {
        label: nd.running ? "Add Interface (Runtime)" : "Add Interface (lab.conf)",
        action: () => openAddInterface(nd),
      },
      {
        label: nd.running ? "Disconnect Interface (Runtime)" : "Remove Interface (lab.conf)",
        action: () => openDisconnect(nd),
      },
    );
    items.push(
      nd.running
        ? { label: "Undeploy Device", danger: true, action: () => undeployDevice(nd) }
        : { label: "Remove Device", danger: true, action: () => removeDevice(nd) },
    );
    return items;
  }

  function domainContextItems(nd: DomainNode): ContextMenuItem[] {
    return [
      { label: "Add Device Attached Here", action: () => openAddDevice(nd.name) },
      { label: "Connect Existing Device", action: () => openConnectExisting(nd) },
      { label: "Remove Domain", danger: true, action: () => removeDomain(nd) },
    ];
  }

  return {
    model,
    startups,
    actionConfig,
    setActionConfig,
    findDeviceNode,
    findDomainNode,
    deviceContextItems,
    domainContextItems,
    openAddDevice,
    openAddDomain,
    openAddInterface,
    openConnectExisting,
    openDisconnect,
    removeDevice,
    deployDevice,
    undeployDevice,
    removeDomain,
    openRuntimeFs,
    openOptions,
    openTerminalPopup,
    openWorkspaceTerminal,
    machineNames,
    domainNames,
    withRefresh,
  };
}

export type UseDeviceActions = ReturnType<typeof useDeviceActions>;
