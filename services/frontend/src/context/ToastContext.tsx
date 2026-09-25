import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ToastContainer, Toast, Button } from "react-bootstrap";
import { desktop } from "../desktop/bridge";
import { ApiError } from "../services/api";
import {
  allRead,
  unreadCount as countUnread,
  withCarriedHistory,
  withNewNotification,
  type NotificationHistoryItem,
  type ToastAction,
  type ToastVariant,
} from "../services/notificationHistory";

interface ToastItem {
  id: number;
  message: string;
  detail?: string;
  variant: ToastVariant;
  action?: ToastAction;
}

interface ToastApi {
  show: (message: string, variant?: ToastVariant, detail?: string, action?: ToastAction) => void;
  /** Show a message on success, or surface an ApiError's detail/error_type on failure. */
  reportError: (prefix: string, error: unknown) => void;
}

interface NotificationsApi {
  /** History of every notification shown since app startup, newest first (capped). */
  history: NotificationHistoryItem[];
  unreadCount: number;
  markAllRead: () => void;
  clearHistory: () => void;
}

const ToastCtx = createContext<ToastApi | null>(null);
// Kept separate from ToastCtx so its value (recreated whenever history changes) doesn't churn the
// identity of `show`/`reportError` for the many callers that put the whole useToast() result in a
// dependency array — only NotificationsPanel needs to re-render on every new notification.
const NotificationsCtx = createContext<NotificationsApi | null>(null);

let nextId = 1;

// Opens a ToastAction's url via the desktop shell when available, else a plain new tab — keeps
// notification links working the same in both the Electron and browser builds.
export function openLink(url: string): void {
  const shell = desktop();
  if (shell) {
    void shell.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);

  // Seeded once from whatever the shell carried over from before the last reload it triggered
  // (elevation, retry, labs-dir change, a backend crash restart) — see main.ts's
  // carriedNotifications. A no-op in the browser build (desktop() is null there) or on a genuine
  // fresh app launch (nothing carried yet).
  //
  // Merged onto `prev` rather than replacing it: this IPC round-trip races against any `show()`
  // call fired from another component's own mount-time effect (e.g. UpdateChecker's update
  // check, whose result can already be cached in the main process and so resolve before this
  // does) — overwriting outright would silently drop whatever that earlier call already added.
  // See withCarriedHistory for the order and the validation.
  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    let cancelled = false;
    void shell.loadNotificationHistory().then((loaded) => {
      if (!cancelled) setHistory((prev) => withCarriedHistory(prev, loaded));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps the shell's copy current so it's ready whenever it next reloads this page — cheaper to
  // report on every change than to try to predict the one moment a reload is about to happen.
  // `action` is a plain {label, url} object, so it round-trips through this IPC call intact.
  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    void shell.saveNotificationHistory(history).catch(() => {});
  }, [history]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>((message, variant = "info", detail, action) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, detail, variant, action }]);
    setTimeout(() => remove(id), variant === "danger" ? 7000 : 3500);
    setHistory((prev) =>
      withNewNotification(prev, { id, message, detail, variant, action, timestamp: Date.now(), read: false }),
    );
  }, [remove]);

  const reportError = useCallback<ToastApi["reportError"]>(
    (prefix, error) => {
      const message = error instanceof ApiError ? error.message : String(error);
      const detail = error instanceof ApiError ? error.errorType : prefix;
      show(`${prefix}: ${message}`, "danger", detail);
    },
    [show],
  );

  const markAllRead = useCallback(() => setHistory(allRead), []);

  const clearHistory = useCallback(() => setHistory([]), []);

  const unreadCount = useMemo(() => countUnread(history), [history]);

  const value = useMemo(() => ({ show, reportError }), [show, reportError]);
  const notificationsValue = useMemo(
    () => ({ history, unreadCount, markAllRead, clearHistory }),
    [history, unreadCount, markAllRead, clearHistory],
  );

  return (
    <ToastCtx.Provider value={value}>
      <NotificationsCtx.Provider value={notificationsValue}>
        {children}
        {/* containerPosition="fixed": .toast-container is position:absolute by default, which
            anchors to the document rather than the viewport — invisible once a normally
            scrolling page (e.g. Settings) is scrolled past that anchor point. */}
        <ToastContainer position="bottom-end" containerPosition="fixed" className="p-3" style={{ zIndex: 1080 }}>
          {toasts.map((t) => (
            <Toast key={t.id} bg={t.variant === "info" ? undefined : t.variant} onClose={() => remove(t.id)}>
              <Toast.Header closeButton>
                <strong className="me-auto">{t.detail || (t.variant === "danger" ? "Error" : "Notification")}</strong>
              </Toast.Header>
              <Toast.Body className={t.variant === "danger" || t.variant === "success" ? "text-white" : undefined}>
                {t.message}
                {t.action && (
                  <div className="mt-2">
                    <Button size="sm" variant="light" onClick={() => openLink(t.action!.url)}>
                      {t.action.label}
                    </Button>
                  </div>
                )}
              </Toast.Body>
            </Toast>
          ))}
        </ToastContainer>
      </NotificationsCtx.Provider>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

export function useNotifications(): NotificationsApi {
  const ctx = useContext(NotificationsCtx);
  if (!ctx) throw new Error("useNotifications must be used within a ToastProvider");
  return ctx;
}
