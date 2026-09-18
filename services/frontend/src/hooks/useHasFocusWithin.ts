import { useCallback, type RefObject } from "react";

/** Is focus currently somewhere inside `rootRef`?
 *
 * Both keyboard-shortcut hooks scope themselves this way rather than binding globally: a window
 * listener that fired wherever focus happened to be would hijack the browser's own Cmd/Ctrl+S, and
 * would delete a file while the user was typing in an unrelated input.
 */
export function useHasFocusWithin(rootRef: RefObject<HTMLElement | null>): () => boolean {
  return useCallback(() => {
    const active = document.activeElement;
    return Boolean(rootRef.current && active && rootRef.current.contains(active));
  }, [rootRef]);
}
