import { Button, Modal } from "react-bootstrap";

interface ModalSubmitFooterProps {
  onCancel: () => void;
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
  submitDisabled?: boolean;
  onSubmit: () => void;
}

// Cancel + primary-submit footer shared by the create/upload lab modals. Cancel stays enabled
// even while busy — `onCancel` is expected to abort the in-flight request (see useBusyAction's
// `cancel`), not just be blocked until it resolves — and the submit button swaps to a busy label.
export function ModalSubmitFooter({
  onCancel,
  busy,
  submitLabel,
  busyLabel,
  submitDisabled,
  onSubmit,
}: ModalSubmitFooterProps) {
  return (
    <Modal.Footer>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onSubmit} disabled={busy || !!submitDisabled}>
        {busy ? busyLabel : submitLabel}
      </Button>
    </Modal.Footer>
  );
}
