// Lab events: changes to a lab's lab.conf or startup scripts made outside this app, streamed by
// the backend (GET /api/events — src/kathara_api/services/kathara_service.py's
// handle_disk_change). Pure, so it can be tested without a DOM; hooks/useLabEvents.ts does the
// EventSource.

import type { ToastVariant } from "./notificationHistory";
import type { LabEvent, LabEventKind } from "./types";

const KINDS: ReadonlySet<LabEventKind> = new Set(["conf-reloaded", "conf-pending", "conf-invalid", "startup", "missing"]);

/** An event from the stream, or null for anything that isn't one. The data is JSON from the
 *  network, typed `unknown` until every field has been checked. */
export function parseLabEvent(data: unknown): LabEvent | null {
  let value: unknown;
  try {
    value = typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { lab_id, kind, files, detail } = value as Record<string, unknown>;
  if (typeof lab_id !== "string" || typeof kind !== "string" || !KINDS.has(kind as LabEventKind)) return null;
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return null;
  if (detail !== null && detail !== undefined && typeof detail !== "string") return null;
  return { lab_id, kind: kind as LabEventKind, files, detail: detail ?? null };
}

/** What to tell the user about an event for the open lab, or null when a refresh says it all.
 *  A startup script changing is routine — it just shows up — whereas a lab.conf the app did or
 *  could not apply changes what the topology means, so that is always said out loud; only one
 *  that can't be loaded at all is an error. A folder that is gone is said out loud too, but not as
 *  an error: nothing about the lab is broken, and it comes back with the folder. */
export function labEventNotice(event: LabEvent): { message: string; variant: ToastVariant } | null {
  switch (event.kind) {
    case "conf-reloaded":
      return { message: "lab.conf changed on disk — the topology was reloaded.", variant: "info" };
    case "conf-pending":
      return {
        message: "lab.conf changed on disk. Undeploy the lab to apply it; the running devices keep the old one.",
        variant: "info",
      };
    case "conf-invalid":
      return {
        message: `lab.conf changed on disk but can't be loaded${event.detail ? `: ${event.detail}` : "."}`,
        variant: "danger",
      };
    case "startup":
      return null;
    case "missing":
      return {
        message: `The lab's folder is no longer there. ${event.detail ?? "It is listed as missing until it comes back."}`,
        variant: "info",
      };
  }
}

/** The lab-relative paths (`/pc1.startup`) of the startup scripts an event says changed. */
export function changedStartupPaths(event: LabEvent): string[] {
  return event.kind === "startup" ? event.files.map((name) => `/${name}`) : [];
}
