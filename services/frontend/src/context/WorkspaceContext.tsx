import { createContext, useContext } from "react";
import type { LabDetail } from "../services/types";

// Shared live state for the Workspace's dockview panels. dockview-react renders panels within the
// same React tree (via portals), so panels read this context and re-render when `detail` updates —
// panels get live data instead of static addPanel params.
export interface WorkspaceCtx {
  labName: string;
  detail: LabDetail;
  onRefresh: () => Promise<void>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  openFilesPanel: () => void;
  /** Open a live terminal for a device as a new dockview panel. */
  openTerminal: (machine: string) => void;
  /** Switch to the Runtime Filesystem dock panel, preselecting `machine`. */
  openRuntimeFsPanel: (machine: string) => void;
  /** The machine the Runtime Filesystem panel should preselect (set by openRuntimeFsPanel). */
  runtimeFsPreferredMachine: string | null;
  /** DOM node of the "Node info" dock panel, or null when that panel is closed. The topology
   *  portals its inspector into it, so node info lives in a draggable/closable dock panel. */
  nodeInfoHost: HTMLElement | null;
  setNodeInfoHost: (el: HTMLElement | null) => void;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

export const WorkspaceProvider = Ctx.Provider;

export function useWorkspace(): WorkspaceCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspace must be used within a WorkspaceProvider");
  return value;
}
