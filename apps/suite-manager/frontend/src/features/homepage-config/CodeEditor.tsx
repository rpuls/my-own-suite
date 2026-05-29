import { indentWithTab, toggleComment } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import { keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useMemo, useRef } from 'react';
import { parseDocument } from 'yaml';

import type { HomepageConfigFile } from './types';

type CodeEditorProps = {
  ariaLabel?: string;
  language: HomepageConfigFile['language'];
  onChange: (value: string) => void;
  value: string;
};

const mosEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'rgba(9, 24, 39, 0.96)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--mos-radius-sm)',
      color: 'var(--text)',
      fontSize: '0.92rem',
      minHeight: 'min(70vh, 820px)',
    },
    '&.cm-focused': {
      borderColor: 'rgba(99, 226, 179, 0.5)',
      outline: '2px solid rgba(99, 226, 179, 0.34)',
      outlineOffset: '2px',
    },
    '.cm-content': {
      caretColor: 'var(--mos-color-accent)',
      fontFamily: '"Cascadia Code", "Courier New", monospace',
      lineHeight: '1.5',
      minHeight: 'min(70vh, 820px)',
      padding: '0.9rem 0',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--mos-color-accent)',
    },
    '.cm-gutters': {
      backgroundColor: 'rgba(15, 35, 55, 0.88)',
      borderRight: '1px solid var(--surface-border)',
      color: 'rgba(203, 218, 230, 0.74)',
    },
    '.cm-diagnosticAction': {
      backgroundColor: 'rgba(99, 226, 179, 0.16)',
    },
    '.cm-diagnostic-error': {
      borderLeftColor: 'var(--danger)',
    },
    '.cm-lintRange-error': {
      backgroundImage: 'linear-gradient(135deg, transparent 66%, var(--danger) 66%)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--mos-color-surface-elevated)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--mos-radius-sm)',
      color: 'var(--text)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(99, 226, 179, 0.1)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(99, 226, 179, 0.1)',
      color: 'var(--text)',
    },
    '.cm-line': {
      padding: '0 0.9rem',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(99, 226, 179, 0.18)',
      color: 'var(--text)',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(99, 226, 179, 0.24) !important',
    },
    '.cm-scroller': {
      fontFamily: '"Cascadia Code", "Courier New", monospace',
      overflow: 'auto',
    },
  },
  { dark: true },
);

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
  return linter((view) => {
    const document = parseDocument(view.state.doc.toString(), { prettyErrors: false });

    return document.errors.map<Diagnostic>((error) => {
      const from = Math.max(0, Math.min(error.pos[0], view.state.doc.length));
      const to = Math.max(from, Math.min(Math.max(error.pos[1], from + 1), view.state.doc.length));

      return {
        from,
        message: error.message,
        severity: 'error',
        source: 'YAML',
        to,
      };
    });
  });
}

function languageExtension(language: HomepageConfigFile['language']) {
  if (language === 'css') {
    return css();
  }

  if (language === 'javascript') {
    return javascript();
  }

  return yaml();
}

export default function CodeEditor({ ariaLabel = 'Code editor', language, onChange, value }: CodeEditorProps) {
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const isApplyingExternalValueRef = useRef(false);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  const extensions = useMemo(
    () => [
      keymap.of([
        { key: 'Ctrl-Shift-c', run: toggleComment },
        { key: 'Mod-Shift-c', run: toggleComment },
        indentWithTab,
      ]),
      basicSetup,
      languageExtension(language),
      language === 'yaml' ? [lintGutter(), yamlLinter()] : [],
      mosEditorTheme,
      syntaxHighlighting(mosHighlightStyle),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        'aria-label': ariaLabel,
        spellcheck: 'false',
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isApplyingExternalValueRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ],
    [ariaLabel, language],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!editorRootRef.current) {
      return undefined;
    }

    const view = new EditorView({
      doc: value,
      extensions,
      parent: editorRootRef.current,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    isApplyingExternalValueRef.current = true;
    try {
      view.dispatch({
        changes: {
          from: 0,
          insert: value,
          to: view.state.doc.length,
        },
      });
    } finally {
      isApplyingExternalValueRef.current = false;
    }
  }, [value]);

  return <div ref={editorRootRef} className="suite-code-editor" />;
}
