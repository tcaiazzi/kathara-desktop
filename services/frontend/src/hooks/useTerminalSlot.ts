import { useLayoutEffect, useRef } from "react";
import { useTerminalSessions } from "../context/TerminalSessionsContext";

// Shows session `id` inside the returned ref's element for as long as the caller is mounted. A
// layout effect, so the host is in place before the session's own effects measure it. On unmount it
// takes the host out only if the host is still its own: when a session moves, the new slot may
// already have claimed it.
export function useTerminalSlot(id: string) {
  const { hostFor } = useTerminalSessions();
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const host = hostFor(id);
    slot.appendChild(host);
    return () => {
      if (host.parentElement === slot) slot.removeChild(host);
    };
  }, [id, hostFor]);
  return ref;
}
