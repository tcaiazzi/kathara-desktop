import { useEffect, useRef } from "react";
import { api } from "../services/api";
import { parseLabEvent } from "../services/labEvents";
import type { LabEvent } from "../services/types";

/** Calls `onEvent` for every lab event the backend streams (GET /api/events — a lab's lab.conf or
 *  startup scripts changed on disk outside this app), for as long as the caller is mounted.
 *
 *  One stream for every lab rather than one per open lab: the list needs to hear about labs that
 *  aren't open too. EventSource reconnects on its own after a dropped connection (a backend
 *  restart, an elevation), so nothing here retries; an event missed in between only means a
 *  refresh that happens on the next one. `onEvent` is read through a ref, so a caller can pass an
 *  inline callback without reopening the stream on every render. */
export function useLabEvents(onEvent: (event: LabEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    void api.labEventsUrl().then((url) => {
      if (cancelled) return;
      source = new EventSource(url);
      source.addEventListener("lab", (message) => {
        const event = parseLabEvent((message as MessageEvent<string>).data);
        if (event) onEventRef.current(event);
      });
    });
    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);
}
