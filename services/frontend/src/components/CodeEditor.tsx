import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { labConfCompletion } from "../editor/labConfComplete";
import { labConf } from "../editor/labConfLanguage";
import { labConfLinter } from "../editor/labConfLint";
import { editorTheme } from "../editor/theme";
import { useKtTheme } from "../hooks/useKtTheme";
import type { EditorLanguage } from "../services/editorLanguage";

interface CodeEditorProps {
  language: EditorLanguage;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}

// Language extension + its companions (autocomplete/lint only for lab.conf).
function languageExtensions(language: EditorLanguage): Extension {
  if (language === "labconf") {
    return [
      labConf,
      autocompletion({ override: [labConfCompletion] }),
      lintGutter(),
      labConfLinter,
    ];
  }
  if (language === "shell") return [StreamLanguage.define(shell)];
  return [];
}

// A CodeMirror 6 editor wrapping the app's plain <textarea>-shaped API (value/onChange/readOnly/
// placeholder). Reconfigures language/theme/readOnly/placeholder via Compartments without recreating
// the view. Deliberately binds no Mod-s so Ctrl/Cmd+S bubbles to the callers' useSaveShortcut.
export function CodeEditor({ language, value, onChange, readOnly = false, placeholder }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Stable compartments for the reconfigurable slots.
  const langComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const editableComp = useRef(new Compartment());
  const placeholderComp = useRef(new Compartment());

  const theme = useKtTheme();

  // Create the view once; tear it down on unmount (critical for dockview panel remounts).
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        minimalSetup,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorView.lineWrapping,
        keymap.of([...completionKeymap, ...lintKeymap]),
        langComp.current.of(languageExtensions(language)),
        themeComp.current.of(editorTheme(theme)),
        editableComp.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
        placeholderComp.current.of(placeholder ? cmPlaceholder(placeholder) : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    // Dockview can mount/resize the panel after creation; re-measure so CM lays out correctly.
    const ro = new ResizeObserver(() => view.requestMeasure());
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // Created once; prop changes are handled by the reconfigure effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value → editor, guarded to avoid clobbering the cursor on our own onChange round-trip.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: langComp.current.reconfigure(languageExtensions(language)) });
  }, [language]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(editorTheme(theme)) });
  }, [theme]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableComp.current.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: placeholderComp.current.reconfigure(placeholder ? cmPlaceholder(placeholder) : []),
    });
  }, [placeholder]);

  // flex-column so the CodeMirror editor stretches to the full width of the pane (a row flex would
  // shrink it to its content width). minHeight: 0 (not a fixed floor) lets this host shrink to
  // whatever the panel actually has available, so CodeMirror's own `.cm-editor{height:100%}` +
  // `.cm-scroller{overflow:auto}` (editor theme) get a real bound to scroll within instead of the
  // editor growing to fit its content and pushing the rest of the page down.
  return <div ref={hostRef} className="flex-grow-1 d-flex flex-column" style={{ minHeight: 0, overflow: "hidden" }} />;
}
