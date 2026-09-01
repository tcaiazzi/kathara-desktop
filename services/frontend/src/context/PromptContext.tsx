import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button, Form, Modal } from "react-bootstrap";

interface PromptOptions {
  title: string;
  message: ReactNode;
  placeholder?: string;
  defaultValue?: string;
  okLabel?: string;
}

type PromptApi = (options: PromptOptions) => Promise<string | null>;

const PromptCtx = createContext<PromptApi | null>(null);

// Promise-based text prompt so call sites can `const path = await prompt({...}); if (!path)
// return;` instead of managing modal state.
export function PromptProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolveRef = useRef<((value: string | null) => void) | null>(null);

  const prompt = useCallback<PromptApi>((opts) => {
    // Settle whatever is still pending before taking over the single `resolveRef` slot — see the
    // same guard in ConfirmContext for why an unresolved promise here wedges its caller.
    resolveRef.current?.(null);
    resolveRef.current = null;
    setOptions(opts);
    setValue(opts.defaultValue || "");
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const close = (result: string | null) => {
    setOptions(null);
    resolveRef.current?.(result);
    resolveRef.current = null;
  };

  return (
    <PromptCtx.Provider value={prompt}>
      {children}
      <Modal show={options != null} onHide={() => close(null)} centered>
        {options && (
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              close(value.trim() || null);
            }}
          >
            <Modal.Header closeButton>
              <Modal.Title>{options.title}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <p>{options.message}</p>
              <Form.Control
                autoFocus
                placeholder={options.placeholder}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onClick={() => close(null)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                {options.okLabel || "OK"}
              </Button>
            </Modal.Footer>
          </Form>
        )}
      </Modal>
    </PromptCtx.Provider>
  );
}

export function usePrompt(): PromptApi {
  const ctx = useContext(PromptCtx);
  if (!ctx) throw new Error("usePrompt must be used within a PromptProvider");
  return ctx;
}
