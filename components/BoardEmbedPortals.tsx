'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import WhiteboardPeekCanvas from '@/components/WhiteboardPeekCanvas';
import {
  fetchVaultBoardJson,
  fetchWikiBoardJson,
} from '@/lib/hydrateBoardEmbeds';

export type BoardEmbedMount = {
  key: string;
  el: HTMLElement;
  noteId: number;
  title: string;
  vaultId: number | null;
};

/** Collect `.synapse-board-embed` placeholders after preview HTML is written. */
export function collectBoardEmbedMounts(container: HTMLElement): BoardEmbedMount[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.synapse-board-embed')).map(
    (el, index) => {
      const noteId = Number(el.dataset.noteId || 0);
      const vaultIdRaw = Number(el.dataset.vaultId || 0);
      // Clear preprocess placeholder text before React portals in.
      el.replaceChildren();
      el.className = 'synapse-board-embed';
      return {
        key: `${noteId || 'x'}-${index}-${el.dataset.noteTitle || ''}`,
        el,
        noteId,
        title: String(el.dataset.noteTitle || 'Whiteboard'),
        vaultId: vaultIdRaw > 0 ? vaultIdRaw : null,
      };
    }
  );
}

function BoardEmbedFrame({
  noteId,
  title,
  boardJson,
  loading,
  error,
  onOpenNote,
}: {
  noteId: number;
  title: string;
  boardJson: string | null;
  loading: boolean;
  error: string | null;
  onOpenNote?: (noteId: number) => void;
}) {
  return (
    <div className="synapse-board-embed-frame">
      <div className="synapse-board-embed-chrome">
        <span className="synapse-board-embed-title">{title}</span>
        {onOpenNote ? (
          <button
            type="button"
            className="btn-primary synapse-board-embed-open py-1 text-xs"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenNote(noteId);
            }}
          >
            Open board
          </button>
        ) : null}
      </div>
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--muted)]">
          Loading board…
        </div>
      ) : error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-sm text-[var(--danger)]">
          {error}
        </div>
      ) : (
        <WhiteboardPeekCanvas
          noteId={noteId}
          boardJson={boardJson}
          className="synapse-whiteboard synapse-whiteboard-viewer synapse-whiteboard-embed flex min-h-0 w-full flex-1 flex-col overflow-hidden"
          onOpenNote={onOpenNote}
        />
      )}
    </div>
  );
}

function BoardEmbedPortalItem({
  mount,
  fetchBoard,
  boardMap,
  onOpenNote,
}: {
  mount: BoardEmbedMount;
  fetchBoard?: (noteId: number, vaultId: number | null) => Promise<string | null>;
  boardMap?: Record<string, string | null>;
  onOpenNote?: (noteId: number, vaultId?: number) => void;
}) {
  const mapKey = String(mount.noteId);
  const fromMap =
    boardMap && Object.prototype.hasOwnProperty.call(boardMap, mapKey)
      ? boardMap[mapKey]
      : undefined;
  const hasMapEntry = fromMap !== undefined;

  const [boardJson, setBoardJson] = useState<string | null>(() =>
    hasMapEntry && fromMap != null ? fromMap : null
  );
  const [loading, setLoading] = useState(() => {
    if (!mount.noteId) return false;
    if (hasMapEntry) return false;
    return true;
  });
  const [error, setError] = useState<string | null>(() => {
    if (!mount.noteId) return 'Missing whiteboard';
    if (hasMapEntry && fromMap == null) return `Board unavailable: ${mount.title}`;
    return null;
  });

  useEffect(() => {
    if (hasMapEntry) {
      if (fromMap == null) {
        setError(`Board unavailable: ${mount.title}`);
        setBoardJson(null);
      } else {
        setError(null);
        setBoardJson(fromMap);
      }
      setLoading(false);
      return;
    }

    if (!mount.noteId) {
      setError('Missing whiteboard');
      setLoading(false);
      return;
    }
    if (!fetchBoard) {
      setError(`Failed to load ${mount.title}`);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const json = await fetchBoard(mount.noteId, mount.vaultId);
        if (cancelled) return;
        if (json == null) {
          setError(`Failed to load ${mount.title}`);
          setBoardJson(null);
        } else {
          setBoardJson(json);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(`Failed to load ${mount.title}`);
          setBoardJson(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mount.noteId, mount.title, mount.vaultId, fetchBoard, hasMapEntry, fromMap]);

  return createPortal(
    <BoardEmbedFrame
      noteId={mount.noteId}
      title={mount.title}
      boardJson={boardJson}
      loading={loading}
      error={error}
      onOpenNote={
        onOpenNote ? (id) => onOpenNote(id, mount.vaultId ?? undefined) : undefined
      }
    />,
    mount.el
  );
}

type BoardEmbedPortalsProps = {
  mounts: BoardEmbedMount[];
  fetchBoard?: (noteId: number, vaultId: number | null) => Promise<string | null>;
  boardMap?: Record<string, string | null>;
  onOpenNote?: (noteId: number, vaultId?: number) => void;
};

/** Portal-based board embeds — avoids nested createRoot unmount races. */
export default function BoardEmbedPortals({
  mounts,
  fetchBoard,
  boardMap,
  onOpenNote,
}: BoardEmbedPortalsProps) {
  if (!mounts.length) return null;
  return (
    <>
      {mounts.map((mount) => (
        <BoardEmbedPortalItem
          key={mount.key}
          mount={mount}
          fetchBoard={fetchBoard}
          boardMap={boardMap}
          onOpenNote={onOpenNote}
        />
      ))}
    </>
  );
}

export { fetchVaultBoardJson, fetchWikiBoardJson };
