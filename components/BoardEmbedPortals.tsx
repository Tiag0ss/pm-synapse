'use client';

import { useEffect, useRef, useState } from 'react';
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
  /** Chrome label (alias when `![[target|alias]]`). */
  title: string;
  /** Target path/title for Create whiteboard (`[[target|alias]]` → target). */
  createTitle: string;
  vaultId: number | null;
  missing: boolean;
};

/** Session cache so preview remounts don't flash Loading board… */
const boardJsonSessionCache = new Map<string, string | null>();

function boardCacheKey(noteId: number, vaultId: number | null): string {
  return `${vaultId ?? 0}:${noteId}`;
}

/** Drop cached board JSON so embeds re-fetch after a whiteboard save. */
export function invalidateBoardEmbedCache(noteId?: number, vaultId?: number | null) {
  if (noteId == null || noteId <= 0) {
    boardJsonSessionCache.clear();
    return;
  }
  const exact = boardCacheKey(noteId, vaultId ?? null);
  boardJsonSessionCache.delete(exact);
  // Also clear entries keyed with unknown/default vault.
  boardJsonSessionCache.delete(boardCacheKey(noteId, null));
  boardJsonSessionCache.delete(boardCacheKey(noteId, 0));
}

/** Collect `.synapse-board-embed` placeholders after preview HTML is written. */
export function collectBoardEmbedMounts(container: HTMLElement): BoardEmbedMount[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.synapse-board-embed')).map(
    (el, index) => {
      const noteId = Number(el.dataset.noteId || 0);
      const vaultIdRaw = Number(el.dataset.vaultId || 0);
      const missing =
        el.classList.contains('is-missing') ||
        el.dataset.missing === '1' ||
        !noteId;
      const createTitle = String(el.dataset.noteTitle || 'Whiteboard');
      const title = String(el.dataset.displayTitle || el.dataset.noteTitle || 'Whiteboard');
      // Clear preprocess placeholder text before React portals in.
      el.replaceChildren();
      el.className = missing ? 'synapse-board-embed is-missing' : 'synapse-board-embed';
      return {
        key: `${missing ? 'm' : 'b'}-${noteId || 'x'}-${index}-${createTitle}`,
        el,
        noteId,
        title,
        createTitle,
        vaultId: vaultIdRaw > 0 ? vaultIdRaw : null,
        missing,
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
  missing,
  canEdit,
  onOpenNote,
  onCreateWhiteboard,
  onEditBoard,
}: {
  noteId: number;
  title: string;
  boardJson: string | null;
  loading: boolean;
  error: string | null;
  missing: boolean;
  canEdit?: boolean;
  onOpenNote?: (noteId: number) => void;
  onCreateWhiteboard?: () => void;
  onEditBoard?: () => void;
}) {
  const showCreate = Boolean(canEdit && missing && onCreateWhiteboard);
  const showEdit = Boolean(canEdit && !missing && noteId > 0 && onEditBoard);
  const showOpen = Boolean(!canEdit && !missing && noteId > 0 && onOpenNote);

  return (
    <div className="synapse-board-embed-frame">
      <div className="synapse-board-embed-chrome">
        <span className="synapse-board-embed-title">{title}</span>
        <div className="synapse-board-embed-actions">
          {showCreate ? (
            <button
              type="button"
              className="btn-primary synapse-board-embed-open py-1 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onCreateWhiteboard?.();
              }}
            >
              Create whiteboard
            </button>
          ) : null}
          {showEdit ? (
            <button
              type="button"
              className="btn-primary synapse-board-embed-open py-1 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEditBoard?.();
              }}
            >
              Edit board
            </button>
          ) : null}
          {showOpen ? (
            <button
              type="button"
              className="btn-primary synapse-board-embed-open py-1 text-xs"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenNote?.(noteId);
              }}
            >
              Open board
            </button>
          ) : null}
        </div>
      </div>
      {missing ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-sm text-[var(--muted)]">
          {canEdit
            ? 'No whiteboard with this name yet. Create one to embed it here.'
            : 'Whiteboard not found'}
        </div>
      ) : loading ? (
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
          fitToContent
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
  canEdit,
  onOpenNote,
  onCreateWhiteboardEmbed,
  onEditBoardEmbed,
}: {
  mount: BoardEmbedMount;
  fetchBoard?: (noteId: number, vaultId: number | null) => Promise<string | null>;
  boardMap?: Record<string, string | null>;
  canEdit?: boolean;
  onOpenNote?: (noteId: number, vaultId?: number) => void;
  onCreateWhiteboardEmbed?: (title: string, vaultId?: number | null) => void;
  onEditBoardEmbed?: (noteId: number, vaultId?: number | null) => void;
}) {
  const mapKey = String(mount.noteId);
  const fromMap =
    boardMap && Object.prototype.hasOwnProperty.call(boardMap, mapKey)
      ? boardMap[mapKey]
      : undefined;
  const hasMapEntry = fromMap !== undefined;
  const cacheKey = boardCacheKey(mount.noteId, mount.vaultId);
  const fromSession =
    !mount.missing && mount.noteId > 0 && boardJsonSessionCache.has(cacheKey)
      ? boardJsonSessionCache.get(cacheKey)
      : undefined;
  const hasSession = fromSession !== undefined;

  const [boardJson, setBoardJson] = useState<string | null>(() => {
    if (mount.missing) return null;
    if (hasMapEntry && fromMap != null) return fromMap;
    if (hasSession && fromSession != null) return fromSession;
    return null;
  });
  const [loading, setLoading] = useState(() => {
    if (mount.missing || !mount.noteId) return false;
    if (hasMapEntry) return false;
    if (hasSession) return false;
    return true;
  });
  const [error, setError] = useState<string | null>(() => {
    if (mount.missing) return null;
    if (!mount.noteId) return 'Missing whiteboard';
    if (hasMapEntry && fromMap == null) return `Board unavailable: ${mount.title}`;
    if (hasSession && fromSession == null) return `Failed to load ${mount.title}`;
    return null;
  });

  // Keep latest fetchBoard without re-running effect on identity churn.
  const fetchBoardRef = useRef(fetchBoard);
  fetchBoardRef.current = fetchBoard;

  useEffect(() => {
    if (mount.missing) {
      setLoading(false);
      setError(null);
      setBoardJson(null);
      return;
    }

    if (hasMapEntry) {
      if (fromMap == null) {
        setError(`Board unavailable: ${mount.title}`);
        setBoardJson(null);
      } else {
        setError(null);
        setBoardJson(fromMap);
        boardJsonSessionCache.set(cacheKey, fromMap);
      }
      setLoading(false);
      return;
    }

    if (!mount.noteId) {
      setError('Missing whiteboard');
      setLoading(false);
      return;
    }

    const fetchFn = fetchBoardRef.current;
    if (!fetchFn) {
      setError(`Failed to load ${mount.title}`);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Stale-while-revalidate: keep prior canvas visible; only spin when empty.
    if (!hasSession) setLoading(true);
    void (async () => {
      try {
        const json = await fetchFn(mount.noteId, mount.vaultId);
        if (cancelled) return;
        boardJsonSessionCache.set(cacheKey, json);
        if (json == null) {
          setError(`Failed to load ${mount.title}`);
          setBoardJson(null);
        } else {
          setBoardJson(json);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          boardJsonSessionCache.set(cacheKey, null);
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
  }, [
    mount.noteId,
    mount.title,
    mount.vaultId,
    mount.missing,
    hasMapEntry,
    fromMap,
    hasSession,
    cacheKey,
  ]);

  return createPortal(
    <BoardEmbedFrame
      noteId={mount.noteId}
      title={mount.title}
      boardJson={boardJson}
      loading={loading}
      error={error}
      missing={mount.missing}
      canEdit={canEdit}
      onOpenNote={
        onOpenNote ? (id) => onOpenNote(id, mount.vaultId ?? undefined) : undefined
      }
      onCreateWhiteboard={
        onCreateWhiteboardEmbed
          ? () => onCreateWhiteboardEmbed(mount.createTitle, mount.vaultId)
          : undefined
      }
      onEditBoard={
        onEditBoardEmbed && mount.noteId
          ? () => onEditBoardEmbed(mount.noteId, mount.vaultId)
          : undefined
      }
    />,
    mount.el
  );
}

type BoardEmbedPortalsProps = {
  mounts: BoardEmbedMount[];
  fetchBoard?: (noteId: number, vaultId: number | null) => Promise<string | null>;
  boardMap?: Record<string, string | null>;
  canEdit?: boolean;
  onOpenNote?: (noteId: number, vaultId?: number) => void;
  onCreateWhiteboardEmbed?: (title: string, vaultId?: number | null) => void;
  onEditBoardEmbed?: (noteId: number, vaultId?: number | null) => void;
};

/** Portal-based board embeds — avoids nested createRoot unmount races. */
export default function BoardEmbedPortals({
  mounts,
  fetchBoard,
  boardMap,
  canEdit,
  onOpenNote,
  onCreateWhiteboardEmbed,
  onEditBoardEmbed,
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
          canEdit={canEdit}
          onOpenNote={onOpenNote}
          onCreateWhiteboardEmbed={onCreateWhiteboardEmbed}
          onEditBoardEmbed={onEditBoardEmbed}
        />
      ))}
    </>
  );
}

export { fetchVaultBoardJson, fetchWikiBoardJson };
