import { useCallback, useEffect, useRef, type RefObject } from "react";

interface Handlers {
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDelete: () => void;
}

// Cmd/Ctrl+C/X/V and Delete/Backspace act on the fs tree, but only when focus is inside `rootRef`
// (the tree's own container — see the call site's comment for why not the whole panel) and not
// inside a nested editable element (the inline rename <input>), mirroring useSaveShortcut's
// focus-scoping and react-arborist's own default-container.tsx guard for the identical reason.
//
// No OS branch on the key check, same as useSaveShortcut: Cmd and Ctrl are treated as
// interchangeable. Binding both "Delete" and "Backspace" with no platform check already covers
// "Canc on Windows/Linux, Delete on Mac" — macOS's delete key fires "Backspace" in the DOM,
// Windows/Linux's fires "Delete".
export function useFsClipboardShortcuts(rootRef: RefObject<HTMLElement | null>, handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const hasFocus = useCallback(() => {
    const active = document.activeElement;
    return Boolean(rootRef.current && active && rootRef.current.contains(active));
  }, [rootRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!hasFocus()) return;
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      ) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "c") {
        e.preventDefault();
        handlersRef.current.onCopy();
      } else if (mod && key === "x") {
        e.preventDefault();
        handlersRef.current.onCut();
      } else if (mod && key === "v") {
        e.preventDefault();
        handlersRef.current.onPaste();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handlersRef.current.onDelete();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasFocus]);
}
