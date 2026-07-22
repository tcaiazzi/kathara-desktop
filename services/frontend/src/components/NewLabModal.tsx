import { useState } from "react";
import { Form, Modal } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { api } from "../services/api";
import { ModalSubmitFooter } from "./ModalSubmitFooter";

interface NewLabModalProps {
  show: boolean;
  onClose: () => void;
  onCreated: (labName: string) => void;
}

// Lab names double as on-disk directory names, so they must be a safe single path segment —
// this mirrors the backend's LAB_NAME_RE (lab_store.py).
const LAB_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Create an empty lab (name only). Building the topology, importing a lab.conf/folder, or
// uploading a .zip are separate flows — see the Topology tab and UploadLabModal.
export function NewLabModal({ show, onClose, onCreated }: NewLabModalProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const runBusy = useBusyAction();

  const trimmed = name.trim();
  const valid = LAB_NAME_RE.test(trimmed);

  function handleClose() {
    setName("");
    onClose();
  }

  async function handleCreate() {
    if (!valid) return;
    await runBusy(setBusy, "Create lab", async () => {
      const detail = await api.createLab({ name: trimmed });
      toast.show(`Lab "${detail.name}" created.`, "success");
      onCreated(detail.name ?? trimmed);
      handleClose();
    });
  }

  return (
    <Modal show={show} onHide={handleClose}>
      <Modal.Header closeButton>
        <Modal.Title>New lab</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Group>
          <Form.Label>Lab name</Form.Label>
          <Form.Control
            autoFocus
            value={name}
            placeholder="my-lab"
            isInvalid={trimmed.length > 0 && !valid}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid && !busy) handleCreate();
            }}
          />
          <Form.Control.Feedback type="invalid">
            Use letters, digits, dot, dash or underscore (max 64 characters).
          </Form.Control.Feedback>
          <Form.Text muted>Creates an empty lab and opens its topology.</Form.Text>
        </Form.Group>
      </Modal.Body>
      <ModalSubmitFooter
        onCancel={handleClose}
        busy={busy}
        submitLabel="Create"
        busyLabel="Creating…"
        submitDisabled={!valid}
        onSubmit={handleCreate}
      />
    </Modal>
  );
}
