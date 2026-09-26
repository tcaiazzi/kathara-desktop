// CodeMirror splits a document on any of `\r\n`, `\r`, `\n` but always hands it back joined with
// `\n`. CodeEditor uses these two helpers to give its caller the file's own line ending back, so a
// CRLF file opened and left alone reads back byte-for-byte (and never looks modified), and saving
// it keeps CRLF instead of silently converting the file.
//
// `EditorState.lineSeparator` is not an alternative: it is a static facet, so it can't follow the
// editor from one file to the next, and it leaves any other line break pasted in inside a line.

export type LineBreak = "\n" | "\r\n";

/** The line ending a text uses, decided by its first line break — a text with none gets `\n`. */
export function detectLineBreak(text: string): LineBreak {
  const first = /\r\n|\n/.exec(text);
  return first?.[0] === "\r\n" ? "\r\n" : "\n";
}

/** Re-joins CodeMirror's `\n`-joined document text with `eol`. */
export function withLineBreak(text: string, eol: LineBreak): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}
