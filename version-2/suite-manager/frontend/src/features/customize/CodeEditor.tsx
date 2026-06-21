import { indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import { keymap } from '@codemirror/view';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useRef } from 'react';
import { parseDocument } from 'yaml';

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
        basicSetup, yaml(), lintGutter(), yamlLinter(), keymap.of([indentWithTab]), EditorView.lineWrapping,
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
