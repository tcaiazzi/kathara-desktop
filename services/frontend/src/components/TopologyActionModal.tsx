import { useEffect, useState } from "react";
import { Button, Form, Modal } from "react-bootstrap";
import { AutocompleteInput } from "./AutocompleteInput";

export interface TopoActionField {
  name: string;
  label: string;
  type?: "text" | "number" | "textarea";
  options?: { value: string; label: string }[]; // renders a <select> instead of an <input>
  // Typeahead suggestions on an otherwise plain text input — the field still accepts free text,
  // this only helps find a value (e.g. official Docker Hub image names). Ignored when `options`
  // is set (that already renders a hard <select>).
  datalistOptions?: string[];
  value?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  min?: number;
}

export interface TopoActionConfig {
  title: string;
  hint?: string;
  submitLabel?: string;
  fields: TopoActionField[];
  /** Returns whether the action succeeded — the modal stays open (so the user can fix input) on
   * failure, and closes on success. */
  onSubmit: (values: Record<string, string>) => Promise<boolean>;
}

interface TopologyActionModalProps {
  config: TopoActionConfig | null;
  onClose: () => void;
}

// Generic field-driven modal reused for every topology mutation (add device/domain/interface,
// connect, disconnect).
export function TopologyActionModal({ config, onClose }: TopologyActionModalProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!config) return;
    const initial: Record<string, string> = {};
    for (const f of config.fields) initial[f.name] = f.value ?? (f.options ? f.options[0]?.value ?? "" : "");
    setValues(initial);
  }, [config]);

  if (!config) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!config) return;
    setSubmitting(true);
    try {
      const ok = await config.onSubmit(values);
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal show onHide={onClose}>
      <Form onSubmit={handleSubmit}>
        <Modal.Header closeButton>
          <Modal.Title>{config.title}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {config.hint && <p className="text-muted small">{config.hint}</p>}
          {config.fields.map((f) => (
            <Form.Group className="mb-3" key={f.name}>
              <Form.Label>{f.label}</Form.Label>
              {f.options ? (
                <Form.Select
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Form.Select>
              ) : f.datalistOptions ? (
                <AutocompleteInput
                  value={values[f.name] ?? ""}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                  options={f.datalistOptions}
                  placeholder={f.placeholder}
                  required={f.required}
                />
              ) : (
                <Form.Control
                  as={f.type === "textarea" ? "textarea" : undefined}
                  type={f.type === "number" ? "number" : f.type === "textarea" ? undefined : "text"}
                  rows={f.type === "textarea" ? 8 : undefined}
                  min={f.min}
                  required={f.required}
                  placeholder={f.placeholder}
                  className={f.type === "textarea" ? "font-monospace" : undefined}
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              )}
              {f.hint && <Form.Text className="text-muted">{f.hint}</Form.Text>}
            </Form.Group>
          ))}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={submitting}>
            {config.submitLabel || "Apply"}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  );
}
