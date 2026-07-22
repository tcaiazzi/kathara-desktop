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

interface ToastApi {
  show: (message: string, variant?: ToastVariant, detail?: string) => void;
  /** Show a message on success, or surface an ApiError's detail/error_type on failure. */
  reportError: (prefix: string, error: unknown) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>((message, variant = "info", detail) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, detail, variant }]);
    setTimeout(() => remove(id), variant === "danger" ? 7000 : 3500);
  }, [remove]);

  const reportError = useCallback<ToastApi["reportError"]>(
    (prefix, error) => {
      const message = error instanceof ApiError ? error.message : String(error);
      const detail = error instanceof ApiError ? error.errorType : prefix;
      show(`${prefix}: ${message}`, "danger", detail);
    },
    [show],
  );

  const value = useMemo(() => ({ show, reportError }), [show, reportError]);

  return (
    <ToastCtx.Provider value={value}>
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
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
