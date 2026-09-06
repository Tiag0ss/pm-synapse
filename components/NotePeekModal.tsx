'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  renderSynapseMarkdown,
  type LinkableVaultNotes,
  type NoteIndexEntry,
} from '@/lib/renderMarkdown';
import { handleMarkdownCodeCopyClick } from '@/lib/codeCopy';
import { renderMermaidInRoot } from '@/lib/mermaidRender';
import { fetchVaultBoardJson, fetchWikiBoardJson } from '@/lib/hydrateBoardEmbeds';
import { useBoardEmbedPreview } from '@/lib/useBoardEmbedPreview';
import BoardEmbedPortals from '@/components/BoardEmbedPortals';
import {
  applyPeekHits,
  clearPeekHits,
  setActivePeekHit,
} from '@/lib/peekFindInPreview';
import WhiteboardPeekCanvas from '@/components/WhiteboardPeekCanvas';

export type NotePeekTarget = {
  noteId: number;
  vaultId: number;
  titleHint?: string;
  /** When set, fetch from public wiki API instead of vault notes API. */
  wikiSlug?: string;
};

type NotePeekModalProps = {
  open: boolean;
  target: NotePeekTarget | null;
  notes?: NoteIndexEntry[];
  linkableVaults?: LinkableVaultNotes[];
  onClose: () => void;
  onOpenNote: (noteId: number, vaultId?: number) => void;
  /** Replace peek target (nested link text click). */
  onPeekNote: (next: NotePeekTarget) => void;
  onCreateNoteFromWikilink?: (title: string) => void;
  onCreateCrossVaultNote?: (vaultId: number, title: string) => void;
};

export default function NotePeekModal({
  open,
  target,
  notes = [],
  linkableVaults = [],
  onClose,
  onOpenNote,
  onPeekNote,
  onCreateNoteFromWikilink,
  onCreateCrossVaultNote,
}: NotePeekModalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const hitsRef = useRef<HTMLElement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [bodyMarkdown, setBodyMarkdown] = useState('');
  /** Public wiki API returns sanitized HTML (media URLs rewritten); prefer over re-render. */
  const [bodyHtml, setBodyHtml] = useState<string | null>(null);
  const [itemKind, setItemKind] = useState<'note' | 'whiteboard'>('note');
  const [boardJson, setBoardJson] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const onOpenNoteRef = useRef(onOpenNote);
  onOpenNoteRef.current = onOpenNote;

  const isWhiteboard = itemKind === 'whiteboard';

  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBodyMarkdown('');
    setBodyHtml(null);
    setBoardJson(null);
    setItemKind('note');
    setTitle(target.titleHint || '');
    setQuery('');
    setMatchIndex(0);
    setMatchCount(0);
    hitsRef.current = [];

    const url = target.wikiSlug
      ? `/api/public/${encodeURIComponent(target.wikiSlug)}/notes/${target.noteId}`
      : `/api/vaults/${target.vaultId}/notes/${target.noteId}`;

    void (async () => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(data.message || 'Failed to load note');
          setLoading(false);
          return;
        }
        const n = data.data || data;
        setTitle(String(n.Title || n.title || target.titleHint || 'Note'));
        const kind =
          String(n.Kind || n.kind || 'note') === 'whiteboard' ? 'whiteboard' : 'note';
        setItemKind(kind);
        if (kind === 'whiteboard') {
          setBoardJson(n.BoardJson != null ? String(n.BoardJson) : null);
          setBodyHtml(null);
          setBodyMarkdown('');
        } else if (target.wikiSlug && typeof n.html === 'string') {
          setBodyHtml(n.html);
          setBodyMarkdown('');
        } else {
          setBodyHtml(null);
          setBodyMarkdown(String(n.BodyMarkdown || n.bodyMarkdown || ''));
        }
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError('Failed to load note');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, target]);

  useEffect(() => {
    if (!open || loading || error || isWhiteboard) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, loading, error, isWhiteboard, target?.noteId]);

  const html = useMemo(() => {
    if (isWhiteboard) return '';
    if (bodyHtml != null) return bodyHtml;
    return renderSynapseMarkdown(bodyMarkdown, notes, linkableVaults, target?.noteId ?? null);
  }, [isWhiteboard, bodyHtml, bodyMarkdown, notes, linkableVaults, target?.noteId]);

  const afterPeekWrite = useCallback((root: HTMLElement) => {
    void renderMermaidInRoot(root);
  }, []);

  const embedMounts = useBoardEmbedPreview(bodyRef, {
    html,
    enabled: open && !isWhiteboard,
    afterWrite: afterPeekWrite,
  });

  const fetchEmbedBoard = useCallback(
    async (embedNoteId: number, embedVaultId: number | null) => {
      const wikiSlug = target?.wikiSlug;
      if (wikiSlug) return fetchWikiBoardJson(wikiSlug, embedNoteId);
      const vid = embedVaultId || target?.vaultId || 0;
      if (!vid) return null;
      return fetchVaultBoardJson(vid, embedNoteId);
    },
    [target?.wikiSlug, target?.vaultId]
  );

  const onEmbedOpenNote = useCallback((id: number, embedVaultId?: number) => {
    onOpenNoteRef.current(id, embedVaultId || target?.vaultId);
  }, [target?.vaultId]);

  useLayoutEffect(() => {
    const root = bodyRef.current;
    if (!root || !open || loading || error || isWhiteboard) return;

    const q = query.trim();
    if (!q) {
      clearPeekHits(root);
      hitsRef.current = [];
      setMatchCount(0);
      setMatchIndex(0);
      return;
    }

    const hits = applyPeekHits(root, q);
    hitsRef.current = hits;
    setMatchCount(hits.length);
    const nextIndex = hits.length ? 0 : 0;
    setMatchIndex(nextIndex);
    if (hits.length) setActivePeekHit(hits, nextIndex);
  }, [query, html, open, loading, error, isWhiteboard]);

  useEffect(() => {
    if (!open || !target || isWhiteboard) return;
    const root = bodyRef.current;
    if (!root) return;

    const onClick = (e: MouseEvent) => {
      if (handleMarkdownCodeCopyClick(e, root)) return;

      const goto = (e.target as HTMLElement).closest('.synapse-note-goto') as HTMLElement | null;
      const peek = (e.target as HTMLElement).closest('.synapse-note-peek') as HTMLElement | null;
      const locked = (e.target as HTMLElement).closest('.synapse-wikilink.is-locked');
      if (locked && root.contains(locked)) {
        e.preventDefault();
        return;
      }

      const hit = goto || peek;
      if (!hit || !root.contains(hit)) return;
      e.preventDefault();
      e.stopPropagation();

      const ref = hit.closest('.synapse-note-ref') as HTMLElement | null;
      if (!ref) return;
      const id = Number(ref.dataset.noteId || 0);
      const vaultId = Number(ref.dataset.vaultId || target.vaultId || 0);
      const missingTitle = String(ref.dataset.noteTitle || '').trim();
      const isMissing = ref.classList.contains('is-missing') || !id;

      if (isMissing) {
        if (!missingTitle) return;
        const external =
          vaultId > 0 && target.vaultId > 0 && vaultId !== target.vaultId;
        if (external && onCreateCrossVaultNote) {
          onCreateCrossVaultNote(vaultId, missingTitle);
          return;
        }
        onCreateNoteFromWikilink?.(missingTitle);
        return;
      }

      if (goto) {
        onOpenNote(id, vaultId > 0 ? vaultId : target.vaultId);
        onClose();
        return;
      }

      onPeekNote({
        noteId: id,
        vaultId: vaultId > 0 ? vaultId : target.vaultId,
        titleHint: missingTitle || undefined,
        wikiSlug: target.wikiSlug,
      });
    };

    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [
    open,
    target,
    html,
    isWhiteboard,
    onClose,
    onOpenNote,
    onPeekNote,
    onCreateNoteFromWikilink,
    onCreateCrossVaultNote,
  ]);

  const goToMatch = (delta: number) => {
    const hits = hitsRef.current;
    if (!hits.length) return;
    const next = (matchIndex + delta + hits.length) % hits.length;
    setMatchIndex(next);
    setActivePeekHit(hits, next);
  };

  if (!open || !target) return null;

  const canSearch = !loading && !error && !isWhiteboard;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title || (isWhiteboard ? 'Whiteboard preview' : 'Note preview')}
        className={`flex w-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/40 ${
          isWhiteboard
            ? 'h-[min(90dvh,52rem)] max-w-5xl'
            : 'max-h-[min(90dvh,48rem)] max-w-3xl'
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2 sm:gap-3 sm:px-4">
          <h2 className="min-w-0 max-w-[40%] shrink truncate text-sm font-semibold tracking-tight text-[var(--text)] sm:text-base">
            {title || (isWhiteboard ? 'Whiteboard' : 'Note')}
            {isWhiteboard ? (
              <span className="ml-2 text-[10px] font-medium uppercase tracking-wide text-[var(--muted)]">
                Board
              </span>
            ) : null}
          </h2>
          {!isWhiteboard ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <input
                ref={searchRef}
                type="search"
                className="input min-w-0 flex-1 py-1 text-xs sm:text-sm"
                placeholder="Find…"
                value={query}
                disabled={!canSearch}
                aria-label="Find in note"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    goToMatch(e.shiftKey ? -1 : 1);
                  }
                  if (e.key === 'Escape' && query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery('');
                  }
                }}
              />
              <span
                className="w-10 shrink-0 text-center tabular-nums text-[10px] text-[var(--muted)] sm:w-12 sm:text-xs"
                aria-live="polite"
              >
                {query.trim() ? (matchCount ? `${matchIndex + 1}/${matchCount}` : '0/0') : ''}
              </span>
              <button
                type="button"
                className="btn-ghost px-1.5 py-0.5 text-xs"
                disabled={!matchCount}
                aria-label="Previous match"
                onClick={() => goToMatch(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="btn-ghost px-1.5 py-0.5 text-xs"
                disabled={!matchCount}
                aria-label="Next match"
                onClick={() => goToMatch(1)}
              >
                ›
              </button>
            </div>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="btn-primary py-1 text-xs sm:text-sm"
              disabled={loading || Boolean(error)}
              onClick={() => {
                onOpenNote(target.noteId, target.vaultId);
                onClose();
              }}
            >
              {isWhiteboard ? 'Open board' : 'Open note'}
            </button>
            <button type="button" className="btn-ghost text-xs sm:text-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div
          className={
            isWhiteboard
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden p-3 sm:p-4'
              : 'min-h-0 flex-1 overflow-y-auto px-4 py-3'
          }
        >
          {loading && <p className="text-sm text-[var(--muted)]">Loading…</p>}
          {!loading && error && <p className="text-sm text-[var(--danger)]">{error}</p>}
          {!loading && !error && isWhiteboard && (
            <WhiteboardPeekCanvas
              noteId={target.noteId}
              boardJson={boardJson}
              className="synapse-whiteboard synapse-whiteboard-viewer min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-[var(--border)]"
              onOpenNote={(id) => {
                onOpenNote(id, target.vaultId);
                onClose();
              }}
            />
          )}
          {!loading && !error && !isWhiteboard && (
            <div
              ref={bodyRef}
              className="synapse-md-preview prose-synapse text-sm leading-relaxed text-[var(--text)]"
            />
          )}
          <BoardEmbedPortals
            mounts={embedMounts}
            fetchBoard={fetchEmbedBoard}
            onOpenNote={onEmbedOpenNote}
          />
        </div>
      </div>
    </div>
  );
}
