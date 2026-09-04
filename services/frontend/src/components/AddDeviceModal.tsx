import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, Collapse, Form, Modal } from "react-bootstrap";
import { useDeployAuthorization } from "../desktop/ElevationContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { api } from "../services/api";
import {
  defaultOptionsFormState,
  MachineOptionsFields,
  optionsFormStateToPayload,
  type OptionsFormState,
} from "./MachineOptionsFields";
import { ModalSubmitFooter } from "./ModalSubmitFooter";

interface AddDeviceModalProps {
  show: boolean;
  labName: string;
  // Prefills "attach to domain" when opened from a domain's context menu.
  prefillLink: string | null;
  onClose: () => void;
  onAdded: () => Promise<void>;
}

// Add-device dialog: the device name and (optionally) which collision domain to attach it to are
// always visible; every other Kathara "option" (image, mem, bridged, sysctls, volumes, ...) lives
// behind the "Advanced options" toggle, sharing its fields with the post-creation
// MachineOptionsEditor via MachineOptionsFields so a device can be fully configured at creation
// time instead of add-then-edit.
export function AddDeviceModal({ show, labName, prefillLink, onClose, onAdded }: AddDeviceModalProps) {
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [options, setOptions] = useState<OptionsFormState>(defaultOptionsFormState());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const runBusy = useBusyAction();
  const requestDeployAuth = useDeployAuthorization();

  useEffect(() => {
    if (!show) return;
    setName("");
    setLink(prefillLink || "");
    setOptions(defaultOptionsFormState());
    setAdvancedOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  function set<K extends keyof OptionsFormState>(key: K, value: OptionsFormState[K]) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    const cleanName = name.trim();
    if (!cleanName) return;
    const payload: Parameters<typeof api.addMachine>[1] = { name: cleanName, ...optionsFormStateToPayload(options) };
    const cleanLink = link.trim();
    if (cleanLink) payload.interfaces = [{ link: cleanLink, number: 0 }];

    // Same "volumes" case as a single-device redeploy (useDeviceActions.deployDevice) — never
    // "both" even if the Advanced options' privileged checkbox is also set, for the same reason:
    // no resume-after-reload path exists for this modal's form state across a full page reload.
    if (payload.volumes && payload.volumes.length > 0) {
      const outcome = await requestDeployAuth({
        privileged: false,
        volumeMachines: [{ name: cleanName, volumes: payload.volumes }],
      });
      if (outcome !== "proceed") return;
    }

    await runBusy(setBusy, "Add device", async () => {
      await api.addMachine(labName, payload);
      await onAdded();
      onClose();
    });
  }

  return (
    <Modal show={show} onHide={busy ? undefined : onClose} size="lg" scrollable>
      <Modal.Header closeButton={!busy}>
        <Modal.Title>Add device</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="text-muted small">
          Adds the device to the lab (saved to lab.conf). If the lab is running, it's also deployed live.
        </p>
        <Form.Group className="mb-3">
          <Form.Label>Device name</Form.Label>
          <Form.Control
            autoFocus
            required
            placeholder="pc1"
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Form.Group>
        <Form.Group className="mb-3">
          <Form.Label>Attach to domain (optional)</Form.Label>
          <Form.Control placeholder="A" disabled={busy} value={link} onChange={(e) => setLink(e.target.value)} />
        </Form.Group>

        <Button
          variant="link"
          className="ps-0 mb-2 text-decoration-none"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Advanced Options
        </Button>
        <Collapse in={advancedOpen}>
          <div>
            <MachineOptionsFields form={options} disabled={busy} onChange={set} />
          </div>
        </Collapse>
      </Modal.Body>
      <ModalSubmitFooter
        onCancel={onClose}
        busy={busy}
        submitLabel="Add Device"
        busyLabel="Adding…"
        submitDisabled={!name.trim()}
        onSubmit={handleSubmit}
      />
    </Modal>
  );
}
