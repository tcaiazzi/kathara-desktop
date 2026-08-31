import { useEffect, useRef, type RefObject } from "react";

// Cmd/Ctrl+S saves, but only when focus is somewhere inside `rootRef` — so this doesn't hijack
// the browser/OS save shortcut when the user's focus is elsewhere on the page.
export function useSaveShortcut(rootRef: RefObject<HTMLElement | null>, onSave: () => void) {
  // Read through a ref so the listener is registered once instead of being torn down and
  // re-added on every render (callers used to pass a `deps` array that included editor state,
  // churning this on every keystroke).
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      const active = document.activeElement;
      if (!rootRef.current || !active || !rootRef.current.contains(active)) return;
      e.preventDefault();
      onSaveRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [rootRef]);
}
