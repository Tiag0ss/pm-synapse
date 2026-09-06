'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { parseSynapseNoteLink, SYNAPSE_BOARD_BG } from '@/lib/whiteboardLinks';

import '@excalidraw/excalidraw/index.css';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== 'undefined') {
  window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';
}

const Excalidraw = dynamic(
  async () => (await import('@excalidraw/excalidraw')).Excalidraw,
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-[var(--muted)]">
        Loading board…
      </div>
    ),
  }
);

function parseBoard(raw: string | null): ExcalidrawInitialDataState {
  const baseApp = {
    viewBackgroundColor: SYNAPSE_BOARD_BG,
    // Prefer pan/zoom over drawing in peek / public wiki.
    activeTool: {
      type: 'hand' as const,
      customType: null,
      lastActiveTool: null,
      locked: false,
    },
  };
  if (!raw?.trim()) {
    return { elements: [], appState: baseApp, files: {} };
  }
  try {
    const parsed = JSON.parse(raw) as ExcalidrawInitialDataState;
    const savedBg = (parsed.appState as { viewBackgroundColor?: string } | undefined)
      ?.viewBackgroundColor;
    const c = String(savedBg || '').trim().toLowerCase();
    return {
      elements: parsed.elements || [],
      appState: {
        ...(parsed.appState || {}),
        ...baseApp,
        viewBackgroundColor: !c || c === 'transparent' ? SYNAPSE_BOARD_BG : String(savedBg).trim(),
      },
      files: parsed.files || {},
    };
  } catch {
    return { elements: [], appState: baseApp, files: {} };
  }
}

type WhiteboardPeekCanvasProps = {
  noteId: number;
  boardJson: string | null;
  /** Override default peek height styles. */
  className?: string;
  onOpenNote?: (noteId: number) => void;
};

/**
 * Board viewer for peek + public wiki.
 * Zoom / pan / canvas background are allowed (session-only); drawing chrome is hidden.
 * Note: Excalidraw disables the background picker when viewModeEnabled is true.
 */
export default function WhiteboardPeekCanvas({
  noteId,
  boardJson,
  className,
  onOpenNote,
}: WhiteboardPeekCanvasProps) {
  const initialData = useMemo(() => parseBoard(boardJson), [noteId, boardJson]);

  return (
    <div
      className={
        className ||
        'synapse-whiteboard synapse-whiteboard-viewer min-h-[min(70dvh,36rem)] w-full flex-1 overflow-hidden rounded-xl border border-[var(--border)]'
      }
    >
      <Excalidraw
        key={noteId}
        initialData={initialData}
        theme="dark"
        onLinkOpen={(element, event) => {
          const parsed = parseSynapseNoteLink(element.link);
          if (!parsed || !onOpenNote) return;
          event.preventDefault();
          onOpenNote(parsed.noteId);
        }}
        UIOptions={{
          canvasActions: {
            loadScene: false,
            export: false as const,
            saveToActiveFile: false,
            changeViewBackgroundColor: true,
            clearCanvas: false,
            toggleTheme: false,
          },
          tools: {
            image: false,
          },
        }}
      />
    </div>
  );
}
