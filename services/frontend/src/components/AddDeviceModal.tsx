import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, Collapse, Form, Modal } from "react-bootstrap";
import { useBusyAction } from "../hooks/useBusyAction";
import { api } from "../services/api";
import { validateDeviceName, validateDomainName } from "../services/names";
import {
  defaultOptionsFormState,
  optionsFormError,
  optionsFormStateToPayload,
  type OptionsFormState,
} from "../services/machineOptionsForm";
import { MachineOptionsFields } from "./MachineOptionsFields";
import { ModalSubmitFooter } from "./ModalSubmitFooter";
import { RowListEditor } from "./RowListEditor";

interface LinkRow {
  link: string;
}

interface AddDeviceModalProps {
  show: boolean;
  labId: string;
  // The lab's collision domains, suggested in each "attach to" row.
  domains: string[];
  // Prefills the first "attach to" row when opened from a domain's context menu.
  prefillLink: string | null;
  onClose: () => void;
  onAdded: () => Promise<void>;
}

// Add-device dialog: the device name and (optionally) the collision domains to attach it to, one
// interface each, are always visible; every other Kathara "option" (image, mem, bridged, sysctls,
// volumes, ...) lives behind the "Advanced options" toggle, sharing its fields with the
// post-creation MachineOptionsEditor via MachineOptionsFields so a device can be fully configured
// at creation time instead of add-then-edit.
export function AddDeviceModal({ show, labId, domains, prefillLink, onClose, onAdded }: AddDeviceModalProps) {
  const [name, setName] = useState("");
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [options, setOptions] = useState<OptionsFormState>(defaultOptionsFormState());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { run: runBusy, cancel: cancelBusy } = useBusyAction();

  function handleCancel() {
    cancelBusy();
    onClose();
  }

  useEffect(() => {
    if (!show) return;
    setName("");
    setLinks([{ link: prefillLink || "" }]);
    setOptions(defaultOptionsFormState());
    setAdvancedOpen(false);
    // Reseeds only when the dialog opens: `prefillLink` is read at that moment, and a later change
    // to it must not overwrite a collision domain the user has already picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  function set<K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  const nameError = validateDeviceName(name);
  // Empty rows are skipped on submit, so they are neither validated nor numbered.
  const cleanLinks = links.map((r) => r.link.trim()).filter(Boolean);
  const linkError = cleanLinks.map(validateDomainName).find((e) => e !== null) ?? null;
  // The advanced fields sit behind a toggle, so their error must also block the submit on its own:
  // a collapsed invalid field would otherwise be sent without the user seeing why it failed.
  const optionsError = optionsFormError(options);
  const canSubmit = name.trim().length > 0 && !nameError && !linkError && !optionsError;

  async function handleSubmit() {
    const cleanName = name.trim();
    if (!canSubmit) return;
    const payload: Parameters<typeof api.addMachine>[1] = { name: cleanName, ...optionsFormStateToPayload(options) };
    if (cleanLinks.length) payload.interfaces = cleanLinks.map((link, number) => ({ link, number }));

    await runBusy(setBusy, "Add device", async (signal) => {
      await api.addMachine(labId, payload, signal);
      await onAdded();
      onClose();
    });
  }

  return (
    <Modal show={show} onHide={handleCancel} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>Add device</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="text-muted small">
          Adds the device to the lab (saved to lab.conf). If the lab is running, the device stays stopped: deploy it
          from its menu to start it.
        </p>
        <Form.Group className="mb-3">
          <Form.Label>Device name</Form.Label>
          <Form.Control
            autoFocus
            required
            placeholder="Name of the new device"
            disabled={busy}
            value={name}
            isInvalid={nameError !== null}
            onChange={(e) => setName(e.target.value)}
          />
          <Form.Control.Feedback type="invalid">{nameError}</Form.Control.Feedback>
        </Form.Group>
        <Form.Group>
          <Form.Label>Attach to collision domains (optional)</Form.Label>
          <RowListEditor<LinkRow>
            columns={[
              {
                key: "link",
                label: "Collision domain",
                options: domains,
                placeholder: "Existing or new collision domain",
              },
            ]}
            rows={links}
            disabled={busy}
            hint={
              domains.length
                ? "Each row becomes an interface, numbered eth0, eth1, … in order. Pick an existing collision domain, or type a new name to create one."
                : "Each row becomes an interface, numbered eth0, eth1, … in order. No domains exist yet — type a name to create one."
            }
            onChange={setLinks}
            emptyRow={() => ({ link: "" })}
          />
          {linkError && <div className="small text-danger mb-3">{linkError}</div>}
        </Form.Group>

        <Button
          variant="link"
          className="ps-0 mb-2 text-decoration-none"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Advanced Options
        </Button>
        {!advancedOpen && optionsError && <div className="small text-danger mb-2">{optionsError}</div>}
        <Collapse in={advancedOpen}>
          <div>
            <MachineOptionsFields form={options} disabled={busy} onChange={set} />
          </div>
        </Collapse>
      </Modal.Body>
      <ModalSubmitFooter
        onCancel={handleCancel}
        busy={busy}
        submitLabel="Add Device"
        busyLabel="Adding…"
        submitDisabled={!canSubmit}
        onSubmit={handleSubmit}
      />
    </Modal>
  );
}
