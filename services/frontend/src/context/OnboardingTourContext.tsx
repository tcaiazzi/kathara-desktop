import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

// Bumped whenever the step list changes meaningfully, so returning users get the updated tour
// once instead of it staying silently stuck on "seen" forever.
const LS_ONBOARDING = "kt-onboarding-tour-v1";

/** What the tour needs from the open workspace. WorkspacePage registers it while it is mounted
 *  (useOnboardingTourWorkspace); until then the tour has nothing to drive. */
export interface TourWorkspace {
  /** Brings a dock panel (e.g. "devices", "files") to the front of its tab group before the tour
   *  highlights it — panels sharing a group show only one at a time. */
  focusPanel(panelId: string): void;
  /** Selects the lab's first device unless one is already selected, so the Inspector step has
   *  something to show (it is blank until a device is selected). */
  selectFirstDevice(): void;
  /** Whether the open lab has any device — the device steps are left out of the tour otherwise. */
  hasDevices(): boolean;
  /** Records the dock's active tabs and the selection, and returns what puts them back: the tour
   *  switches both as it goes, and hands the workspace back as it found it. */
  saveView(): () => void;
}

interface OnboardingTourApi {
  /** `auto: true` (first-time trigger) is a no-op once the tour has been seen or skipped;
   *  `auto: false` (Help menu / navbar replay) always shows it. Both are no-ops until a lab is
   *  actually open — see `useOnboardingTourReady`. */
  requestTour: (opts: { auto: boolean }) => void;
}

interface OnboardingTourInternal extends OnboardingTourApi {
  /** The signal OnboardingTour.tsx watches: bumped every time a tour should actually start. */
  requestCount: number;
  /** True once the workspace has a lab open (so every `data-tour` target exists) — read by
   *  OnboardingTour.tsx before it starts, and by manual replays to no-op gracefully. */
  ready: boolean;
  /** WorkspacePage-only: reports whether a lab is currently open. */
  setTourReady: (ready: boolean) => void;
  /** OnboardingTour.tsx-only: persists "seen" so it never auto-shows again this browser profile. */
  markSeen: () => void;
  /** OnboardingTour.tsx-only: the workspace the tour is walking through, or null. */
  workspace: () => TourWorkspace | null;
  /** WorkspacePage-only: registers (or, with null, withdraws) the workspace. */
  registerWorkspace: (ws: TourWorkspace | null) => void;
}

const OnboardingTourCtx = createContext<OnboardingTourInternal | null>(null);

export function OnboardingTourProvider({ children }: { children: ReactNode }) {
  const [requestCount, setRequestCount] = useState(0);
  const [ready, setReady] = useState(false);
  // A ref, not state: read synchronously inside requestTour, and writing it must never trigger a
  // re-render (nothing here depends on "have we seen it" for rendering).
  const seenRef = useRef(localStorage.getItem(LS_ONBOARDING) === "seen");
  // A ref, not state: purely an imperative escape hatch (like a DOM ref), never read during
  // render — re-rendering the whole tree whenever WorkspacePage's dockview API instance changes
  // identity would be pure waste.
  const workspaceRef = useRef<TourWorkspace | null>(null);

  const setTourReady = useCallback((r: boolean) => setReady(r), []);
  const registerWorkspace = useCallback((ws: TourWorkspace | null) => {
    workspaceRef.current = ws;
  }, []);
  const workspace = useCallback(() => workspaceRef.current, []);

  const markSeen = useCallback(() => {
    seenRef.current = true;
    localStorage.setItem(LS_ONBOARDING, "seen");
  }, []);

  const requestTour = useCallback<OnboardingTourApi["requestTour"]>(({ auto }) => {
    if (auto && seenRef.current) return;
    setRequestCount((c) => c + 1);
  }, []);

  const value = useMemo<OnboardingTourInternal>(
    () => ({
      requestTour,
      requestCount,
      ready,
      setTourReady,
      markSeen,
      workspace,
      registerWorkspace,
    }),
    [requestTour, requestCount, ready, setTourReady, markSeen, workspace, registerWorkspace],
  );

  return <OnboardingTourCtx.Provider value={value}>{children}</OnboardingTourCtx.Provider>;
}

export function useOnboardingTour(): OnboardingTourApi {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTour must be used within an OnboardingTourProvider");
  return { requestTour: ctx.requestTour };
}

/** WorkspacePage-only: reports whether a lab is currently open. Every `data-tour` target is
 *  gated on the same condition (see WorkspacePage's `detail`), so this is exactly the signal the
 *  tour needs before it can safely start. */
export function useOnboardingTourReady(): (ready: boolean) => void {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTourReady must be used within an OnboardingTourProvider");
  return ctx.setTourReady;
}

/** WorkspacePage-only: registers what the tour drives in the open workspace (TourWorkspace). */
export function useOnboardingTourWorkspace(): (ws: TourWorkspace | null) => void {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTourWorkspace must be used within an OnboardingTourProvider");
  return ctx.registerWorkspace;
}

/** OnboardingTour.tsx-only: the raw signal + gating state needed to actually drive driver.js. */
export function useOnboardingTourInternal(): OnboardingTourInternal {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTourInternal must be used within an OnboardingTourProvider");
  return ctx;
}
