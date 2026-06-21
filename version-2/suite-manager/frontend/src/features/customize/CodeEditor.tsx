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
  '&': { backgroundColor: 'rgba(9, 24, 39, 0.98)', color: 'var(--mos-color-text)', fontSize: '0.92rem' },
  '&.cm-focused': { outline: '2px solid rgba(99, 226, 179, 0.34)', outlineOffset: '-2px' },
  '.cm-content': { caretColor: 'var(--mos-color-accent)', fontFamily: '"Cascadia Code", "Courier New", monospace', lineHeight: '1.5', padding: '0.9rem 0' },
  '.cm-cursor': { borderLeftColor: 'var(--mos-color-accent)' },
  '.cm-gutters': { backgroundColor: 'rgba(15, 35, 55, 0.96)', borderRight: '1px solid var(--mos-color-surface-border)', color: 'rgba(203, 218, 230, 0.74)' },
  '.cm-line': { padding: '0 0.9rem' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(99, 226, 179, 0.1)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(99, 226, 179, 0.24) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--mos-color-surface-elevated)', border: '1px solid var(--mos-color-surface-border)', color: 'var(--mos-color-text)' },
}, { dark: true });

const mosHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#8da6b8', fontStyle: 'italic' },
  { tag: [tags.name, tags.propertyName], color: '#8fd3ff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#f7d88a' },
  { tag: [tags.number, tags.bool, tags.null], color: '#ffb86b' },
  { tag: [tags.keyword, tags.operatorKeyword], color: '#b9a7ff' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: '#cbdce8' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: '#63e2b3' },
  { tag: [tags.atom, tags.labelName], color: '#f5a6d6' },
  { tag: tags.invalid, color: '#ff8c8c' },
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
