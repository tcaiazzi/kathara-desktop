import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button, Modal } from "react-bootstrap";

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  okLabel?: string;
}

type ConfirmApi = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmApi | null>(null);

// Promise-based confirm dialog so call sites can `if (!(await confirm({...}))) return;`
// instead of managing per-action modal state.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmApi>((opts) => {
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const close = (value: boolean) => {
    setOptions(null);
    resolveRef.current?.(value);
    resolveRef.current = null;
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal show={options != null} onHide={() => close(false)} centered>
        {options && (
          <>
            <Modal.Header closeButton>
              <Modal.Title>{options.title}</Modal.Title>
            </Modal.Header>
            <Modal.Body>{options.message}</Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => close(true)}>
                {options.okLabel || "Confirm"}
              </Button>
            </Modal.Footer>
          </>
        )}
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm(): ConfirmApi {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx;
}
