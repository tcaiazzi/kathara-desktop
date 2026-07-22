import { useRef, useState } from "react";
import { Form, Modal } from "react-bootstrap";
import { useToast } from "../context/ToastContext";
import { useBusyAction } from "../hooks/useBusyAction";
import { api } from "../services/api";
import { ModalSubmitFooter } from "./ModalSubmitFooter";

interface UploadLabModalProps {
  show: boolean;
  onClose: () => void;
  onCreated: (labName: string) => void;
}

// Default a lab name from the .zip filename (strip the extension); left blank lets the backend
// derive one instead. Only auto-fills if the user hasn't already typed a name themselves.
function nameFromFile(fileName: string): string {
  return fileName.replace(/\.zip$/i, "").trim();
}

// Binary-safe lab creation from an uploaded .zip of a standard Kathara lab directory
// (lab.conf/.startup/shared/…), hitting POST /labs/upload — a separate flow from
// NewLabModal's JSON-description creation, since a file upload and a JSON textarea share
// no state or submit lifecycle.
export function UploadLabModal({ show, onClose, onCreated }: UploadLabModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const runBusy = useBusyAction();

  function reset() {
    setFile(null);
    setName("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleFile(f: File | null) {
    setFile(f);
    if (f && !name) setName(nameFromFile(f.name));
  }

  async function handleUpload() {
    if (!file) {
      toast.show("Choose a .zip archive first.", "danger", "No file");
      return;
    }
    await runBusy(setBusy, "Upload lab", async () => {
      const result = await api.uploadLab(file, name);
      toast.show(`Lab "${result.name}" uploaded.`, "success");
      if (result.warnings?.length) {
        toast.show(result.warnings.join(" · "), "info", "Import warnings");
      }
      onCreated(result.name ?? name);
      handleClose();
    });
  }

  return (
    <Modal show={show} onHide={handleClose}>
      <Modal.Header closeButton>
        <Modal.Title>Upload lab (.zip)</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Form.Group className="mb-3">
          <Form.Label>Archive</Form.Label>
          <Form.Control
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => handleFile((e.target as HTMLInputElement).files?.[0] ?? null)}
          />
          <Form.Text muted>A standard Kathara lab directory (lab.conf, &lt;device&gt;.startup, shared/, …) zipped up.</Form.Text>
        </Form.Group>
        <Form.Group>
          <Form.Label>Lab name</Form.Label>
          <Form.Control value={name} placeholder="Derived from filename" onChange={(e) => setName(e.target.value)} />
        </Form.Group>
      </Modal.Body>
      <ModalSubmitFooter
        onCancel={handleClose}
        busy={busy}
        submitLabel="Upload"
        busyLabel="Uploading…"
        submitDisabled={!file}
        onSubmit={handleUpload}
      />
    </Modal>
  );
}
