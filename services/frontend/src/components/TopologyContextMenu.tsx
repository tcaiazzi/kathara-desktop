import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ContextMenuItemBase {
  label: string;
  danger?: boolean;
  success?: boolean;
  disabled?: boolean;
  title?: string;
}

type ContextMenuAction = ContextMenuItemBase & { action: () => void; submenu?: never };

/** A menu entry: an action, or a submenu of actions that opens beside it when clicked. */
export type ContextMenuItem =
  | ContextMenuAction
  | (ContextMenuItemBase & { submenu: ContextMenuAction[]; action?: never });

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface TopologyContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
}

// The menus' geometry, for keeping them on screen: kt-topo-menu's min-width, the height of one of
// its rows, and its padding.
const MENU_WIDTH = 220;
const ROW_HEIGHT = 34;
const MENU_PADDING = 6;
const EDGE = 8;

// The app's right-click menu, for topology nodes, file trees and terminals alike. Closes on any
// outside click.
export function TopologyContextMenu({ menu, onClose }: TopologyContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The entry whose submenu is open, by index, one at a time as in a native menu; kept with the
  // menu it belongs to, so a menu opened afterwards starts with none open.
  const [opened, setOpened] = useState<{ menu: ContextMenuState; index: number } | null>(null);
  const openIndex = menu && opened?.menu === menu ? opened.index : null;

  useEffect(() => {
    if (!menu) return;
    const handler = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // Clamp so the menu doesn't run off the viewport edge.
  const x = Math.max(EDGE, Math.min(menu.x, window.innerWidth - MENU_WIDTH - EDGE));
  const y = Math.max(EDGE, Math.min(menu.y, window.innerHeight - menu.items.length * ROW_HEIGHT - EDGE));
  // A submenu opens to the right of the menu, or to its left where the window has no room for it.
  const flip = x + 2 * MENU_WIDTH + EDGE > window.innerWidth;

  const classOf = (item: ContextMenuItemBase) => (item.danger ? "danger" : item.success ? "success" : "");

  const renderAction = (item: ContextMenuAction, key: number) => (
    <button
      key={key}
      type="button"
      className={classOf(item) || undefined}
      disabled={item.disabled}
      title={item.title}
      onClick={() => {
        onClose();
        item.action();
      }}
    >
      {item.label}
    </button>
  );

  const renderItem = (item: ContextMenuItem, i: number) => {
    if (!item.submenu) return renderAction(item, i);
    const open = openIndex === i;
    // Lifted by as much as the submenu would otherwise run past the window's bottom edge.
    const rowTop = y + MENU_PADDING + i * ROW_HEIGHT;
    const height = item.submenu.length * ROW_HEIGHT + 2 * MENU_PADDING;
    const lift = Math.max(0, rowTop + height - (window.innerHeight - EDGE));
    return (
      <div key={i} className="kt-topo-menu-parent">
        <button
          type="button"
          className={`kt-topo-menu-opener ${open ? "open" : ""} ${classOf(item)}`}
          disabled={item.disabled}
          title={item.title}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpened(open ? null : { menu, index: i })}
        >
          <span>{item.label}</span>
          <ChevronRight size={14} aria-hidden />
        </button>
        {open && (
          <div
            className={`kt-topo-menu kt-topo-submenu ${flip ? "flip" : ""}`}
            role="menu"
            style={{ top: -MENU_PADDING - lift }}
          >
            {item.submenu.map(renderAction)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={ref} className="kt-topo-menu" style={{ left: x, top: y }}>
      {menu.items.map(renderItem)}
    </div>
  );
}
