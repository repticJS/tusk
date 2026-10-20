import { acceptCompletion, autocompletion, closeCompletion } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";
import { useApp } from "../store";

// ---- error underline ----

export const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();

const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorMark)) {
        deco =
          e.value && e.value.to > e.value.from
            ? Decoration.set([Decoration.mark({ class: "cm-error-mark" }).range(e.value.from, e.value.to)])
            : Decoration.none;
      }
    }
    // Typing clears the marker.
    if (tr.docChanged) deco = Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---- theme ----

function editorTheme(dark: boolean): Extension {
  const base = EditorView.theme(
    {
      "&": { backgroundColor: "var(--bg)", color: "var(--text)" },
      ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: dark ? "rgba(91,140,255,0.28) !important" : "rgba(58,109,240,0.2) !important",
      },
      ".cm-activeLine": { backgroundColor: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)" },
      ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 14px" },
      ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
      ".cm-tooltip": {
        backgroundColor: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        overflow: "hidden",
        boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
      },
      ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)", fontSize: "12.5px", maxHeight: "260px" },
      ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px !important" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "white" },
      ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "8px" },
      ".cm-searchMatch": { backgroundColor: "var(--warn-soft)" },
      ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)", borderColor: "var(--border)" },
      ".cm-panel input, .cm-panel button": { fontSize: "12px" },
    },
    { dark },
  );
  const palette = dark
    ? { kw: "#7aa2ff", str: "#9ccc8a", num: "#e6a66a", com: "#5f6878", fn: "#d7a8ff", op: "#93a0b4", type: "#5fc8c8" }
    : { kw: "#2c5ad8", str: "#2f7d32", num: "#b35c00", com: "#9aa1ad", fn: "#8a3fc7", op: "#56606e", type: "#0b7f86" };
  const hl = HighlightStyle.define([
    { tag: t.keyword, color: palette.kw, fontWeight: "500" },
    { tag: [t.string, t.special(t.string)], color: palette.str },
    { tag: [t.number, t.bool, t.null], color: palette.num },
    { tag: [t.lineComment, t.blockComment, t.comment], color: palette.com, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.standard(t.name)], color: palette.fn },
    { tag: [t.operator, t.punctuation, t.paren, t.bracket], color: palette.op },
    { tag: [t.typeName, t.className], color: palette.type },
    { tag: t.special(t.name), color: palette.type },
  ]);
  return [base, syntaxHighlighting(hl)];
}

export interface SqlEditorProps {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  schema?: Record<string, Record<string, string[]>>;
  onRun?: () => void;
  onRunAll?: () => void;
  onSave?: () => void;
  onCreate?: (view: EditorView) => void;
  autoFocus?: boolean;
}

export function SqlEditor(props: SqlEditorProps) {
  const theme = useApp((s) => s.theme);
  const { onRun, onRunAll, onSave } = props;

  const extensions = useMemo(() => {
    // Highest precedence so Mod-Enter beats the default "insert blank line".
    const keys = Prec.highest(keymap.of([
      { key: "Mod-Enter", run: (v) => (closeCompletion(v), onRun?.(), true), preventDefault: true },
      { key: "Shift-Mod-Enter", run: (v) => (closeCompletion(v), onRunAll?.(), true), preventDefault: true },
      { key: "F5", run: (v) => (closeCompletion(v), onRunAll?.(), true), preventDefault: true },
      { key: "Mod-s", run: () => (onSave?.(), true), preventDefault: true },
      { key: "Tab", run: acceptCompletion },
      indentWithTab,
    ]));
    return [
      keys,
      sql({ dialect: PostgreSQL, schema: props.schema, defaultSchema: "public", upperCaseKeywords: true }),
      autocompletion({ activateOnTyping: true, icons: false, maxRenderedOptions: 80 }),
      errorField,
      editorTheme(theme === "dark"),
      EditorView.lineWrapping,
    ];
  }, [onRun, onRunAll, onSave, props.schema, theme]);

  return (
    <CodeMirror
      value={props.value}
      onChange={props.onChange}
      readOnly={props.readOnly}
      editable={!props.readOnly}
      theme="none"
      height="100%"
      style={{ height: "100%" }}
      autoFocus={props.autoFocus}
      extensions={extensions}
      onCreateEditor={props.onCreate}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !props.readOnly,
        highlightActiveLineGutter: true,
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: true,
        searchKeymap: true,
        defaultKeymap: true,
        tabSize: 2,
      }}
    />
  );
}
