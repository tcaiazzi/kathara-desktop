import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { usePromiseModal } from "../hooks/usePromiseModal";
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

  const { open, settle } = usePromiseModal<boolean>(false);

  const confirm = useCallback<ConfirmApi>((opts) => open(() => setOptions(opts)), [open]);

  const close = (value: boolean) => {
    setOptions(null);
    settle(value);
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
