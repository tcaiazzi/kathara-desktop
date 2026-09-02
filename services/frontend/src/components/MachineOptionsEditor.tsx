import { useEffect, useState } from "react";
import { Alert, Modal } from "react-bootstrap";
import { useConfirm } from "../context/ConfirmContext";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { api } from "../services/api";
import type { MachineDetail } from "../services/types";
import {
  MachineOptionsFields,
  optionsFormStateFromMachine,
  optionsFormStateToPayload,
  type OptionsFormState,
} from "./MachineOptionsFields";
import { ModalSubmitFooter } from "./ModalSubmitFooter";

interface MachineOptionsEditorProps {
  show: boolean;
  labName: string;
  machine: MachineDetail | null;
  deployed: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

// Structured editor for a device's Kathara "options"/meta (image, mem, bridged, envs, sysctls,
// ulimits, exec commands, ports, volumes, and any other pass-through option) — the full-fidelity
// alternative to hand-editing lab.conf text. Only usable while the lab is undeployed (`deployed`
// gates every control read-only) since options only ever take effect on the lab's next deploy.
export function MachineOptionsEditor({ show, labName, machine, deployed, onClose, onSaved }: MachineOptionsEditorProps) {
  const [form, setForm] = useState<OptionsFormState | null>(null);
  const [initial, setInitial] = useState<OptionsFormState | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const runBusy = useBusyAction();

  useEffect(() => {
    if (machine) {
      const seeded = optionsFormStateFromMachine(machine);
      setForm(seeded);
      setInitial(seeded);
    } else {
      setForm(null);
      setInitial(null);
    }
    // Keyed on the device's *name*, not the object: `machine` gets a fresh identity on every lab
    // refresh, and reseeding the form then would silently discard edits in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine?.name, show]);

  // If the open device disappears from the lab (e.g. removed via the same context menu while this
  // modal is open) `machine` becomes null but `show`/the parent's `optionsEditorMachine` don't — close
  // cleanly here instead of silently rendering nothing and leaving the parent's state dangling.
  useEffect(() => {
    if (show && !machine) onClose();
  }, [show, machine, onClose]);

  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);
  const disabled = deployed || busy;

  function set<K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleRequestClose() {
    if (dirty) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        message: `Discard unsaved edits to ${machine?.name}'s options?`,
        okLabel: "Discard",
      });
      if (!ok) return;
    }
    onClose();
  }

  async function handleSave() {
    if (!form || !machine) return;
    await runBusy(setBusy, "Save device options", async () => {
      await api.updateMachine(labName, machine.name, optionsFormStateToPayload(form));
      toast.show(`Saved options for ${machine.name}.`, "success");
      await onSaved();
      onClose();
    });
  }

  return (
    <Modal show={show} onHide={handleRequestClose} size="lg" scrollable>
      {machine && form && (
        <>
          <Modal.Header closeButton>
            <Modal.Title>Options — {machine.name}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {deployed && (
              <Alert variant="warning" className="py-2">
                Undeploy this lab to edit its options. Showing the current configuration read-only.
              </Alert>
            )}
            <MachineOptionsFields form={form} disabled={disabled} onChange={set} />
          </Modal.Body>
          {!deployed && (
            <ModalSubmitFooter
              onCancel={handleRequestClose}
              busy={busy}
              submitLabel="Save"
              busyLabel="Saving…"
              submitDisabled={!dirty}
              onSubmit={handleSave}
            />
          )}
        </>
      )}
    </Modal>
  );
}
