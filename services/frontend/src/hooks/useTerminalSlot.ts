import { useLayoutEffect, useRef } from "react";
import { useTerminalSessions } from "../context/TerminalSessionsContext";

// Shows `element` inside the returned ref's element for as long as the caller is mounted. A layout
// effect, so the element is in place before the session's own effects measure or focus it. On
// unmount it takes the element out only if it is still its own: when a session moves, the new slot
// may already have claimed it.
export function useElementSlot(element: HTMLElement) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(element);
    return () => {
      if (element.parentElement === slot) slot.removeChild(element);
    };
  }, [element]);
  return ref;
}

/** Shows session `id` (its host element, TerminalSessionsContext) inside the returned ref's element. */
export function useTerminalSlot(id: string) {
  const { hostFor } = useTerminalSessions();
  return useElementSlot(hostFor(id));
}
