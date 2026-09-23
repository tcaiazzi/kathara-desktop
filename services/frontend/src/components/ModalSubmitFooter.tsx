import { Button, Modal } from "react-bootstrap";

interface ModalSubmitFooterProps {
  onCancel: () => void;
  busy: boolean;
  submitLabel: string;
  busyLabel: string;
  submitDisabled?: boolean;
  onSubmit: () => void;
}

// Cancel + primary-submit footer shared by the modals that submit one request: NewLabModal,
// UploadLabModal, AddDeviceModal and MachineOptionsEditor. Cancel stays enabled even while busy, so
// `onCancel` must abort the in-flight request (see useBusyAction's `cancel`) rather than leave the
// user blocked until it resolves. MachineOptionsEditor is the one exception: `api.updateMachine`
// takes no `AbortSignal`, so its Cancel confirms and closes without aborting anything. The submit
// button swaps to a busy label.
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
