import { indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import { keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef } from 'react';
import { parseDocument } from 'yaml';

const mosEditorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--mos-color-bg-soft)', color: 'var(--mos-color-text)', fontSize: '0.92rem' },
  '&.cm-focused': { outline: 'var(--mos-focus-ring)', outlineOffset: '-2px' },
  '.cm-content': { caretColor: 'var(--mos-color-accent)', fontFamily: '"Cascadia Code", "Courier New", monospace', lineHeight: '1.5', padding: '0.9rem 0' },
  '.cm-cursor': { borderLeftColor: 'var(--mos-color-accent)' },
  '.cm-gutters': { backgroundColor: 'var(--mos-color-surface-elevated)', borderRight: '1px solid var(--mos-color-surface-border)', color: 'var(--mos-color-text-muted)' },
  '.cm-line': { padding: '0 0.9rem' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--mos-color-accent-soft)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--mos-color-accent-focus) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--mos-color-surface-elevated)', border: '1px solid var(--mos-color-surface-border)', color: 'var(--mos-color-text)' },
}, { dark: true });

const mosHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--mos-color-text-muted)', fontStyle: 'italic' },
  { tag: [tags.name, tags.propertyName], color: 'var(--mos-color-info)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--mos-color-warning)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--mos-color-warning)' },
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--mos-color-text-strong)' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--mos-color-text-muted)' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: 'var(--mos-color-accent)' },
  { tag: [tags.atom, tags.labelName], color: 'var(--mos-color-info)' },
  { tag: tags.invalid, color: 'var(--mos-color-danger)' },
]);

function yamlLinter() {
  return linter((view) => parseDocument(view.state.doc.toString(), { prettyErrors: false }).errors.map<Diagnostic>((error) => ({
    from: Math.max(0, Math.min(error.pos[0], view.state.doc.length)),
    message: error.message,
    severity: 'error',
    source: 'YAML',
    to: Math.max(1, Math.min(error.pos[1], view.state.doc.length)),
  })));
}

export function CodeEditor({ onChange, value }: { onChange: (value: string) => void; value: string }) {
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!root.current) return;
    const editor = new EditorView({
      doc: value,
      extensions: [
        basicSetup, yaml(), lintGutter(), yamlLinter(), keymap.of([indentWithTab]), mosEditorTheme,
        syntaxHighlighting(mosHighlightStyle), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Homepage YAML editor', spellcheck: 'false' }),
        EditorView.updateListener.of((update) => { if (update.docChanged) onChangeRef.current(update.state.doc.toString()); }),
      ],
      parent: root.current,
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === value) return;
    editor.dispatch({ changes: { from: 0, insert: value, to: editor.state.doc.length } });
  }, [value]);
  return <div className="suite-code-editor" ref={root} />;
}
