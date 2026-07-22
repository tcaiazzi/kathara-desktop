import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface TopologyContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
}

// Right-click action menu for topology nodes. Closes on any outside click.
export function TopologyContextMenu({ menu, onClose }: TopologyContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const handler = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menu, onClose]);

  if (!menu) return null;

  // Clamp so the menu doesn't run off the viewport edge.
  const width = 220;
  const x = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
  const y = Math.max(8, Math.min(menu.y, window.innerHeight - menu.items.length * 34 - 8));

  return (
    <div ref={ref} className="kt-topo-menu" style={{ left: x, top: y }}>
      {menu.items.map((item, i) => (
        <button
          key={i}
          type="button"
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            onClose();
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
