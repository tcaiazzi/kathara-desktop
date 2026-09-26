// Bridges the shell's native menu and kathara:// deep links onto the commands the UI already
// has, without those components needing to know Electron exists.
//
// Pages register what they can do with useDesktopCommand(action, handler); the provider owns
// the single subscription to the shell and dispatches to whatever is currently registered.
// Registration is in a ref rather than state on purpose: a page mounting must not re-render
// the whole app, and a command with no page mounted to handle it is simply a no-op.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { useToast } from "../context/ToastContext";
import { useGuardedNavigate } from "../context/UnsavedChangesContext";
import { api } from "../services/api";
import { labNamed } from "../services/labPlace";
import { desktop, type DesktopMenuAction } from "./bridge";

type Handler = () => void | Promise<void>;

interface Registry {
  register: (action: DesktopMenuAction, handler: Handler) => () => void;
  /** Run an action now — used by the app-drawn menu bar (TitleBar.tsx). */
  dispatch: (action: DesktopMenuAction) => void;
}

const DesktopCommandsContext = createContext<Registry | null>(null);

export function DesktopCommandsProvider({ children }: { children: React.ReactNode }) {
  // Settings and deep links (a kathara:// link, File → Open Lab Folder…) both leave the open lab,
  // so they ask about unsaved edits first, like every in-app navigation.
  const navigate = useGuardedNavigate();
  const toast = useToast();
  // A set per action, not one handler: "Save" is offered by every editor panel on screen, and
  // each decides for itself whether it owns the command (it checks whether focus is inside it),
  // exactly as the Ctrl+S keydown listener in useSaveShortcut already does.
  const handlers = useRef(new Map<DesktopMenuAction, Set<Handler>>());

  const register = useCallback((action: DesktopMenuAction, handler: Handler) => {
    const set = handlers.current.get(action) ?? new Set<Handler>();
    set.add(handler);
    handlers.current.set(action, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) handlers.current.delete(action);
    };
  }, []);

  const dispatch = useCallback(
    (action: DesktopMenuAction) => {
      // Navigation is the provider's own job: it needs no page to be mounted.
      if (action === "view:settings") {
        void navigate("/settings");
        return;
      }
      for (const handler of handlers.current.get(action) ?? []) void handler();
    },
    [navigate],
  );

  useEffect(() => {
    const shell = desktop();
    if (!shell) return;

    // The native Menu still exists (it is what binds the keyboard accelerators), so its clicks
    // and the app-drawn menu's clicks both land here.
    const offMenu = shell.onMenuAction(dispatch);

    // kathara://lab/<name> arrives as a route so react-router can navigate in place, keeping
    // the dock layout and any open terminals. The link carries the lab's name and the Workspace
    // route its id, which only the backend derives, so a `/workspace?lab=<name>` is resolved here,
    // against a freshly fetched list, before navigating: straight to the lab's own route, so a link
    // to the lab already open changes nothing, rather than passing through a route with no lab.
    const offDeepLink = shell.onDeepLink((route) => {
      const url = new URL(route, window.location.origin);
      const name = url.pathname === "/workspace" ? url.searchParams.get("lab") : null;
      if (name === null) {
        void navigate(route);
        return;
      }
      void api
        .listLabs()
        .then((labs) => {
          const lab = labNamed(labs, name);
          if (lab) void navigate(`/workspace/${encodeURIComponent(lab.id)}`);
          else toast.show(`Lab "${name}" not found.`, "danger");
        })
        .catch((e) => toast.reportError("Open lab", e));
    });

    return () => {
      offMenu();
      offDeepLink();
    };
  }, [dispatch, navigate, toast]);

  const value = useMemo(() => ({ register, dispatch }), [register, dispatch]);
  return <DesktopCommandsContext.Provider value={value}>{children}</DesktopCommandsContext.Provider>;
}

/**
 * Make a command available to the native menu for as long as the component is mounted.
 * A no-op in the browser build.
 */
export function useDesktopCommand(action: DesktopMenuAction, handler: Handler): void {
  const registry = useContext(DesktopCommandsContext);
  // Kept in a ref so callers don't have to memoise their handler to avoid re-registering.
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!registry) return;
    return registry.register(action, () => latest.current());
  }, [registry, action]);
}

/** Run a menu command directly — for the app-drawn menu bar. */
export function useDesktopDispatch(): (action: DesktopMenuAction) => void {
  const registry = useContext(DesktopCommandsContext);
  return useCallback((action: DesktopMenuAction) => registry?.dispatch(action), [registry]);
}
