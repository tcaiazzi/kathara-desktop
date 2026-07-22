import type { ReactNode } from "react";
import { Button, Form } from "react-bootstrap";

interface EditorPaneProps {
  pathLabel: ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  onSave: () => void;
  saveDisabled: boolean;
  extraActions?: ReactNode;
}

// Right-hand pane shared by LabExplorer and RuntimeFilesystemEditor: a path/placeholder header
// with a Save button (plus any caller-specific actions), and a monospace textarea below.
export function EditorPane({
  pathLabel,
  value,
  onChange,
  disabled,
  placeholder,
  onSave,
  saveDisabled,
  extraActions,
}: EditorPaneProps) {
  return (
    <div className="flex-grow-1 d-flex flex-column">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <span className="font-monospace small text-muted">{pathLabel}</span>
        <div className="d-flex gap-2">
          {extraActions}
          <Button size="sm" variant="primary" disabled={saveDisabled} onClick={onSave}>
            Save
          </Button>
        </div>
      </div>
      <Form.Control
        as="textarea"
        className="font-monospace flex-grow-1"
        style={{ minHeight: 360 }}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
