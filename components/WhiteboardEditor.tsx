'use client';

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import dynamic from 'next/dynamic';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import {
  buildSynapseNoteLink,
  parseSynapseNoteLink,
  synapseCustomData,
  titleFromWhiteboardText,
  SYNAPSE_BOARD_BG,
} from '@/lib/whiteboardLinks';
import { noteFolderPath } from '@/lib/notePaths';

import '@excalidraw/excalidraw/index.css';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** Self-host fonts from /public/excalidraw (see scripts/copy-excalidraw-assets.mjs). */
if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';
}

const Excalidraw = dynamic(
  async () => {
    const mod = await import('@excalidraw/excalidraw');
    return mod.Excalidraw;
  },
  {
    ssr: false,
    loading: () => (
      <div
        className="h-full min-h-[240px] w-full"
        style={{ background: 'var(--bg)' }}
        aria-hidden
      />
    ),
  }
);

export type WhiteboardNoteOption = {
  id: number;
  title: string;
  path: string;
  kind?: string | null;
};

export type WhiteboardEditorHandle = {
  linkElementToNote: (elementId: string, noteId: number, noteTitle: string) => string | null;
};

type WhiteboardEditorProps = {
  noteId: number;
  vaultId: string;
  boardPath: string;
  boardJson: string | null;
  canEdit: boolean;
  notes: WhiteboardNoteOption[];
  onBoardChange: (boardJson: string) => void;
  onOpenNote: (noteId: number) => void;
  onPeekNote: (noteId: number, title: string) => void;
  onCreateNoteFromText: (title: string, elementId: string) => void;
};

/** Empty / transparent → Synapse dark default; otherwise keep Excalidraw’s color. */
function resolveCanvasBg(bg: string | null | undefined): string {
  const c = String(bg || '').trim().toLowerCase();
  if (!c || c === 'transparent') return SYNAPSE_BOARD_BG;
  return String(bg).trim();
}

function parseInitialData(raw: string | null): ExcalidrawInitialDataState {
  const darkApp = {
    viewBackgroundColor: SYNAPSE_BOARD_BG,
    currentItemStrokeColor: '#e8eef6',
    currentItemBackgroundColor: 'transparent',
  };

  if (!raw?.trim()) {
    return { elements: [], appState: darkApp, files: {} };
  }
  try {
    const parsed = JSON.parse(raw) as ExcalidrawInitialDataState;
    const savedBg = (parsed.appState as { viewBackgroundColor?: string } | undefined)
      ?.viewBackgroundColor;
    return {
      elements: parsed.elements || [],
      appState: {
        ...(parsed.appState || {}),
        ...darkApp,
        viewBackgroundColor: resolveCanvasBg(savedBg),
      },
      files: parsed.files || {},
    };
  } catch {
    return { elements: [], appState: darkApp, files: {} };
  }
}

function selectionKey(appState: Pick<AppState, 'selectedElementIds'>): string {
  return Object.keys(appState.selectedElementIds || {})
    .sort()
    .join(',');
}

function serializeBoardPayload(
  elements: readonly ExcalidrawElement[],
  appState: Pick<AppState, 'viewBackgroundColor'>,
  files: BinaryFiles
): string {
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'pm-synapse',
    elements,
    appState: {
      viewBackgroundColor: resolveCanvasBg(appState.viewBackgroundColor),
    },
    files,
  });
}

const WhiteboardEditor = forwardRef<WhiteboardEditorHandle, WhiteboardEditorProps>(
  function WhiteboardEditor(
    {
      noteId,
      vaultId,
      boardPath,
      boardJson,
      canEdit,
      notes,
      onBoardChange,
      onOpenNote,
      onPeekNote,
      onCreateNoteFromText,
    },
    ref
  ) {
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    const onBoardChangeRef = useRef(onBoardChange);
    onBoardChangeRef.current = onBoardChange;
    const lastEmittedJsonRef = useRef<string | null>(boardJson);
    const lastSelectionKeyRef = useRef('');
    const skipChangeRef = useRef(false);

    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [linkPickerOpen, setLinkPickerOpen] = useState(false);
    const [linkFilter, setLinkFilter] = useState('');

    const initialData = useMemo(() => {
      lastEmittedJsonRef.current = boardJson;
      lastSelectionKeyRef.current = '';
      return parseInitialData(boardJson);
      // Remount via Excalidraw key={noteId}; ignore live boardJson edits from autosave.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [noteId]);

    const folderPrefix = noteFolderPath(boardPath);

    const linkableNotes = useMemo(() => notes, [notes]);

    const filteredLinkNotes = useMemo(() => {
      const q = linkFilter.trim().toLowerCase();
      if (!q) return linkableNotes.slice(0, 80);
      return linkableNotes
        .filter(
          (n) =>
            n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
        )
        .slice(0, 80);
    }, [linkableNotes, linkFilter]);

    const emitBoard = useCallback((json: string) => {
      if (json === lastEmittedJsonRef.current) return;
      lastEmittedJsonRef.current = json;
      onBoardChangeRef.current(json);
    }, []);

    const linkElementToNote = useCallback(
      (elementId: string, targetNoteId: number, noteTitle: string) => {
        const api = apiRef.current;
        if (!api) return null;
        const link = buildSynapseNoteLink(targetNoteId);
        const custom = synapseCustomData(targetNoteId, noteTitle);
        skipChangeRef.current = true;
        const next = api.getSceneElements().map((el) => {
          if (el.id !== elementId) return el;
          return {
            ...el,
            link,
            customData: { ...(el.customData || {}), ...custom },
          } as ExcalidrawElement;
        });
        api.updateScene({ elements: next });
        skipChangeRef.current = false;
        const json = serializeBoardPayload(next, api.getAppState(), api.getFiles());
        emitBoard(json);
        return json;
      },
      [emitBoard]
    );

    useImperativeHandle(ref, () => ({ linkElementToNote }), [linkElementToNote]);

    const applyLinkToSelection = useCallback(
      (targetNoteId: number, noteTitle: string) => {
        const api = apiRef.current;
        if (!api || !canEdit) return;
        const selected = api.getAppState().selectedElementIds || {};
        const ids = new Set(Object.keys(selected));
        if (!ids.size) return;
        const link = buildSynapseNoteLink(targetNoteId);
        const custom = synapseCustomData(targetNoteId, noteTitle);
        skipChangeRef.current = true;
        const next = api.getSceneElements().map((el) => {
          if (!ids.has(el.id)) return el;
          const patch = {
            ...el,
            link,
            customData: { ...(el.customData || {}), ...custom },
          } as ExcalidrawElement;
          if (
            el.type === 'text' &&
            !String((el as { text?: string }).text || '').trim()
          ) {
            (patch as { text: string }).text = noteTitle;
          }
          return patch;
        });
        api.updateScene({ elements: next });
        skipChangeRef.current = false;
        setLinkPickerOpen(false);
        emitBoard(serializeBoardPayload(next, api.getAppState(), api.getFiles()));
      },
      [canEdit, emitBoard]
    );

    const unlinkSelection = useCallback(() => {
      const api = apiRef.current;
      if (!api || !canEdit) return;
      const selected = api.getAppState().selectedElementIds || {};
      const ids = new Set(Object.keys(selected));
      if (!ids.size) return;
      skipChangeRef.current = true;
      const next = api.getSceneElements().map((el) => {
        if (!ids.has(el.id)) return el;
        const customData = { ...(el.customData || {}) } as Record<string, unknown>;
        delete customData.synapse;
        return {
          ...el,
          link: null,
          customData: Object.keys(customData).length ? customData : undefined,
        } as ExcalidrawElement;
      });
      api.updateScene({ elements: next });
      skipChangeRef.current = false;
      emitBoard(serializeBoardPayload(next, api.getAppState(), api.getFiles()));
    }, [canEdit, emitBoard]);

    const handleChange = useCallback(
      (
        elements: readonly ExcalidrawElement[],
        appState: AppState,
        files: BinaryFiles
      ) => {
        const sel = selectionKey(appState);
        if (sel !== lastSelectionKeyRef.current) {
          lastSelectionKeyRef.current = sel;
          setSelectedIds(sel ? sel.split(',') : []);
        }

        if (skipChangeRef.current || !canEdit) return;
        emitBoard(serializeBoardPayload(elements, appState, files));
      },
      [canEdit, emitBoard]
    );

    const handleApi = useCallback((api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
    }, []);

    const uiOptions = useMemo(
      () => ({
        canvasActions: {
          loadScene: false,
          export: false as const,
          saveToActiveFile: false,
          changeViewBackgroundColor: true,
        },
      }),
      []
    );

    const handleLinkOpen = useCallback(
      (
        element: ExcalidrawElement,
        event: CustomEvent<{ nativeEvent: MouseEvent | React.PointerEvent }>
      ) => {
        const parsed = parseSynapseNoteLink(element.link);
        if (!parsed) return;
        event.preventDefault();
        const native = event.detail?.nativeEvent as MouseEvent | undefined;
        const peek = Boolean(native?.ctrlKey || native?.metaKey);
        const title =
          parsed.noteTitle ||
          linkableNotes.find((n) => n.id === parsed.noteId)?.title ||
          'Note';
        if (peek) onPeekNote(parsed.noteId, title);
        else onOpenNote(parsed.noteId);
      },
      [linkableNotes, onOpenNote, onPeekNote]
    );

    const primary = useMemo(() => {
      if (!selectedIds.length || !apiRef.current) return null;
      const idSet = new Set(selectedIds);
      return (
        apiRef.current.getSceneElements().find((el) => idSet.has(el.id) && !el.isDeleted) ||
        null
      );
    }, [selectedIds]);

    const linked = primary ? parseSynapseNoteLink(primary.link) : null;
    const textValue =
      selectedIds.length === 1 && primary?.type === 'text'
        ? String((primary as ExcalidrawElement & { text?: string }).text || '')
        : '';
    const createPrefill =
      selectedIds.length === 1 && primary
        ? titleFromWhiteboardText(textValue, folderPrefix)
        : '';
    const canCreateFromSelection = Boolean(canEdit && selectedIds.length === 1 && primary);

    const hostToolbarStyle: CSSProperties = {
      position: 'absolute',
      top: 8,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 5,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      maxWidth: 'min(92%, 42rem)',
      justifyContent: 'center',
    };

    return (
      <div className="synapse-whiteboard relative min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]">
        {canEdit && selectedIds.length > 0 ? (
          <div
            style={hostToolbarStyle}
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/95 px-2 py-1.5 shadow-lg backdrop-blur"
          >
            <button
              type="button"
              className="btn-ghost py-1 text-xs"
              onClick={() => {
                setLinkFilter('');
                setLinkPickerOpen(true);
              }}
            >
              Link to note…
            </button>
            {linked ? (
              <>
                <button
                  type="button"
                  className="btn-ghost py-1 text-xs"
                  onClick={() => onOpenNote(linked.noteId)}
                >
                  Open note
                </button>
                <button
                  type="button"
                  className="btn-ghost py-1 text-xs"
                  onClick={() =>
                    onPeekNote(
                      linked.noteId,
                      linked.noteTitle ||
                        linkableNotes.find((n) => n.id === linked.noteId)?.title ||
                        'Note'
                    )
                  }
                >
                  Preview
                </button>
                <button
                  type="button"
                  className="btn-ghost py-1 text-xs"
                  onClick={unlinkSelection}
                >
                  Unlink
                </button>
              </>
            ) : null}
            {canCreateFromSelection ? (
              <button
                type="button"
                className="btn-primary py-1 text-xs"
                onClick={() => {
                  if (!primary) return;
                  onCreateNoteFromText(createPrefill, primary.id);
                }}
              >
                Create note…
              </button>
            ) : null}
          </div>
        ) : null}

        <Excalidraw
          key={noteId}
          excalidrawAPI={handleApi}
          initialData={initialData}
          theme="dark"
          viewModeEnabled={!canEdit}
          UIOptions={uiOptions}
          onChange={handleChange}
          onLinkOpen={handleLinkOpen}
        />

        {linkPickerOpen ? (
          <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/50 p-4 pt-16 backdrop-blur-sm">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Link to note"
              className="flex max-h-[min(70vh,420px)] w-full max-w-md flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
            >
              <div className="border-b border-[var(--border)] px-4 py-3">
                <h3 className="text-sm font-semibold text-[var(--text)]">Link to note</h3>
                <input
                  autoFocus
                  className="input mt-2 w-full text-sm"
                  placeholder="Filter notes…"
                  value={linkFilter}
                  onChange={(e) => setLinkFilter(e.target.value)}
                />
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto p-2">
                {filteredLinkNotes.length === 0 ? (
                  <li className="px-2 py-3 text-xs text-[var(--muted)]">No notes found</li>
                ) : (
                  filteredLinkNotes.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="mb-0.5 w-full rounded-lg px-2.5 py-2 text-left hover:bg-[var(--surface-2)]/70"
                        onClick={() => applyLinkToSelection(n.id, n.title)}
                      >
                        <span className="block truncate text-sm font-medium text-[var(--text)]">
                          {n.title}
                          {(n.kind || 'note') === 'whiteboard' ? (
                            <span className="ml-1.5 text-[10px] font-normal uppercase text-[var(--muted)]">
                              Board
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-[10px] text-[var(--muted)]">
                          {n.path.replace(/\.md$/i, '')}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2">
                <button
                  type="button"
                  className="btn-primary py-1 text-xs"
                  disabled={!canCreateFromSelection}
                  onClick={() => {
                    if (!primary) return;
                    setLinkPickerOpen(false);
                    onCreateNoteFromText(createPrefill, primary.id);
                  }}
                >
                  Create new…
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setLinkPickerOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <span className="sr-only" data-vault={vaultId} />
      </div>
    );
  }
);

export default WhiteboardEditor;
