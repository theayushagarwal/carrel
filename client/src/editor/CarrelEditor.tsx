import { useEffect, useRef } from 'react';
import { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder,
  Decoration,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
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

export const brandHighlightStyle = HighlightStyle.define([
  {
    tag: [t.keyword, t.operatorKeyword, t.definitionKeyword, t.modifier],
    color: 'var(--syntax-keyword)',
  },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syntax-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syntax-number)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: t.invalid, color: 'var(--syntax-error)' },
]);

const editorTheme = EditorView.theme(
  {
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--panel)',
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: '14px',
    },
    '.cm-content': { caretColor: 'var(--accent)', padding: '22px 0' },
    '.cm-placeholder': { color: 'var(--muted)' },
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
    '.ͼc': { color: 'var(--syntax-keyword)' },
    '.ͼd': { color: 'var(--syntax-string)' },
    '.ͼe': { color: 'var(--syntax-error)' },
    '.ͼf': { color: 'var(--syntax-number)' },
  },
  { dark: true },
);

const setHighlightsEffect = StateEffect.define<DecorationSet>();
export const flashLineEffect = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(flashes, tr) {
    for (const e of tr.effects) {
      if (e.is(flashLineEffect)) {
        if (e.value === null) return Decoration.none;
        const lineNo = Math.max(1, Math.min(e.value, tr.newDoc.lines));
        const line = tr.newDoc.line(lineNo);
        return Decoration.set([Decoration.line({ class: 'cm-line-flash' }).range(line.from)]);
      }
    }
    return flashes.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(highlights, tr) {
    for (const e of tr.effects) {
      if (e.is(setHighlightsEffect)) return e.value;
    }
    return highlights.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

function computeHighlightDecorations(state: EditorState, awareness: Awareness): DecorationSet {
  const decorations: any[] = [];
  const now = Date.now();
  awareness.getStates().forEach((peerState: any) => {
    const h = peerState?.highlight;
    if (!h || typeof h.fromLine !== 'number') return;
    if (!h.pinned && now - h.ts > 6000) return;
    const userColor = peerState?.user?.color || 'var(--accent)';
    const fromLine = Math.max(1, Math.min(h.fromLine, state.doc.lines));
    const toLine = Math.max(fromLine, Math.min(h.toLine ?? fromLine, state.doc.lines));
    for (let l = fromLine; l <= toLine; l++) {
      const lineObj = state.doc.line(l);
      decorations.push(
        Decoration.line({
          class: h.pinned ? 'cm-line-highlight pinned' : 'cm-line-highlight',
          attributes: {
            style: `--line-highlight-color: ${userColor}; --line-highlight-bg: color-mix(in srgb, ${userColor} 18%, transparent);`,
          },
        }).range(lineObj.from),
      );
    }
  });
  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations, true);
}

export function CarrelEditor({
  provider,
  language,
  readOnly,
  onInput,
  onLineClick,
  onRegisterJumpToLine,
}: {
  provider: CarrelProvider;
  language: RoomLanguage;
  readOnly: boolean;
  onInput: () => void;
  onLineClick?: (line: number, extend: boolean) => void;
  onRegisterJumpToLine?: (fn: (line: number) => void) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();
  const languageCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const anchorLineRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const jumpToLine = (line: number) => {
    if (!viewRef.current) return;
    try {
      const view = viewRef.current;
      const doc = view.state.doc;
      const lineNo = Math.max(1, Math.min(line, doc.lines));
      const lineInfo = doc.line(lineNo);
      view.dispatch({
        effects: [
          EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
          flashLineEffect.of(lineNo),
        ],
      });
      setTimeout(() => {
        try {
          view.dispatch({ effects: flashLineEffect.of(null) });
        } catch {}
      }, 600);
    } catch {}
  };

  useEffect(() => {
    onRegisterJumpToLine?.(jumpToLine);
  }, [onRegisterJumpToLine]);

  const handleLineClick = (linePos: number, isShift: boolean) => {
    if (!viewRef.current) return;
    const lineNum = viewRef.current.state.doc.lineAt(linePos).number;
    onLineClick?.(lineNum, isShift);
    const currentHighlight = (provider.awareness.getLocalState() as any)?.highlight;

    let newHighlight: { fromLine: number; toLine: number; pinned: boolean; ts: number } | null =
      null;

    if (isShift && anchorLineRef.current !== null) {
      const from = Math.min(anchorLineRef.current, lineNum);
      const to = Math.max(anchorLineRef.current, lineNum);
      newHighlight = { fromLine: from, toLine: to, pinned: false, ts: Date.now() };
    } else {
      anchorLineRef.current = lineNum;
      if (
        currentHighlight &&
        currentHighlight.fromLine === lineNum &&
        currentHighlight.toLine === lineNum
      ) {
        if (!currentHighlight.pinned) {
          newHighlight = { ...currentHighlight, pinned: true, ts: Date.now() };
        } else {
          newHighlight = null;
        }
      } else {
        newHighlight = { fromLine: lineNum, toLine: lineNum, pinned: false, ts: Date.now() };
      }
    }

    provider.awareness.setLocalStateField('highlight', newHighlight);

    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    if (newHighlight && !newHighlight.pinned) {
      fadeTimerRef.current = setTimeout(() => {
        const cur = (provider.awareness.getLocalState() as any)?.highlight;
        if (cur && !cur.pinned) {
          provider.awareness.setLocalStateField('highlight', null);
        }
      }, 6000);
    }
  };

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
              handleLineClick(line.from, (event as MouseEvent).shiftKey);
              return false;
            },
          },
        }),
        history(),
        drawSelection(),
        highlightActiveLine(),
        syntaxHighlighting(brandHighlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        yCollab(ytext, provider.awareness as Awareness, { undoManager }),
        readOnlyCompartment.current.of([
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
        ]),
        EditorView.contentAttributes.of({ 'aria-label': 'Collaborative code editor' }),
        placeholder('Start a note in this room…'),
        editorTheme,
        highlightField,
        flashField,
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
    const updateDecorations = () => {
      queueMicrotask(() => {
        if (!viewRef.current) return;
        const decs = computeHighlightDecorations(
          viewRef.current.state,
          provider.awareness as Awareness,
        );
        viewRef.current.dispatch({ effects: setHighlightsEffect.of(decs) });
      });
    };
    provider.awareness.on('change', updateDecorations);
    updateDecorations();
    return () => {
      provider.awareness.off('change', updateDecorations);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
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
