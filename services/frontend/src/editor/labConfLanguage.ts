// A lightweight StreamLanguage (per-line tokenizer) for Kathara lab.conf files. It mirrors the line
// grammar of the backend parser (`lab_import.py` CONF_LINE_RE): `machine[arg]=value`, LAB_* globals,
// and `#` comments. Token names map to @lezer/highlight tags via StreamLanguage's built-in mapping,
// then colored by the HighlightStyles in `theme.ts`.

import { LanguageSupport, StreamLanguage } from "@codemirror/language";

interface LabConfState {
  afterEq: boolean;
}

const parser = StreamLanguage.define<LabConfState>({
  name: "labconf",
  startState: () => ({ afterEq: false }),
  token(stream, state) {
    if (stream.sol()) state.afterEq = false;
    if (stream.eatSpace()) return null;

    // Comments run to end of line.
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }

    // Right-hand side of `=`: the value (quoted or bare) up to a space/comment.
    if (state.afterEq) {
      if (stream.match(/^"[^"]*"/) || stream.match(/^'[^']*'/)) return "string";
      stream.match(/^[^\s#]+/);
      return "string";
    }

    // LAB_* global metadata directive (e.g. LAB_DESCRIPTION="...").
    if (stream.match(/^[A-Z][A-Z0-9_]*(?=\s*=)/)) return "keyword";

    // Machine name preceding a `[` (start of a directive line).
    if (stream.match(/^[a-z0-9_]{1,30}(?=\[)/)) return "variableName";

    if (stream.eat("[")) return "bracket";
    // Inside the brackets: an interface index (digits) or an option keyword (word).
    if (stream.match(/^\d+(?=\])/)) return "number";
    if (stream.match(/^\w+(?=\])/)) return "propertyName";
    if (stream.eat("]")) return "bracket";

    if (stream.eat("=")) {
      state.afterEq = true;
      return "operator";
    }

    stream.next();
    return null;
  },
});

export const labConf = new LanguageSupport(parser);
