// The single place that knows whether any editor on screen holds unsaved edits, and the gate every
// navigation that would unmount or re-scope those editors passes through first.
//
// Editors register themselves (useRegisterUnsaved — `useFsTree` does it for both filesystem
// panels); navigations ask before leaving (useGuardedNavigate, useGuardedLinkClick,
// useConfirmDiscardAll). Every such navigation must go through one of these: switching lab or
// opening Settings re-scopes or unmounts the panel holding the buffer, and nothing above that
// panel can otherwise see it is dirty. Closing the desktop window asks through the same dialog
// (the shell holds the close until the answer arrives — services/desktop's attachWindowLifecycle);
// a reload, or closing a browser tab, is covered by the `beforeunload` listener below.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { useNavigate, type NavigateOptions, type To } from "react-router-dom";
import { desktop } from "../desktop/bridge";
import { describeUnsaved } from "../services/unsaved";
import { useConfirm } from "./ConfirmContext";

interface UnsavedChangesApi {
  /** Record `label` as the registrant's dirty buffer, or clear it with null. */
  set(id: string, label: string | null): void;
  /** Resolves true when nothing is dirty or the user agrees to discard every dirty buffer. */
  confirmDiscardAll(): Promise<boolean>;
}

const UnsavedChangesCtx = createContext<UnsavedChangesApi | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  // A ref, not state: registering must not re-render the app on every keystroke that flips a
  // buffer between clean and dirty, and every reader asks at the moment it needs the answer.
  const entries = useRef(new Map<string, string>());

  const set = useCallback((id: string, label: string | null) => {
    if (label === null) entries.current.delete(id);
    else entries.current.set(id, label);
  }, []);

  const confirmDiscardAll = useCallback(async () => {
    const labels = [...entries.current.values()];
    if (labels.length === 0) return true;
    return confirm({ title: "Discard unsaved changes?", message: describeUnsaved(labels), okLabel: "Discard" });
  }, [confirm]);

  // Set once the user has agreed to discard everything for a window close, so the page's own
  // `beforeunload` below doesn't object a second time to the unload that close then causes.
  const leaving = useRef(false);

  // Desktop: the shell asks before closing the window, and the answer comes from the same dialog
  // every in-app navigation uses, instead of a native message box.
  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    return shell.onCloseRequest(async () => {
      const ok = await confirmDiscardAll();
      if (ok) leaving.current = true;
      return ok;
    });
  }, [confirmDiscardAll]);

  // What still guards a reload, a plain browser tab being closed, and a navigation the desktop
  // shell starts itself — none of which can wait for an in-app dialog.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current || entries.current.size === 0) return;
      e.preventDefault();
      // Still required by Chromium for the prompt to appear in a plain browser tab.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const value = useMemo(() => ({ set, confirmDiscardAll }), [set, confirmDiscardAll]);
  return <UnsavedChangesCtx.Provider value={value}>{children}</UnsavedChangesCtx.Provider>;
}

function useUnsavedChanges(): UnsavedChangesApi {
  const ctx = useContext(UnsavedChangesCtx);
  if (!ctx) throw new Error("useUnsavedChanges must be used within an UnsavedChangesProvider");
  return ctx;
}

/** Report this component's dirty buffer (`label` describes it) — null while it is clean. */
export function useRegisterUnsaved(label: string | null): void {
  const { set } = useUnsavedChanges();
  const id = useId();
  useEffect(() => {
    set(id, label);
  }, [id, label, set]);
  useEffect(() => () => set(id, null), [id, set]);
}

/** For an action that throws the open buffers away without navigating (closing a lab, renaming
 *  the open one): ask first, and go ahead only on a true. */
export function useConfirmDiscardAll(): () => Promise<boolean> {
  return useUnsavedChanges().confirmDiscardAll;
}

/** `navigate`, preceded by the discard confirmation; resolves false when the user stays. */
export function useGuardedNavigate(): (to: To, options?: NavigateOptions) => Promise<boolean> {
  const { confirmDiscardAll } = useUnsavedChanges();
  const navigate = useNavigate();
  return useCallback(
    async (to: To, options?: NavigateOptions) => {
      if (!(await confirmDiscardAll())) return false;
      navigate(to, options);
      return true;
    },
    [confirmDiscardAll, navigate],
  );
}

/** An `onClick` for a router `<Link>` that routes the click through useGuardedNavigate. A click
 *  meant for a new window (modifier keys, middle button) is left to the browser. */
export function useGuardedLinkClick(): (to: To) => (e: React.MouseEvent) => void {
  const guardedNavigate = useGuardedNavigate();
  return useCallback(
    (to: To) => (e: React.MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      void guardedNavigate(to);
    },
    [guardedNavigate],
  );
}
