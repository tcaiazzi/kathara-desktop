// Autocomplete for lab.conf, driven by the shape of the current line. Offers option keywords inside
// `[...]`, known Kathara images after `[image]=`, collision domains already used in the doc after
// `[<num>]=`, and LAB_* globals + existing machine names at the start of a line.

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import {
  CONF_LINE_RE,
  KATHARA_IMAGES,
  LAB_GLOBALS,
  OPTION_KEYWORDS,
} from "../services/editorLanguage";

// Machine names appearing as `name[...]` anywhere in the document.
function collectMachines(doc: Text): string[] {
  const set = new Set<string>();
  for (let i = 1; i <= doc.lines; i++) {
    const m = CONF_LINE_RE.exec(doc.line(i).text.trim());
    if (m) set.add(m[1]);
  }
  return [...set];
}

// Collision-domain names appearing as `name[<num>]=domain[/mac]`.
function collectDomains(doc: Text): string[] {
  const set = new Set<string>();
  for (let i = 1; i <= doc.lines; i++) {
    const m = CONF_LINE_RE.exec(doc.line(i).text.trim());
    if (m && /^\d+$/.test(m[2])) {
      const cd = m[4].split("/")[0];
      if (cd) set.add(cd);
    }
  }
  return [...set];
}

export function labConfCompletion(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  // Inside `machine[` → option keywords.
  const inBracket = /\[(\w*)$/.exec(before);
  if (inBracket) {
    return {
      from: ctx.pos - inBracket[1].length,
      options: OPTION_KEYWORDS.map((label) => ({ label, type: "property" })),
      validFor: /^\w*$/,
    };
  }

  // After `[image]=` → known Kathara images.
  if (/\[image\]=\s*\S*$/.test(before)) {
    const eq = before.lastIndexOf("=");
    return {
      from: line.from + eq + 1,
      options: KATHARA_IMAGES.map((label) => ({ label, type: "constant" })),
    };
  }

  // After `[<num>]=` → collision domains already used in the doc.
  if (/\[\d+\]=\s*\S*$/.test(before)) {
    const eq = before.lastIndexOf("=");
    return {
      from: line.from + eq + 1,
      options: collectDomains(ctx.state.doc).map((label) => ({ label, type: "enum" })),
    };
  }

  // Start of a line → LAB_* globals + existing machine names.
  const word = ctx.matchBefore(/[A-Za-z0-9_]*/);
  if (word && word.from === line.from) {
    const machines = collectMachines(ctx.state.doc);
    if (!word.text && !ctx.explicit) return null;
    return {
      from: word.from,
      options: [
        ...LAB_GLOBALS.map((label) => ({ label, type: "keyword" })),
        ...machines.map((label) => ({ label, type: "variable" })),
      ],
      validFor: /^[A-Za-z0-9_]*$/,
    };
  }

  return null;
}
