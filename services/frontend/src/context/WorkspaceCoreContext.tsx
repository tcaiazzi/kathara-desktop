import { createContext, useContext } from "react";
import type { ContextMenuState } from "../components/TopologyContextMenu";
import type { LabDetail } from "../services/types";

/** Startup scripts of the open lab that changed on disk outside the app (hooks/useLabEvents),
 *  as lab-relative paths; `seq` makes a repeat of the same paths a new value. */
export interface StartupChange {
  paths: string[];
  seq: number;
}

// A narrower, independently-stable slice of WorkspaceCtx (see WorkspaceContext.tsx) for the
// panels that hold a large virtualized tree (LabExplorer, RuntimeFilesystemEditor): just the
// fields whose *identity* only changes when something these panels actually care about changes —
// unlike WorkspaceCtx's `ctxValue`, which is rebuilt as a fresh object on every WorkspacePage
// render (it bundles `deviceActions`, a genuinely-volatile object from useDeviceActions). Reading
// this context instead of the full one means an unrelated re-render elsewhere in the workspace
// (topology hover, a context-menu open, a rail drag) no longer forces every visible tree row to
// re-render.
interface WorkspaceCoreCtx {
  labId: string;
  detail: LabDetail;
  onRefresh: () => Promise<void>;
  /** Re-fetches each device's `<name>.startup` content — call after LabExplorer saves one, so the
   *  Device Information panel's startup preview (fed by useDeviceActions' `startups`) picks up the edit. */
  refreshStartups: () => Promise<void>;
  /** The machine the Runtime Filesystem panel should preselect (set by openRuntimeFsPanel). */
  runtimeFsPreferredMachine: string | null;
  /** The latest outside change to the open lab's startup scripts, or null — see StartupChange. */
  startupChange: StartupChange | null;
  /** Raw selection setter (no side effects) — lets a panel drive the shared selection without
   *  forcing "Device Information" into focus the way WorkspaceCtx's wrapped setter does. */
  setSelectedId: (id: string | null) => void;
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
