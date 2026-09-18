import { useEffect, type RefObject } from "react";

/** Close an open popover when a pointer goes down outside `ref`, or on Escape.
 *
 * Only attaches its listeners while `open`, so a closed panel costs nothing.
 *
 * Deliberately not used by every "click outside" in the app: `AutocompleteInput` listens on
 * `document` without an Escape key (it has its own keydown handling), and `TopologyContextMenu`
 * listens for `mousedown` so the menu is gone *before* the click lands on whatever is underneath.
 * Folding those in would change behaviour, not just remove lines.
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
    // `onDismiss` is a stable setState call at both call sites; listing it would re-attach the
    // listeners on every render of the parent for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, open]);
}
