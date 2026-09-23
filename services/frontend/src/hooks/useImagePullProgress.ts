import { useEffect, useState } from "react";
import { api } from "../services/api";
import type { ImagePullProgress } from "../services/types";

// 800ms rather than the 1500ms used for startup-status: this drives a byte counter, and at 1.5s
// it visibly stutters. The requests are pure in-memory reads on the backend.
const POLL_MS = 800;

/**
 * Poll the backend's single image-download slot while `active`.
 *
 * Mirrors the startup-status poll in TopologyGraph: a recursive setTimeout, a `cancelled` flag in
 * the cleanup, and dependencies on primitives only. Deliberately no backoff and no cap — a slow
 * first pull is exactly when the live numbers matter most — and errors reschedule silently rather
 * than surfacing, since a transient failure mid-download must never become a toast.
 */
export function useImagePullProgress(active: boolean): ImagePullProgress | null {
  const [progress, setProgress] = useState<ImagePullProgress | null>(null);

  useEffect(() => {
    if (!active) return;
    // Drop the previous download's snapshot before the first fetch lands. Without this the bar
    // renders the *old* download's bytes for a frame (jumping from ~96% back to 0%), and worse, a
    // download adopted from another window is declared finished off the stale terminal frame.
    setProgress(null);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The controller stops the request in flight; `signal.aborted` is what stops the *next* tick
    // being scheduled, since clearTimeout alone can't reach a poll that is mid-request.
    const poll = () => {
      api
        .getImagePullProgress(controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setProgress(next);
          timer = setTimeout(poll, POLL_MS);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
    // `active` only: the endpoint is global (images aren't scoped to a lab), so there is nothing
    // else that could invalidate the poll.
  }, [active]);

  return progress;
}
