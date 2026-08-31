import type { ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Form } from "react-bootstrap";
import { AutocompleteInput } from "./AutocompleteInput";
import "./LabExplorer.css";

export interface RowColumn<T> {
  key: keyof T;
  label: string;
  type?: "text" | "number" | "select";
  // "select": the fixed choices. "text": typeahead suggestions via AutocompleteInput — the field
  // still accepts free text, this only helps the user find a value (used for sysctl names, which
  // number in the thousands and shouldn't all render as literal <option>s).
  options?: string[];
  placeholder?: string;
  min?: number; // for type "number"
  max?: number;
  // Escape hatch for a column that needs more than a single input (e.g. a "Browse…" button next
  // to a volume's host path). `setValue` updates just this column's value in this row.
  render?: (value: unknown, setValue: (value: unknown) => void, disabled: boolean) => ReactNode;
}

interface RowListEditorProps<T extends object> {
  columns: RowColumn<T>[];
  rows: T[];
  onChange: (rows: T[]) => void;
  emptyRow: () => T;
  disabled?: boolean;
  hint?: string;
}

// Generic repeatable-rows editor shared by every list/dict-shaped machine option (envs, sysctls,
// ulimits, exec_commands, ports, volumes, metas) — one column-spec array per call site instead of
// a bespoke component per option. Inline controls, no per-entry prompt dialogs.
export function RowListEditor<T extends object>({
  columns,
  rows,
  onChange,
  emptyRow,
  disabled = false,
  hint,
}: RowListEditorProps<T>) {
  function updateCell(index: number, key: keyof T, value: unknown) {
    const next = rows.slice();
    next[index] = { ...next[index], [key]: value };
    onChange(next);
  }

  return (
    <div className="mb-3">
      {hint && <div className="small text-muted mb-1">{hint}</div>}
      {rows.map((row, index) => (
        <div className="d-flex gap-2 mb-1 align-items-center" key={index}>
          {columns.map((col) => {
            const raw = row[col.key];
            const setValue = (value: unknown) => updateCell(index, col.key, value);
            if (col.render) {
              return <div key={String(col.key)}>{col.render(raw, setValue, disabled)}</div>;
            }
            if (col.type === "select") {
              return (
                <Form.Select
                  key={String(col.key)}
                  size="sm"
                  disabled={disabled}
                  value={raw == null ? "" : String(raw)}
                  onChange={(e) => setValue(e.target.value)}
                  aria-label={col.label}
                >
                  {(col.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </Form.Select>
              );
            }
            if (col.options) {
              return (
                <AutocompleteInput
                  key={String(col.key)}
                  size="sm"
                  placeholder={col.placeholder ?? col.label}
                  disabled={disabled}
                  aria-label={col.label}
                  value={raw == null ? "" : String(raw)}
                  onChange={setValue}
                  options={col.options}
                />
              );
            }
            return (
              <Form.Control
                key={String(col.key)}
                size="sm"
                type={col.type === "number" ? "number" : "text"}
                min={col.min}
                max={col.max}
                placeholder={col.placeholder ?? col.label}
                disabled={disabled}
                value={raw == null ? "" : String(raw)}
                onChange={(e) => {
                  const value = e.target.value;
                  setValue(col.type === "number" ? (value === "" ? null : Number(value)) : value);
                }}
              />
            );
          })}
          <Button
            size="sm"
            variant="outline-danger"
            className="kt-icon-btn"
            disabled={disabled}
            title="Remove row"
            aria-label="Remove row"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline-secondary"
        className="kt-icon-btn"
        disabled={disabled}
        title="Add row"
        aria-label="Add row"
        onClick={() => onChange([...rows, emptyRow()])}
      >
        <Plus size={14} />
      </Button>
    </div>
  );
}
