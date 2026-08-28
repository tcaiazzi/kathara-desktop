import { lazy, Suspense, type ReactNode } from "react";
import { Button } from "react-bootstrap";
import type { EditorLanguage } from "../services/editorLanguage";

// Lazy so CodeMirror lands in its own chunk, out of the initial app bundle.
const CodeEditor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

interface EditorPaneProps {
  pathLabel: ReactNode;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  onSave: () => void;
  saveDisabled: boolean;
  extraActions?: ReactNode;
  // Syntax mode for the code editor. Defaults to plaintext; callers pass languageForPath(path).
  language?: EditorLanguage;
}

// Right-hand pane shared by LabExplorer and RuntimeFilesystemEditor: a path/placeholder header
// with a Save button (plus any caller-specific actions), and a CodeMirror editor below.
export function EditorPane({
  pathLabel,
  value,
  onChange,
  disabled,
  placeholder,
  onSave,
  saveDisabled,
  extraActions,
  language = "plaintext",
}: EditorPaneProps) {
  return (
    // minHeight: 0 lets this flex item shrink below its content's natural height instead of
    // pushing the panel taller — without it, a long file grows the whole pane rather than
    // scrolling inside the (fixed-height) editor below (see CodeEditor's own height:100%/
    // .cm-scroller{overflow:auto} — that only kicks in once every ancestor actually bounds height).
    <div className="flex-grow-1 d-flex flex-column" style={{ minHeight: 0 }}>
      <div className="d-flex justify-content-between align-items-center mb-2">
        <span className="font-monospace small text-muted">{pathLabel}</span>
        <div className="d-flex gap-2">
          {extraActions}
          <Button size="sm" variant="primary" disabled={saveDisabled} onClick={onSave}>
            Save
          </Button>
        </div>
      </div>
      <Suspense fallback={<div className="flex-grow-1" style={{ minHeight: 0 }} />}>
        <CodeEditor
          language={language}
          value={value}
          onChange={onChange}
          readOnly={disabled}
          placeholder={placeholder}
        />
      </Suspense>
    </div>
  );
}
