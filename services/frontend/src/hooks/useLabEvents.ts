import { useEffect, useRef } from "react";
import { api, onAuthTokenChange } from "../services/api";
import { parseLabEvent } from "../services/labEvents";
import type { LabEvent } from "../services/types";

/** Calls `onEvent` for every lab event the backend streams (GET /api/events — a lab's lab.conf or
 *  startup scripts changed on disk outside this app, or its devices were started or stopped outside
 *  it), for as long as the caller is mounted.
 *
 *  One stream for every lab rather than one per open lab: the list needs to hear about labs that
 *  aren't open too. EventSource reconnects on its own when the connection drops but the backend
 *  stays where it was (a dev server's `--reload`). A backend the desktop shell restarts at the
 *  same address, while the page stays for its unsaved edits, has a new pairing token instead: the
 *  old `?token=` URL would be refused for good, so the stream is reopened on the new one
 *  (onAuthTokenChange). A retry or a labs-dir change reloads the page, which mounts this hook
 *  afresh. An event missed in between only means a refresh that happens on the
 *  next one. `onEvent` is read through a ref, so a caller can pass an inline callback without
 *  reopening the stream on every render. */
export function useLabEvents(onEvent: (event: LabEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    const open = () => {
      void api.labEventsUrl().then((url) => {
        if (cancelled) return;
        source?.close();
        source = new EventSource(url);
        source.addEventListener("lab", (message) => {
          const event = parseLabEvent((message as MessageEvent<string>).data);
          if (event) onEventRef.current(event);
        });
      });
    };
    open();
    const unsubscribe = onAuthTokenChange(open);
    return () => {
      cancelled = true;
      unsubscribe();
      source?.close();
    };
  }, []);
}
