// Light/dark CodeMirror themes + syntax highlight styles for the code editor. The editor follows
// the app theme (<html data-kt-theme>); CodeEditor picks the matching pair. Base colors reuse the
// app's Bootstrap/--kt-* tokens so the editor blends with its pane; token colors are GitHub-ish.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const baseTheme = (dark: boolean) =>
  EditorView.theme(
    {
      "&": {
        height: "100%",
        fontSize: "13px",
        backgroundColor: "var(--kt-panel-bg)",
        color: "var(--bs-body-color)",
        border: "1px solid var(--kt-surface-recessed-border)",
        borderRadius: "6px",
      },
      "&.cm-focused": {
        outline: "none",
        borderColor: "var(--bs-primary)",
      },
      ".cm-scroller": {
        fontFamily:
          "var(--bs-font-monospace, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
        lineHeight: "1.5",
        overflow: "auto",
      },
      ".cm-content": {
        caretColor: "var(--bs-body-color)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--kt-surface-recessed)",
        color: "var(--kt-node-sub-text)",
        border: "none",
        borderRight: "1px solid var(--kt-surface-recessed-border)",
      },
      ".cm-activeLine": {
        backgroundColor: dark ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.035)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--bs-body-color)",
      },
      "&.cm-editor .cm-selectionBackground, & .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "rgba(122,183,255,0.28)" : "rgba(13,110,253,0.18)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--kt-panel-bg)",
        border: "1px solid var(--kt-surface-recessed-border)",
        color: "var(--bs-body-color)",
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--bs-primary)",
        color: "#fff",
      },
    },
    { dark },
  );

const lightHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#6e7781", fontStyle: "italic" },
  { tag: t.keyword, color: "#cf222e" },
  { tag: t.variableName, color: "#0550ae" },
  { tag: t.propertyName, color: "#8250df" },
  { tag: t.number, color: "#0969da" },
  { tag: t.string, color: "#0a3069" },
  { tag: t.operator, color: "#57606a" },
  { tag: [t.bracket, t.squareBracket, t.paren], color: "#57606a" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: t.comment, color: "#8b949e", fontStyle: "italic" },
  { tag: t.keyword, color: "#ff7b72" },
  { tag: t.variableName, color: "#79c0ff" },
  { tag: t.propertyName, color: "#d2a8ff" },
  { tag: t.number, color: "#79c0ff" },
  { tag: t.string, color: "#a5d6ff" },
  { tag: t.operator, color: "#8b949e" },
  { tag: [t.bracket, t.squareBracket, t.paren], color: "#c9d1d9" },
]);

export function editorTheme(theme: "light" | "dark"): Extension {
  const dark = theme === "dark";
  return [baseTheme(dark), syntaxHighlighting(dark ? darkHighlight : lightHighlight)];
}
