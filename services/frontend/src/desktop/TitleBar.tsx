// The app-drawn title bar used in the Electron shell: one strip carrying the brand, an HTML menu
// bar, the window title and the status cluster. The native pair it stands in for is switched off
// in the shell (`titleBarStyle: "hidden"` plus `setMenuBarVisibility(false)`, see
// services/desktop/src/windows.ts). On Windows/Linux it also draws its own minimize/maximize/close
// buttons at the far right (see the caption-buttons cluster below) — Chromium's own Window
// Controls Overlay only lets a page tint those buttons' background, not restyle their icons,
// which is exactly what looked out of place; on macOS the native traffic lights are left alone
// (inset via CSS, see TitleBar.css) since there is nothing to improve there — bar fullscreen,
// where the system hides them and the inset goes with them.
//
// The menu labels and accelerators mirror the native Menu in services/desktop/src/menu.ts, which
// stays registered but hidden — that Menu is what binds the keyboard accelerators. Keep the two
// in step when adding an item.
import { Copy, Minus, Settings as SettingsIcon, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { HealthBadge, PrivilegedBadge } from "../components/StatusBadges";
import { useOpenLabName } from "../context/OpenLabNameContext";
import { useGuardedLinkClick } from "../context/UnsavedChangesContext";
import { useDismissOnOutside } from "../hooks/useDismissOnOutside";
import { Badge } from "react-bootstrap";
import { Link, useLocation } from "react-router-dom";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { ImageDownloadBadge } from "../components/ImageDownloadBadge";
import { NotificationsPanel } from "../components/NotificationsPanel";
import { useTheme } from "../hooks/useTheme";
import { DOCS_URL, ISSUES_URL } from "../services/constants";
import { adjacentMenu, firstFocusable, lastFocusable, nextFocusable } from "../services/menuNav";
import { desktop, type DesktopMenuAction } from "./bridge";
import { useDesktopDispatch } from "./DesktopCommands";
import { useDockerStatus } from "./DockerStatusContext";
import "./TitleBar.css";

interface Item {
  label: string;
  accel?: string;
  run?: () => void;
  disabled?: boolean;
}
type Entry = Item | "separator";

function isSeparator(entry: Entry): entry is "separator" {
  return entry === "separator";
}

/** The items of the open menu, in order; separators are not items. */
function openMenuItems(bar: HTMLElement | null): HTMLButtonElement[] {
  return [...(bar?.querySelectorAll<HTMLButtonElement>('.kt-titlebar-dropdown [role="menuitem"]') ?? [])];
}

function menuButtons(bar: HTMLElement | null): HTMLButtonElement[] {
  return [...(bar?.querySelectorAll<HTMLButtonElement>(".kt-titlebar-menu-btn") ?? [])];
}

export function TitleBar() {
  const { theme, dark } = useTheme();
  const docker = useDockerStatus();
  const dispatch = useDesktopDispatch();
  const location = useLocation();
  const guardedClick = useGuardedLinkClick();
  const shell = desktop();

  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  // Where focus was before a menu opened. Commands like Save act on whichever editor panel has
  // focus (useSaveShortcut), so focus has to be put back before the command runs — a native menu
  // never takes it away, an HTML one does.
  const focusBeforeMenu = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!shell) return;
    let cancelled = false;
    void shell.getAppInfo().then((info) => {
      if (!cancelled) setVersion(info.version);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [shell]);

  // The maximize/restore button's icon has to track every way the window can change state, not
  // just clicks on the button itself: double-clicking the drag region, Aero Snap, dragging to a
  // screen edge. Same for fullscreen, which macOS's strip reads to drop its traffic-light inset
  // (TitleBar.css) and which the native green button can toggle behind our back. The shell pushes
  // the real state after any of those (windows.ts's createMainWindow), so this only needs to read
  // the initial values and then listen.
  useEffect(() => {
    if (!shell) return;
    let cancelled = false;
    void shell.isWindowMaximized().then((v) => {
      if (!cancelled) setMaximized(v);
    }).catch(() => {});
    void shell.isWindowFullScreen().then((v) => {
      if (!cancelled) setFullscreen(v);
    }).catch(() => {});
    const off = shell.onWindowStateChange((state) => {
      setMaximized(state.maximized);
      setFullscreen(state.fullscreen);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [shell]);

  // Click-outside and Escape close the menu, as a native menu would.
  useDismissOnOutside(barRef, open !== null, () => setOpen(null));

  // Which item to focus once a menu has rendered. Set when a menu opens from the keyboard, or
  // ←/→ move to the next menu; never for a mouse open, which leaves focus in the page as a native
  // menu does — until an arrow key is pressed.
  const [focusRequest, setFocusRequest] = useState<"first" | "last" | null>(null);
  useEffect(() => {
    if (open === null || focusRequest === null) return;
    const items = openMenuItems(barRef.current);
    const focusable = items.map((b) => !b.disabled);
    const i = focusRequest === "first" ? firstFocusable(focusable) : lastFocusable(focusable);
    // A menu with every item disabled (Lab, with no lab open) keeps focus on its own button, so
    // the keyboard is never left on the page body.
    if (i >= 0) items[i].focus();
    else menuButtons(barRef.current)[titlesRef.current.indexOf(open)]?.focus();
    setFocusRequest(null);
  }, [open, focusRequest]);

  // The menu titles, for ←/→ below, which run outside a render.
  const titlesRef = useRef<string[]>([]);

  // Keyboard inside an open menu, following the WAI-ARIA menu pattern: ↑/↓ walk the items (skipping
  // separators and disabled ones, wrapping), Home/End jump to either end, ←/→ switch menu, Escape
  // closes and gives focus back, Tab closes and lets focus move on. Enter and Space are the item
  // buttons' own. Listens in the capture phase, ahead of useDismissOnOutside's Escape: that one
  // closes the menu, and React re-renders between the two listeners, so reading the open menu's
  // items after it would find none.
  useEffect(() => {
    if (open === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const items = openMenuItems(barRef.current);
      const focusable = items.map((b) => !b.disabled);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const focusAt = (i: number) => {
        if (i >= 0) items[i].focus();
      };
      switch (e.key) {
        case "ArrowDown":
          focusAt(nextFocusable(focusable, current, 1));
          break;
        case "ArrowUp":
          focusAt(nextFocusable(focusable, current, -1));
          break;
        case "Home":
          focusAt(firstFocusable(focusable));
          break;
        case "End":
          focusAt(lastFocusable(focusable));
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          const titles = titlesRef.current;
          setOpen(titles[adjacentMenu(titles.length, titles.indexOf(open), e.key === "ArrowRight" ? 1 : -1)]);
          setFocusRequest("first");
          break;
        }
        case "Escape":
          // useDismissOnOutside closes the menu; this only puts focus back where it came from.
          if (current >= 0) {
            (focusBeforeMenu.current ?? menuButtons(barRef.current)[titlesRef.current.indexOf(open)])?.focus();
          }
          return;
        case "Tab":
          // From the menu's own button, so Tab moves on from the menu bar instead of from an item
          // that is gone by the time the browser moves focus.
          if (current >= 0) menuButtons(barRef.current)[titlesRef.current.indexOf(open)]?.focus();
          setOpen(null);
          return;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const platform = shell?.platform ?? "linux";
  const mod = platform === "darwin" ? "⌘" : "Ctrl";

  const command = useCallback(
    (action: DesktopMenuAction) => () => {
      focusBeforeMenu.current?.focus();
      dispatch(action);
    },
    [dispatch],
  );

  const openLabName = useOpenLabName();
  const noLab = !openLabName;

  const menus: { title: string; items: Entry[] }[] = [
    {
      title: "File",
      items: [
        { label: "New Lab…", accel: `${mod}+N`, run: command("lab:new") },
        { label: "Open Lab Folder…", accel: `${mod}+O`, run: () => void shell?.openLabFolder().catch(() => {}) },
        { label: "Import Lab (.zip)…", accel: `${mod}+Shift+O`, run: command("lab:import") },
        { label: "Browse Kathara Labs…", run: command("lab:browse") },
        "separator",
        { label: "Save", accel: `${mod}+S`, run: command("lab:save") },
        "separator",
        { label: "Show Labs Folder", run: () => void shell?.openLabsFolder().catch(() => {}) },
        "separator",
        { label: "Quit", accel: `${mod}+Q`, run: () => void shell?.quit().catch(() => {}) },
      ],
    },
    {
      title: "Lab",
      items: [
        { label: "Deploy Lab", accel: `${mod}+Shift+D`, run: command("lab:deploy"), disabled: noLab },
        { label: "Undeploy Lab", accel: `${mod}+Shift+U`, run: command("lab:undeploy"), disabled: noLab },
        "separator",
        { label: "Reload Lab", accel: `${mod}+Shift+R`, run: command("lab:reload"), disabled: noLab },
      ],
    },
    {
      title: "View",
      items: [
        { label: "Actual Size", accel: `${mod}+0`, run: () => void shell?.zoom("reset").catch(() => {}) },
        { label: "Zoom In", accel: `${mod}++`, run: () => void shell?.zoom("in").catch(() => {}) },
        { label: "Zoom Out", accel: `${mod}+-`, run: () => void shell?.zoom("out").catch(() => {}) },
        "separator",
        { label: "Toggle Full Screen", run: () => void shell?.toggleFullScreen().catch(() => {}) },
        { label: "Toggle Dark Theme", run: command("view:toggle-theme") },
        { label: "Toggle Developer Tools", run: () => void shell?.toggleDevTools().catch(() => {}) },
      ],
    },
    {
      title: "Help",
      items: [
        { label: "Kathará Website", run: () => void shell?.openExternal(DOCS_URL).catch(() => {}) },
        { label: "Show Backend Log", run: () => void shell?.showBackendLog().catch(() => {}) },
        { label: "Show Onboarding Tour", run: command("help:tour") },
        { label: "Report an Issue…", run: () => void shell?.openExternal(ISSUES_URL).catch(() => {}) },
        "separator",
        { label: version ? `Version ${version}` : "Version…", disabled: true },
      ],
    },
  ];

  titlesRef.current = menus.map((m) => m.title);

  const title = location.pathname.startsWith("/settings")
    ? "Settings — Kathara Desktop"
    : openLabName || "Kathara Desktop";

  return (
    <div
      className="kt-titlebar"
      data-platform={platform}
      data-fullscreen={fullscreen ? "true" : undefined}
      data-bs-theme={theme}
      ref={barRef}
    >
      <Link
        to="/workspace"
        onClick={guardedClick("/workspace")}
        className="kt-titlebar-brand kt-titlebar-nodrag"
        title="Kathara Desktop"
      >
        <img src={dark ? katharaLogoDark : katharaLogo} alt="Kathara" />
      </Link>

      <div className="kt-titlebar-menu kt-titlebar-nodrag" role="menubar">
        {menus.map((menu, index) => (
          <div key={menu.title} style={{ position: "relative", display: "flex" }}>
            <button
              type="button"
              className="kt-titlebar-menu-btn"
              aria-expanded={open === menu.title}
              aria-haspopup="true"
              // Keeps focus in the page so focus-sensitive commands still know where they are;
              // the reference is captured here, before React re-renders.
              onMouseDown={(e) => {
                e.preventDefault();
                focusBeforeMenu.current = document.activeElement as HTMLElement | null;
              }}
              onClick={(e) => {
                const opening = open !== menu.title;
                setOpen(opening ? menu.title : null);
                // A click with no pointer behind it (detail 0) is Enter or Space: the keyboard opens
                // the menu with focus in it, and Escape brings it back to this button.
                if (opening && e.detail === 0) {
                  focusBeforeMenu.current = e.currentTarget;
                  setFocusRequest("first");
                }
              }}
              onKeyDown={(e) => {
                // With a menu open, the window listener above owns the arrows.
                if (open !== null) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  focusBeforeMenu.current = e.currentTarget;
                  setOpen(menu.title);
                  setFocusRequest(e.key === "ArrowDown" ? "first" : "last");
                } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                  e.preventDefault();
                  const buttons = menuButtons(barRef.current);
                  buttons[adjacentMenu(buttons.length, index, e.key === "ArrowRight" ? 1 : -1)]?.focus();
                }
              }}
              // Once any menu is open, hovering another switches to it — how every native menu
              // bar behaves.
              onMouseEnter={() => setOpen((c) => (c === null ? c : menu.title))}
            >
              {menu.title}
            </button>

            {open === menu.title && (
              <div className="kt-titlebar-dropdown" role="menu">
                {menu.items.map((entry, i) =>
                  isSeparator(entry) ? (
                    <div key={`sep-${i}`} className="kt-titlebar-sep" />
                  ) : (
                    <button
                      key={entry.label}
                      type="button"
                      role="menuitem"
                      className="kt-titlebar-item"
                      disabled={entry.disabled}
                      // While the keyboard is in the menu, the pointer takes focus with it, so the
                      // arrows carry on from the item under it.
                      onMouseEnter={(e) => {
                        if (e.currentTarget.parentElement?.contains(document.activeElement)) e.currentTarget.focus();
                      }}
                      onClick={() => {
                        setOpen(null);
                        entry.run?.();
                      }}
                    >
                      <span>{entry.label}</span>
                      {entry.accel && <span className="kt-titlebar-item-accel">{entry.accel}</span>}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="kt-titlebar-title">{title}</div>

      <div className="kt-titlebar-right kt-titlebar-nodrag">
        <PrivilegedBadge />
        {docker && docker.state !== "ok" && (
          <Badge bg="warning" title={docker.remedy ?? docker.detail}>
            docker {docker.state === "missing" ? "missing" : "stopped"}
          </Badge>
        )}
        <HealthBadge />
        <ImageDownloadBadge />
        <NotificationsPanel />
        <Link
          to="/settings"
          onClick={guardedClick("/settings")}
          className={`kt-titlebar-icon-btn${location.pathname.startsWith("/settings") ? " active" : ""}`}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon size={16} />
        </Link>
      </div>

      {/* macOS keeps its native traffic lights (inset via CSS above); everywhere else, Chromium
          gives a page no way to restyle the window-control icons themselves, only tint their
          background, so the app draws these instead. */}
      {platform !== "darwin" && (
        <div className="kt-titlebar-captions kt-titlebar-nodrag">
          <button
            type="button"
            className="kt-titlebar-caption-btn"
            aria-label="Minimize"
            onClick={() => void shell?.minimizeWindow()}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="kt-titlebar-caption-btn"
            aria-label={maximized ? "Restore" : "Maximize"}
            onClick={() => void (maximized ? shell?.unmaximizeWindow() : shell?.maximizeWindow())}
          >
            {maximized ? <Copy size={13} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="kt-titlebar-caption-btn close"
            aria-label="Close"
            onClick={() => void shell?.closeWindow()}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
