import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { RoomLanguage } from '@carrel/shared';
import type { CarrelProvider } from '../collab/CarrelProvider';

const languageLoaders: Record<RoomLanguage, () => Promise<any>> = {
  plaintext: async () => [],
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  javascript: async () => (await import('@codemirror/lang-javascript')).javascript(),
  typescript: async () =>
    (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  python: async () => (await import('@codemirror/lang-python')).python(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  json: async () => (await import('@codemirror/lang-json')).json(),
};
const editorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--panel)',
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: '14px',
    },
    '.cm-content': { caretColor: 'var(--accent)', padding: '22px 0' },
    '.cm-line': { lineHeight: '22px', padding: '0 18px' },
    '.cm-gutters': {
      backgroundColor: 'var(--panel)',
      color: 'var(--muted)',
      border: 'none',
      paddingLeft: '10px',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
    '.cm-cursor': { borderLeft: '2px solid var(--accent)' },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--raised)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
    },
    '.ͼc': { color: 'var(--brass-300)' },
    '.ͼd': { color: 'var(--verdigris-500)' },
    '.ͼe': { color: 'var(--madder-500)' },
    '.ͼf': { color: 'var(--ochre-400)' },
  },
  { dark: true },
);

export function CarrelEditor({
  provider,
  language,
  readOnly,
  onInput,
  onLineClick,
}: {
  provider: CarrelProvider;
  language: RoomLanguage;
  readOnly: boolean;
  onInput: () => void;
  onLineClick?: (line: number, extend: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const languageCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    const ytext = provider.doc.getText('content');
    const undoManager = new Y.UndoManager(ytext);
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers({
          domEventHandlers: {
            mousedown: (_view, line, event) => {
              onLineClick?.(line.from, (event as MouseEvent).shiftKey);
              return false;
            },
          },
        }),
        history(),
        drawSelection(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        yCollab(ytext, provider.awareness as Awareness, { undoManager }),
        readOnlyCompartment.current.of([
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
        ]),
        placeholder('Start a note in this room…'),
        editorTheme,
        languageCompartment.current.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && update.transactions.some((tr) => tr.isUserEvent('input')))
            onInput();
        }),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      undoManager.destroy();
      viewRef.current = undefined;
    };
  }, [provider]);
  useEffect(() => {
    let active = true;
    languageLoaders[language]().then((extension) => {
      if (active && viewRef.current)
        viewRef.current.dispatch({ effects: languageCompartment.current.reconfigure(extension) });
    });
    return () => {
      active = false;
    };
  }, [language]);
  useEffect(() => {
    if (viewRef.current)
      viewRef.current.dispatch({
        effects: readOnlyCompartment.current.reconfigure([
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
        ]),
      });
  }, [readOnly]);
  return <div className="editor-host" ref={host} />;
}
