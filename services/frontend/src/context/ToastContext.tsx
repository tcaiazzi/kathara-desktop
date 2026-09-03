import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ToastContainer, Toast, Button } from "react-bootstrap";
import { desktop } from "../desktop/bridge";
import { ApiError } from "../services/api";

type ToastVariant = "success" | "danger" | "info";

/** An optional action button a toast/notification can offer — e.g. "Download" on an
 *  update-available notice (see App.tsx's update check). Deliberately just a label + callback,
 *  not a link href: opening it is the caller's job (usually shell.openExternal via the desktop
 *  bridge), so this works the same in the browser build too. */
export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  detail?: string;
  variant: ToastVariant;
  action?: ToastAction;
}

export interface NotificationHistoryItem {
  id: number;
  message: string;
  detail?: string;
  variant: ToastVariant;
  timestamp: number;
  read: boolean;
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

// Cap so a long-running session doesn't grow the history array unbounded.
const HISTORY_LIMIT = 200;

/** Loose runtime check on whatever the shell hands back from a prior saveNotificationHistory —
 * cheap insurance against a future shape change, not full validation. */
function isHistoryItem(v: unknown): v is NotificationHistoryItem {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as NotificationHistoryItem).id === "number" &&
    typeof (v as NotificationHistoryItem).message === "string"
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);

  // Seeded once from whatever the shell carried over from before the last reload it triggered
  // (elevation, retry, labs-dir change, a backend crash restart) — see main.ts's
  // carriedNotifications. A no-op in the browser build (desktop() is null there) or on a genuine
  // fresh app launch (nothing carried yet).
  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    let cancelled = false;
    void shell.loadNotificationHistory().then((loaded) => {
      if (!cancelled && Array.isArray(loaded) && loaded.every(isHistoryItem)) {
        setHistory(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keeps the shell's copy current so it's ready whenever it next reloads this page — cheaper to
  // report on every change than to try to predict the one moment a reload is about to happen.
  // `action` is dropped: it carries a `run` callback, which isn't IPC-serializable, and wouldn't
  // mean anything after a reload anyway (the closure that defined it is gone).
  useEffect(() => {
    const shell = desktop();
    if (!shell) return;
    void shell.saveNotificationHistory(history.map(({ action: _action, ...rest }) => rest));
  }, [history]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>((message, variant = "info", detail, action) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, detail, variant, action }]);
    setTimeout(() => remove(id), variant === "danger" ? 7000 : 3500);
    setHistory((prev) =>
      [{ id, message, detail, variant, action, timestamp: Date.now(), read: false }, ...prev].slice(0, HISTORY_LIMIT),
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

  const markAllRead = useCallback(() => {
    setHistory((prev) => (prev.some((h) => !h.read) ? prev.map((h) => ({ ...h, read: true })) : prev));
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  const unreadCount = useMemo(() => history.reduce((n, h) => n + (h.read ? 0 : 1), 0), [history]);

  const value = useMemo(() => ({ show, reportError }), [show, reportError]);
  const notificationsValue = useMemo(
    () => ({ history, unreadCount, markAllRead, clearHistory }),
    [history, unreadCount, markAllRead, clearHistory],
  );

  return (
    <ToastCtx.Provider value={value}>
      <NotificationsCtx.Provider value={notificationsValue}>
        {children}
        <ToastContainer position="bottom-end" className="p-3" style={{ zIndex: 1080 }}>
          {toasts.map((t) => (
            <Toast key={t.id} bg={t.variant === "info" ? undefined : t.variant} onClose={() => remove(t.id)}>
              <Toast.Header closeButton>
                <strong className="me-auto">{t.detail || (t.variant === "danger" ? "Error" : "Notice")}</strong>
              </Toast.Header>
              <Toast.Body className={t.variant === "danger" || t.variant === "success" ? "text-white" : undefined}>
                {t.message}
                {t.action && (
                  <div className="mt-2">
                    <Button size="sm" variant="light" onClick={t.action.run}>
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
