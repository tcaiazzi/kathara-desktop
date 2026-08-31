import { createContext, useContext } from "react";
import type { ContextMenuState } from "../components/TopologyContextMenu";
import type { LabDetail } from "../services/types";

// A narrower, independently-stable slice of WorkspaceCtx (see WorkspaceContext.tsx) for the
// panels that hold a large virtualized tree (LabExplorer, RuntimeFilesystemEditor): just the
// fields whose *identity* only changes when something these panels actually care about changes —
// unlike WorkspaceCtx's `ctxValue`, which is rebuilt as a fresh object on every WorkspacePage
// render (it bundles `deviceActions`, a genuinely-volatile object from useDeviceActions). Reading
// this context instead of the full one means an unrelated re-render elsewhere in the workspace
// (topology hover, a context-menu open, a rail drag) no longer forces every visible tree row to
// re-render.
export interface WorkspaceCoreCtx {
  labName: string;
  detail: LabDetail;
  onRefresh: () => Promise<void>;
  /** The machine the Runtime Filesystem panel should preselect (set by openRuntimeFsPanel). */
  runtimeFsPreferredMachine: string | null;
  /** Shows/dismisses the shared context menu (rendered once, at the workspace-page level). */
  setContextMenu: (menu: ContextMenuState | null) => void;
}

const Ctx = createContext<WorkspaceCoreCtx | null>(null);

export const WorkspaceCoreProvider = Ctx.Provider;

export function useWorkspaceCore(): WorkspaceCoreCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error("useWorkspaceCore must be used within a WorkspaceCoreProvider");
  return value;
}
