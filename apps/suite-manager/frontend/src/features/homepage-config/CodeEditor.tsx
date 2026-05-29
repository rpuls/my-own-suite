import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { yaml } from '@codemirror/lang-yaml';
import { basicSetup, EditorView } from 'codemirror';
import { useEffect, useMemo, useRef } from 'react';

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
      backgroundColor: 'rgba(6, 21, 38, 0.82)',
      border: '1px solid var(--surface-border)',
      borderRadius: 'var(--mos-radius-sm)',
      color: 'var(--text)',
      fontSize: '0.88rem',
      minHeight: 'min(64vh, 720px)',
    },
    '&.cm-focused': {
      outline: '2px solid rgba(99, 226, 179, 0.38)',
      outlineOffset: '2px',
    },
    '.cm-content': {
      caretColor: 'var(--mos-color-accent)',
      fontFamily: '"Cascadia Code", "Courier New", monospace',
      lineHeight: '1.5',
      minHeight: 'min(64vh, 720px)',
      padding: '0.9rem 0',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--mos-color-accent)',
    },
    '.cm-gutters': {
      backgroundColor: 'rgba(6, 21, 38, 0.5)',
      borderRight: '1px solid var(--surface-border)',
      color: 'var(--mos-color-text-muted)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(99, 226, 179, 0.08)',
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
      basicSetup,
      languageExtension(language),
      mosEditorTheme,
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
