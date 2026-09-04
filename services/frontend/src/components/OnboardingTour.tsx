import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { useEffect, useRef } from "react";
import { useToast } from "../context/ToastContext";
import { useOnboardingTourInternal } from "../context/OnboardingTourContext";
import { useDesktopCommand } from "../desktop/DesktopCommands";
import "./OnboardingTour.css";

interface TourStep {
  element: string | (() => Element);
  popover: { title: string; description: string };
  /** Dockview panel id to bring to the front of its tab group before this step is highlighted
   *  (see `groupElement` — those panels' *content* only exists behind whichever tab is active). */
  tourPanel?: string;
  /** "Node info" is blank until a device is selected — this step picks the first one first. */
  tourSelectFirstDevice?: boolean;
}

// Node info/Devices/Lab Configuration/Runtime FS/Stats share one dockview group: one tab strip
// (dockview-core's `.dv-tab` per tab, see DockTab in WorkspacePage.tsx) sitting on one shared
// content area below it (`.dv-groupview` wraps both — see dockviewGroupPanelModel.js's
// `container.append(tabsContainer.element, contentContainer.element)`). The whole panel — tab
// strip *and* content, not just the tab pill — is what should light up, so each step resolves its
// `data-tour="…-tab"` anchor up to that shared `.dv-groupview` ancestor.
function groupElement(tourId: string): () => Element {
  return () => document.querySelector(`[data-tour="${tourId}"]`)?.closest(".dv-groupview") as Element;
}

// Orientation only — no step forces an action (create/deploy/etc.), matching WelcomeScreen's own
// "no wizard, just an on-ramp" policy. Every target is a `data-tour` attribute added in
// WorkspacePage.tsx (or, for the topology's own hint row, TopologyGraph.tsx), all of which only
// exist once a lab is open (see `ready` below).
const STEPS: TourStep[] = [
  {
    element: '[data-tour="rail"]',
    popover: {
      title: "Your labs",
      description: "Every lab you create or import shows up here. Click one to open it, right-click for more actions.",
    },
  },
  {
    element: '[data-tour="import-row"]',
    popover: {
      title: "Add a lab",
      description: "Start from scratch with New, import a .zip with Upload, or Browse the Kathara Labs gallery for ready-made examples.",
    },
  },
  {
    element: '[data-tour="topology-panel"]',
    popover: {
      title: "Topology",
      description: "This is your network: devices and links, drawn live. Drag to rearrange, right-click to add or edit.",
    },
  },
  {
    element: groupElement("node-info-tab"),
    tourPanel: "node-info",
    tourSelectFirstDevice: true,
    popover: {
      title: "Device Information",
      description: "Click any device — in the topology or the Devices list — to see its details here: interfaces, image, running state.",
    },
  },
  {
    element: '[data-tour="node-actions-btn"]',
    tourPanel: "node-info",
    popover: {
      title: "Actions",
      description: "Everything you can do with this device — it only ever shows the options that actually apply to it right now (running vs. stopped, and so on).",
    },
  },
  {
    element: groupElement("devices-tab"),
    tourPanel: "devices",
    popover: {
      title: "Lab Details",
      description: "All devices in this lab, with their running state. Select one for details, or open a terminal on it.",
    },
  },
  {
    element: groupElement("files-tab"),
    tourPanel: "files",
    popover: {
      title: "Lab Configuration",
      description: "Edit lab.conf and each device's startup/shutdown scripts directly here.",
    },
  },
  {
    element: groupElement("runtime-fs-tab"),
    tourPanel: "runtime-fs",
    popover: {
      title: "Runtime Filesystem",
      description: "Browse and edit a running device's live filesystem — no shell required.",
    },
  },
  {
    element: groupElement("stats-tab"),
    tourPanel: "stats",
    popover: {
      title: "Statistics",
      description: "Live CPU, memory and network usage for every device, once the lab is deployed.",
    },
  },
  {
    element: '[data-tour="terminal-btn"]',
    popover: {
      title: "Terminals",
      description: "Open a shell on any running device — you can have several at once, tiled or tabbed.",
    },
  },
  {
    element: '[data-tour="layout-btn"]',
    popover: {
      title: "Layouts",
      description: "Switch between preset arrangements — focus topology, focus editing, focus terminals — or reset to the default.",
    },
  },
  {
    element: '[data-tour="deploy-btn"]',
    popover: {
      title: "Deploy",
      description: "When you're ready, Deploy spins up every device as a container. Undeploy tears it back down.",
    },
  },
  {
    element: '[data-tour="download-btn"]',
    popover: {
      title: "Download",
      description: "Export this lab as a .zip — to share it, back it up, or move it to another machine.",
    },
  },
  {
    element: '[data-tour="delete-btn"]',
    popover: {
      title: "Delete",
      description: "Permanently removes this lab and its files. Undeploy it first if it's still running.",
    },
  },
];

// Bounded so a target that never appears (e.g. its panel got closed/collapsed between the
// request and this poll) gives up instead of retrying forever.
const MAX_POLL_FRAMES = 30;

/** Mounted once in App.tsx. Owns the driver.js instance; App state (is a lab open, has the tour
 *  already been requested) lives in OnboardingTourContext so the Help menu / navbar trigger don't
 *  need to reach into this component directly. */
export function OnboardingTour() {
  const { requestCount, ready, markSeen, requestTour, focusPanel, selectFirstDevice } = useOnboardingTourInternal();
  const toast = useToast();
  const driverRef = useRef<Driver | null>(null);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  // Reachable from the (hidden on Win/Linux, real on macOS) native Help menu — see
  // services/desktop/src/menu.ts's "help:tour" entry. A no-op in the browser build.
  useDesktopCommand("help:tour", () => requestTour({ auto: false }));

  useEffect(() => {
    if (requestCount === 0) return; // initial mount — nothing was actually requested yet
    if (!readyRef.current) {
      toast.show("Open a lab first to start the tour.", "info");
      return;
    }

    let cancelled = false;
    let frame = 0;

    function start() {
      if (cancelled) return;
      driverRef.current?.destroy();

      const driverObj = driver({
        showProgress: true,
        showButtons: ["next", "previous", "close"],
        nextBtnText: "Next",
        prevBtnText: "Back",
        doneBtnText: "Got it",
        overlayClickBehavior: "close",
        smoothScroll: true,
        stagePadding: 8,
        popoverClass: "kt-tour-popover",
        steps: STEPS,
        onHighlightStarted: (element, driveStep) => {
          const step = driveStep as TourStep;

          // "Node info" is blank until a device is selected — pick the first one so this step
          // has real content to point at, same as any user clicking a device would trigger.
          if (step.tourSelectFirstDevice) selectFirstDevice();

          // The whole group box is highlighted (see `groupElement`) regardless of which of its
          // tabs is active, but the *content* shown inside it isn't — bring the right one forward
          // so what's actually visible under the spotlight matches what this step is about.
          if (step.tourPanel) focusPanel(step.tourPanel);

          // A target that's been collapsed/hidden between the request and this step (e.g. a
          // dockview group the user shrank mid-tour) gets skipped instead of showing a spotlight
          // on nothing.
          if (!element) return;
          const r = element.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) {
            if (driverObj.hasNextStep()) driverObj.moveNext();
            else driverObj.destroy();
          }
        },
        onDestroyStarted: () => {
          markSeen();
          driverObj.destroy();
        },
      });

      driverRef.current = driverObj;
      driverObj.drive();
    }

    const firstStepSelector = STEPS[0].element as string; // rail — always a plain selector

    function poll() {
      if (cancelled) return;
      if (document.querySelector(firstStepSelector)) {
        start();
        return;
      }
      frame += 1;
      if (frame < MAX_POLL_FRAMES) requestAnimationFrame(poll);
    }
    requestAnimationFrame(poll);

    return () => {
      cancelled = true;
    };
    // `readyRef` is a ref (read live, not a dep by design); `toast`/`markSeen`/`focusPanel`/
    // `selectFirstDevice` are stable across renders. Only a new request should ever restart this
    // effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestCount]);

  useEffect(() => () => driverRef.current?.destroy(), []);

  return null;
}
