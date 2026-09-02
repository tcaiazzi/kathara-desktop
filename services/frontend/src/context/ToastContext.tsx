import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ToastContainer, Toast } from "react-bootstrap";
import { ApiError } from "../services/api";

type ToastVariant = "success" | "danger" | "info";

interface ToastItem {
  id: number;
  message: string;
  detail?: string;
  variant: ToastVariant;
}

export interface NotificationHistoryItem {
  id: number;
  message: string;
  detail?: string;
  variant: ToastVariant;
  timestamp: number;
  read: boolean;
}

interface ToastApi {
  show: (message: string, variant?: ToastVariant, detail?: string) => void;
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<NotificationHistoryItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>((message, variant = "info", detail) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, detail, variant }]);
    setTimeout(() => remove(id), variant === "danger" ? 7000 : 3500);
    setHistory((prev) =>
      [{ id, message, detail, variant, timestamp: Date.now(), read: false }, ...prev].slice(0, HISTORY_LIMIT),
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
