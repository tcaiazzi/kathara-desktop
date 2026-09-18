// CodeMirror binding for the lab.conf linter. The rules themselves live in `labConfRules.ts`,
// which has no CodeMirror or DOM dependency so it can be unit-tested directly; all this file does
// is hand them the document's lines and map each diagnostic's line index back to a character
// range. Runs instantly, no network.

import { linter, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { lintLabConfLines } from "./labConfRules";

function computeDiagnostics(view: EditorView): Diagnostic[] {
  const doc = view.state.doc;
  // 1-based in CodeMirror, 0-based in the rules — the only impedance mismatch worth a comment.
  const lines = Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text);

  return lintLabConfLines(lines).map(({ line, message, severity }) => {
    const docLine = doc.line(line + 1);
    return { from: docLine.from, to: docLine.to, severity, message };
  });
}

export const labConfLinter = linter(computeDiagnostics);
