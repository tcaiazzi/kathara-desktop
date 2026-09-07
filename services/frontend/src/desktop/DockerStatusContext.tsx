// Polls the shell's on-demand Docker probe (services/desktop/src/main.ts's "docker:check") so the
// SPA can warn about a stopped-but-installed daemon from inside the workspace instead of never
// getting there — main.ts's Preflight.canStart now boots the app anyway in that case (a check
// with severity: "advisory") and hands the initial reading over on the "ready" status, but that
// status isn't exposed to the renderer today, so this provider's own first probe is what actually
// seeds the badge/banner; a restart-triggering reload (elevation, retry, labs-dir change) just
// remounts this provider and gets a fresh one immediately.
//
// A no-op in the browser build: desktop() is null there, so `status` stays null forever and
// nothing renders (see TitleBar.tsx/WorkspacePage's guards on it) — there's no shell to poll.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "react-bootstrap";
import { desktop, type DesktopDockerStatus } from "./bridge";
import { useToast } from "../context/ToastContext";

const DockerStatusCtx = createContext<DesktopDockerStatus | null>(null);

// Cheap either way (a dead socket answers instantly — verified against `docker info` against a
// bad endpoint), but there's no reason to hammer it once Docker is up: fast while something's
// wrong, so the warning clears quickly once the user starts the daemon; slow once it's fine,
// since a running daemon stopping mid-session is the rare case.
const POLL_MS_DOWN = 5_000;
const POLL_MS_OK = 30_000;

export function DockerStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DesktopDockerStatus | null>(null);
  const toast = useToast();
  // The state a transition-only toast last fired for, so re-renders (or a poll that comes back
  // the same) don't re-toast — only an actual state change should.
  const lastNotified = useRef<DesktopDockerStatus["state"] | null>(null);
  const inFlight = useRef(false);
  // Mirrors `status` for the interval decision below — the effect only runs once (deps: [toast]),
  // so a plain read of the `status` state variable inside it would always see the value from the
  // render that mounted the effect, never a later one from setStatus.
  const currentState = useRef<DesktopDockerStatus["state"] | null>(null);

  useEffect(() => {
    const shell = desktop();
    if (!shell) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await shell.checkDocker();
        if (cancelled) return;
        setStatus(next);
        currentState.current = next.state;

        // Toast on a real transition, and also on the very first reading if it's already down —
        // that's the only way the user learns about it if they never saw the setup page's callout
        // (e.g. Docker was stopped after the app had already booted clean).
        const changed = lastNotified.current !== null && lastNotified.current !== next.state;
        const firstAndDown = lastNotified.current === null && next.state !== "ok";
        if (changed || firstAndDown) {
          const docsUrl = next.docsUrl;
          if (next.state === "ok") {
            toast.show("Docker is running.", "success", "Docker connected");
          } else {
            toast.show(
              next.remedy ?? next.detail,
              "danger",
              "Docker not running",
              docsUrl ? { label: "Learn more", run: () => void shell.openExternal(docsUrl) } : undefined,
            );
          }
        }
        lastNotified.current = next.state;
      } finally {
        inFlight.current = false;
        if (!cancelled) {
          timer = setTimeout(check, currentState.current === "ok" ? POLL_MS_OK : POLL_MS_DOWN);
        }
      }
    };

    void check();

    // The common gesture after starting Docker Desktop is alt-tabbing back to the app — re-probe
    // right away instead of making that wait out the poll interval.
    const onFocus = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [toast]);

  return <DockerStatusCtx.Provider value={status}>{children}</DockerStatusCtx.Provider>;
}

/** Null in the browser build, and until the first probe resolves in the desktop one. */
export function useDockerStatus(): DesktopDockerStatus | null {
  return useContext(DockerStatusCtx);
}

/** Persistent banner shown above the workspace while Docker is down — the badge in TitleBar.tsx
 * is easy to miss, this isn't. Renders nothing once Docker answers again (or in the browser
 * build, or before the first probe resolves). Not user-dismissible: it reflects live state, not a
 * one-off notice, so it should track that state rather than be closeable out of sync with it. */
export function DockerStatusBanner() {
  const status = useDockerStatus();
  if (!status || status.state === "ok") return null;
  return (
    <Alert variant="warning" className="mb-0 rounded-0 py-2">
      <strong>Docker {status.state === "missing" ? "isn't installed" : "isn't running"}.</strong>{" "}
      {status.remedy ?? status.detail}
    </Alert>
  );
}
