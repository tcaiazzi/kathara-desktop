import { useEffect, useMemo, useState } from "react";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { api } from "../services/api";
import { HOST_BRIDGE } from "../services/constants";
import { openTerminalWindow } from "../services/terminalWindow";
import { computeTopology, type DeviceNode, type DomainNode, type TopoModel } from "../services/topology";
import type { LabDetail, PendingMachineFiles } from "../services/types";
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
}

const EMPTY_MODEL: TopoModel = { nodes: [], edges: [] };

// Every device/domain action (deploy, remove, add/remove interface, open a terminal, …) and the
// context-menu item lists that expose them, shared by the topology canvas and the workspace
// sidebar's device list — so "right-click a device" means the exact same thing in both places
// instead of two hand-synced copies that inevitably drift apart.
export function useDeviceActions({ labName, detail, onRefresh, onEditFiles, onOpenTerminal, onOpenRuntimeFs }: UseDeviceActionsOptions) {
  const toast = useToast();
  const confirm = useConfirm();
  const [actionConfig, setActionConfig] = useState<TopoActionConfig | null>(null);
  const [pending, setPending] = useState<Record<string, PendingMachineFiles>>({});

  // Best-effort fetch of queued startup/files so callers (the node-info panel) can show a device's
  // startup script (same source + precedence as the Editor). Inspection-only, errors are ignored.
  useEffect(() => {
    if (!detail) {
      setPending({});
      return;
    }
    let live = true;
    api
      .getPendingFiles(labName)
      .then((p) => {
        if (live) setPending(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [labName, detail]);

  const model = useMemo(() => (detail ? computeTopology(detail, pending) : EMPTY_MODEL), [detail, pending]);

  function findDeviceNode(name: string): DeviceNode | null {
    const nd = model.nodes.find((n) => n.id === `dev:${name}`);
    return nd && nd.type === "dev" ? nd : null;
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
    return (detail?.links ?? [])
      .map((l) => l.name)
      .filter((n) => n && n !== HOST_BRIDGE)
      .sort((a, b) => a.localeCompare(b));
  }

  function openAddDevice(prefillLink: string | null = null) {
    setActionConfig({
      title: "Add device",
      hint: "Adds the device to the lab (saved to lab.conf). If the lab is running, it's also deployed live.",
      submitLabel: "Add device",
      fields: [
        { name: "name", label: "Device name", required: true, placeholder: "pc1" },
        { name: "image", label: "Image", value: "kathara/base", placeholder: "kathara/base" },
        { name: "link", label: "Attach to domain (optional)", value: prefillLink || "", placeholder: "A" },
        {
          name: "bridged",
          label: "Bridged (attach to the host Docker bridge)",
          options: [
            { value: "", label: "no" },
            { value: "true", label: "yes" },
          ],
          value: "",
        },
      ],
      onSubmit: async ({ name, image, link, bridged }) => {
        const cleanName = name.trim();
        if (!cleanName) return false;
        const payload: Parameters<typeof api.addMachine>[1] = { name: cleanName };
        if (image.trim()) payload.image = image.trim();
        if (link.trim()) payload.interfaces = [{ link: link.trim(), number: 0 }];
        if (bridged === "true") payload.bridged = true;
        return withRefresh(() => api.addMachine(labName, payload), `Device "${cleanName}" added.`);
      },
    });
  }

  function openAddDomain() {
    setActionConfig({
      title: "Add collision domain",
      submitLabel: "Add domain",
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
          label: "Collision domain",
          options: domains.map((v) => ({ value: v, label: v })),
          value: domains.includes(prefillLink) ? prefillLink : domains[0],
        }
      : { name: "link", label: "Collision domain", required: true, placeholder: "A", hint: "No domains found — create one first." };
    const macField: TopoActionField = { name: "mac_address", label: "MAC address (optional)", placeholder: "02:00:00:00:00:01" };
    setActionConfig({
      title: running ? `Add interface on ${deviceNode.name} (runtime)` : `Add interface on ${deviceNode.name} (lab.conf)`,
      hint: running
        ? "Live change on the running device — the interface number is assigned automatically and this is not saved to lab.conf."
        : "Static edit — saved to lab.conf and applied on the next deploy.",
      submitLabel: "Add interface",
      // Only a stopped device can take an explicit interface number (Kathara auto-numbers at runtime).
      fields: running
        ? [linkField, macField]
        : [linkField, { name: "interface_number", label: "Interface number", type: "number", value: String(nextIf), required: true, min: 0 }, macField],
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
    const byName = new Map((detail?.machines ?? []).map((m) => [m.name, m]));
    const def = names[0];
    const defUsed = (byName.get(def)?.interfaces ?? []).map((i) => i.num);
    const defNext = defUsed.length ? Math.max(...defUsed) + 1 : 0;
    setActionConfig({
      title: `Add interface to ${domainNode.name}`,
      hint: "Mode follows the chosen device's state: a stopped device edits lab.conf (uses the interface number); a running device is a runtime change (auto-numbered, not saved to lab.conf).",
      submitLabel: "Add interface",
      fields: [
        { name: "machine", label: "Device", options: names.map((v) => ({ value: v, label: v })), value: def },
        { name: "interface_number", label: "Interface number (stopped devices only)", type: "number", value: String(defNext), min: 0 },
        { name: "mac_address", label: "MAC address (optional)", placeholder: "02:00:00:00:00:01" },
      ],
      onSubmit: async ({ machine, interface_number, mac_address }) => {
        const clean = machine.trim();
        if (!clean) return false;
        const running = detail?.machines.find((m) => m.name === clean)?.running ?? false;
        const mac = mac_address.trim() || undefined;
        let num: number | undefined;
        if (!running) {
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
            : `Added eth${num} on ${clean} to ${domainNode.name}.`,
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
      submitLabel: running ? "Disconnect" : "Remove interface",
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

  function openTerminalPopup(deviceNode: DeviceNode) {
    if (!requireRunning(deviceNode)) return;
    openTerminalWindow(labName, deviceNode.name);
  }

  function openWorkspaceTerminal(deviceNode: DeviceNode) {
    if (!requireRunning(deviceNode)) return;
    onOpenTerminal(deviceNode.name);
  }

  function deviceContextItems(nd: DeviceNode): ContextMenuItem[] {
    const items: ContextMenuItem[] = [{ label: "Edit configuration", action: onEditFiles }];
    if (!nd.running) {
      items.push({ label: "Deploy device", success: true, action: () => deployDevice(nd) });
    }
    items.push(
      { label: "Show runtime filesystem", ...runningGate(nd), action: () => openRuntimeFs(nd) },
      { label: "Open terminal", ...runningGate(nd), action: () => openWorkspaceTerminal(nd) },
      { label: "Open terminal popup", ...runningGate(nd), action: () => openTerminalPopup(nd) },
      {
        label: nd.running ? "Add interface (runtime)" : "Add interface (lab.conf)",
        action: () => openAddInterface(nd),
      },
      {
        label: nd.running ? "Disconnect interface (runtime)" : "Remove interface (lab.conf)",
        action: () => openDisconnect(nd),
      },
    );
    items.push(
      nd.running
        ? { label: "Undeploy device", danger: true, action: () => undeployDevice(nd) }
        : { label: "Remove device", danger: true, action: () => removeDevice(nd) },
    );
    return items;
  }

  function domainContextItems(nd: DomainNode): ContextMenuItem[] {
    return [
      { label: "Add device attached here", action: () => openAddDevice(nd.name) },
      { label: "Connect existing device", action: () => openConnectExisting(nd) },
      { label: "Remove domain", danger: true, action: () => removeDomain(nd) },
    ];
  }

  return {
    model,
    pending,
    actionConfig,
    setActionConfig,
    findDeviceNode,
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
    openTerminalPopup,
    openWorkspaceTerminal,
    machineNames,
    domainNames,
    withRefresh,
  };
}
