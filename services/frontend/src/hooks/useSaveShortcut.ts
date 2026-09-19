import { useEffect, useRef, type RefObject } from "react";
import { useHasFocusWithin } from "./useHasFocusWithin";
import { useDesktopCommand } from "../desktop/DesktopCommands";

// Cmd/Ctrl+S saves, but only when focus is somewhere inside `rootRef` — so this doesn't hijack
// the browser/OS save shortcut when the user's focus is elsewhere on the page.
export function useSaveShortcut(rootRef: RefObject<HTMLElement | null>, onSave: () => void) {
  // Read through a ref so the listener is registered once instead of being torn down and
  // re-added on every render (a `deps` array carrying editor state would churn this on every
  // keystroke).
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const hasFocus = useHasFocusWithin(rootRef);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      if (!hasFocus()) return;
      e.preventDefault();
      onSaveRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasFocus]);

  // The Electron shell's File → Save menu item. Its accelerator is deliberately *not* registered
  // natively (services/desktop/src/menu.ts), so the keystroke still reaches the listener above;
  // this only covers clicking the menu item, and applies the same "is focus mine?" rule.
  useDesktopCommand("lab:save", () => {
    if (hasFocus()) onSaveRef.current();
  });
}
