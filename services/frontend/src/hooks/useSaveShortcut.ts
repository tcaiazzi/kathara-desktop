import { useEffect, type RefObject } from "react";

// Cmd/Ctrl+S saves, but only when focus is somewhere inside `rootRef` — so this doesn't hijack
// the browser/OS save shortcut when the user's focus is elsewhere on the page.
export function useSaveShortcut(rootRef: RefObject<HTMLElement | null>, onSave: () => void, deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      const active = document.activeElement;
      if (!rootRef.current || !active || !rootRef.current.contains(active)) return;
      e.preventDefault();
      onSave();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, deps);
}
