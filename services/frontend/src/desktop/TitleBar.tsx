// The app-drawn title bar used in the Electron shell: one strip carrying the brand, an HTML menu
// bar, the window title and the status cluster. Replaces the stacked native
// title-bar-plus-menu-bar pair. On Windows/Linux it also draws its own minimize/maximize/close
// buttons at the far right (see the caption-buttons cluster below) — Chromium's own Window
// Controls Overlay only lets a page tint those buttons' background, not restyle their icons,
// which is exactly what looked out of place; on macOS the native traffic lights are left alone
// (inset via CSS, see TitleBar.css) since there is nothing to improve there.
//
// The menu labels and accelerators mirror the native Menu in services/desktop/src/menu.ts, which
// stays registered but hidden — that Menu is what binds the keyboard accelerators. Keep the two
// in step when adding an item.
import { Copy, Minus, Settings as SettingsIcon, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "react-bootstrap";
import { Link, useLocation } from "react-router-dom";
import katharaLogo from "../assets/kathara-logo.png";
import katharaLogoDark from "../assets/kathara-logo-dark.png";
import { NotificationsPanel } from "../components/NotificationsPanel";
import { useHealth } from "../hooks/useHealth";
import { useIsAdmin } from "../hooks/useIsAdmin";
import { useTheme } from "../hooks/useTheme";
import { DOCS_URL } from "../services/constants";
import { desktop, type DesktopMenuAction } from "./bridge";
import { useDesktopDispatch } from "./DesktopCommands";
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

export function TitleBar() {
  const { theme, dark } = useTheme();
  const health = useHealth();
  const isAdmin = useIsAdmin();
  const dispatch = useDesktopDispatch();
  const location = useLocation();
  const shell = desktop();

  const [open, setOpen] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  // Where focus was before a menu opened. Commands like Save act on whichever editor panel has
  // focus (useSaveShortcut), so focus has to be put back before the command runs — a native menu
  // never takes it away, an HTML one does.
  const focusBeforeMenu = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void shell?.getAppInfo().then((info) => setVersion(info.version));
  }, [shell]);

  // The maximize/restore button's icon has to track every way the window can change state, not
  // just clicks on the button itself: double-clicking the drag region, Aero Snap, dragging to a
  // screen edge. The shell pushes the real state after any of those (windows.ts's
  // createMainWindow), so this only needs to read the initial value and then listen.
  useEffect(() => {
    if (!shell) return;
    void shell.isWindowMaximized().then(setMaximized);
    return shell.onWindowStateChange((state) => setMaximized(state.maximized));
  }, [shell]);

  // Click-outside and Escape close the menu, as a native menu would.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
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

  const menus: { title: string; items: Entry[] }[] = [
    {
      title: "File",
      items: [
        { label: "New Lab…", accel: `${mod}+N`, run: command("lab:new") },
        { label: "Import Lab…", accel: `${mod}+O`, run: command("lab:import") },
        { label: "Browse Kathara Labs…", run: command("lab:browse") },
        "separator",
        { label: "Save", accel: `${mod}+S`, run: command("lab:save") },
        "separator",
        { label: "Open Labs Folder", run: () => void shell?.openLabsFolder() },
        "separator",
        { label: "Quit", accel: `${mod}+Q`, run: () => void shell?.quit() },
      ],
    },
    {
      title: "View",
      items: [
        { label: "Actual Size", accel: `${mod}+0`, run: () => void shell?.zoom("reset") },
        { label: "Zoom In", accel: `${mod}++`, run: () => void shell?.zoom("in") },
        { label: "Zoom Out", accel: `${mod}+-`, run: () => void shell?.zoom("out") },
        "separator",
        { label: "Toggle Full Screen", run: () => void shell?.toggleFullScreen() },
        { label: "Toggle Developer Tools", run: () => void shell?.toggleDevTools() },
      ],
    },
    {
      title: "Help",
      items: [
        { label: "Kathara Documentation", run: () => void shell?.openExternal(DOCS_URL) },
        { label: "Show Backend Log", run: () => void shell?.showBackendLog() },
        { label: "Show Onboarding Tour", run: command("help:tour") },
        "separator",
        { label: version ? `Version ${version}` : "Version…", disabled: true },
      ],
    },
  ];

  const title = location.pathname.startsWith("/settings")
    ? "Settings — Kathara IDE"
    : decodeURIComponent(location.pathname.replace(/^\/workspace\/?/, "")) || "Kathara IDE";

  return (
    <div
      className="kt-titlebar"
      data-platform={platform}
      data-bs-theme={theme}
      ref={barRef}
    >
      <Link
        to="/workspace"
        className="kt-titlebar-brand kt-titlebar-nodrag"
        title="Kathara IDE"
      >
        <img src={dark ? katharaLogoDark : katharaLogo} alt="Kathara" />
      </Link>

      <div className="kt-titlebar-menu kt-titlebar-nodrag">
        {menus.map((menu) => (
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
              onClick={() => setOpen((c) => (c === menu.title ? null : menu.title))}
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
        {isAdmin && (
          <Badge bg="warning" title="The local Kathara API is running with administrator privileges">
            privileged
          </Badge>
        )}
        <Badge bg={health === "ok" ? "success" : health === "down" ? "danger" : "secondary"}>
          {health === "checking" ? "checking…" : health === "ok" ? "healthy" : "server unreachable"}
        </Badge>
        <NotificationsPanel />
        <Link
          to="/settings"
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
