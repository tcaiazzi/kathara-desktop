import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

// Bumped whenever the step list changes meaningfully, so returning users get the updated tour
// once instead of it staying silently stuck on "seen" forever.
const LS_ONBOARDING = "kt-onboarding-tour-v1";

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
  /** OnboardingTour.tsx-only: switches the dock to the given panel id (e.g. "devices", "files")
   *  before highlighting it — those two share one tab group, so only one is ever visually active,
   *  and the tour needs to bring forward whichever one its current step is actually about. A
   *  no-op until WorkspacePage registers the real implementation (see `registerFocusPanel`). */
  focusPanel: (panelId: string) => void;
  /** WorkspacePage-only: wires `focusPanel` to its own dockview API instance. */
  registerFocusPanel: (fn: (panelId: string) => void) => void;
  /** OnboardingTour.tsx-only: selects the lab's first device so the "Node info" step has
   *  something to actually show — that panel renders nothing until a device is selected. A
   *  no-op until WorkspacePage registers the real implementation. */
  selectFirstDevice: () => void;
  /** WorkspacePage-only: wires `selectFirstDevice` to its own `setSelectedId`. */
  registerSelectFirstDevice: (fn: () => void) => void;
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
  const focusPanelImpl = useRef<(panelId: string) => void>(() => {});
  const selectFirstDeviceImpl = useRef<() => void>(() => {});

  const setTourReady = useCallback((r: boolean) => setReady(r), []);
  const registerFocusPanel = useCallback((fn: (panelId: string) => void) => {
    focusPanelImpl.current = fn;
  }, []);
  const focusPanel = useCallback((panelId: string) => focusPanelImpl.current(panelId), []);
  const registerSelectFirstDevice = useCallback((fn: () => void) => {
    selectFirstDeviceImpl.current = fn;
  }, []);
  const selectFirstDevice = useCallback(() => selectFirstDeviceImpl.current(), []);

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
      focusPanel,
      registerFocusPanel,
      selectFirstDevice,
      registerSelectFirstDevice,
    }),
    [
      requestTour,
      requestCount,
      ready,
      setTourReady,
      markSeen,
      focusPanel,
      registerFocusPanel,
      selectFirstDevice,
      registerSelectFirstDevice,
    ],
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

/** WorkspacePage-only: lets the tour bring a dock panel (e.g. "devices", "files") to the front
 *  of its tab group before highlighting it. */
export function useOnboardingTourFocusPanel(): (fn: (panelId: string) => void) => void {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTourFocusPanel must be used within an OnboardingTourProvider");
  return ctx.registerFocusPanel;
}

/** WorkspacePage-only: lets the tour select the lab's first device (so "Node info" has something
 *  to show) before that step is highlighted. */
export function useOnboardingTourSelectFirstDevice(): (fn: () => void) => void {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTourSelectFirstDevice must be used within an OnboardingTourProvider");
  return ctx.registerSelectFirstDevice;
}

/** OnboardingTour.tsx-only: the raw signal + gating state needed to actually drive driver.js. */
export function useOnboardingTourInternal(): OnboardingTourInternal {
  const ctx = useContext(OnboardingTourCtx);
  if (!ctx) throw new Error("useOnboardingTourInternal must be used within an OnboardingTourProvider");
  return ctx;
}
