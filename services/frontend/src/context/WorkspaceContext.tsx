import { createContext, useContext } from "react";
import type { UseDeviceActions } from "../hooks/useDeviceActions";
import type { ContextMenuState } from "../components/TopologyContextMenu";
import type { SelectionGuard } from "../components/DeviceInfoTabs";
import type { LabDetail } from "../services/types";

// Shared live state for the Workspace's dockview panels. dockview-react renders panels within the
// same React tree (via portals), so panels read this context and re-render when `detail` updates —
// panels get live data instead of static addPanel params.
export interface WorkspaceCtx {
  labId: string;
  detail: LabDetail;
  selectedId: string | null;
  /** Selects a node and brings the Inspector forward. Resolves false when the user keeps an
   *  unsaved edit there instead (see registerSelectionGuard). */
  setSelectedId: (id: string | null) => Promise<boolean>;
  /** Selects a device and opens its configuration in the Inspector. */
  configureDevice: (machine: string) => void;
  /** The latest configureDevice request; `seq` makes a repeat for the same device a new value. */
  configureRequest: { device: string; seq: number } | null;
  /** Installs the check every selection change passes first — the Inspector's, for its edits. */
  registerSelectionGuard: (guard: SelectionGuard | null) => void;
  /** Open a live terminal for a device as a new dockview panel. */
  openTerminal: (machine: string) => void;
  /** Switch to the Runtime Filesystem dock panel, preselecting `machine`. */
  openRuntimeFsPanel: (machine: string) => void;
  /** DOM node of the Inspector dock panel, or null when that panel is closed. The
   *  topology portals its inspector into it, so the inspector lives in a draggable/closable dock
   *  panel. */
  nodeInfoHost: HTMLElement | null;
  setNodeInfoHost: (el: HTMLElement | null) => void;
  /** The single useDeviceActions instance for this workspace, shared by the topology canvas and
   *  the device rail/table — see useDeviceActions.tsx for why there must be only one. */
  deviceActions: Pick<
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
    | "removeDevice"
    | "openRuntimeFs"
    | "openOptions"
    | "openTerminalPopup"
    | "openWorkspaceTerminal"
    | "machineNames"
  >;
  /** Shows/dismisses the shared context menu (rendered once, at the workspace-page level). */
  setContextMenu: (menu: ContextMenuState | null) => void;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

export const WorkspaceProvider = Ctx.Provider;

export function useWorkspace(): WorkspaceCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace must be used within a WorkspaceProvider");
  return value;
}
