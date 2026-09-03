import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNotifications } from "../context/ToastContext";
import "./NotificationsPanel.css";

// "just now" / "Xm ago" / "Xh ago" for the last 24h, else a locale date/time string.
function formatRelativeTime(ts: number): string {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (diffSec < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
  if (diffSec < 86400) return rtf.format(-Math.round(diffSec / 3600), "hour");
  return new Date(ts).toLocaleString();
}

// Bell trigger + anchored history panel, dropped into both AppNavbar.tsx and TitleBar.tsx.
export function NotificationsPanel() {
  const { history, unreadCount, markAllRead, clearHistory } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Click-outside and Escape close the panel — same pattern as TitleBar.tsx's own menus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    setOpen((current) => {
      if (!current) markAllRead();
      return !current;
    });
  };

  return (
    <div className="kt-notif" ref={ref}>
      <button
        type="button"
        className="kt-notif-trigger"
        aria-label="Notifications"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggle}
      >
        <Bell size={16} />
        {unreadCount > 0 && <span className="kt-notif-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {open && (
        <div className="kt-notif-panel" role="menu">
          <div className="kt-notif-panel-header">
            <span>Notifications</span>
            <button
              type="button"
              className="kt-notif-clear"
              onClick={clearHistory}
              disabled={history.length === 0}
            >
              Clear
            </button>
          </div>
          {history.length === 0 ? (
            <div className="kt-notif-empty">No notifications yet</div>
          ) : (
            <ul className="kt-notif-list">
              {history.map((h) => (
                <li key={h.id} className="kt-notif-item">
                  <span className={`kt-notif-dot kt-notif-dot-${h.variant}`} />
                  <div className="kt-notif-item-body">
                    <div className="kt-notif-item-message">{h.message}</div>
                    {h.detail && <div className="kt-notif-item-detail">{h.detail}</div>}
                    <div className="kt-notif-item-time" title={new Date(h.timestamp).toLocaleString()}>
                      {formatRelativeTime(h.timestamp)}
                    </div>
                    {h.action && (
                      <button type="button" className="kt-notif-action" onClick={h.action.run}>
                        {h.action.label}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
