'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  renderSynapseMarkdown,
  type LinkableVaultNotes,
  type NoteIndexEntry,
} from '@/lib/renderMarkdown';
import type { FoldCard } from '@/lib/extractFoldCards';
import { renderMermaidInRoot } from '@/lib/mermaidRender';
import { handleMarkdownCodeCopyClick } from '@/lib/codeCopy';
import type { NotePeekTarget } from '@/components/NotePeekModal';
import MermaidLightbox from '@/components/MermaidLightbox';

type FlashcardsStudyProps = {
  cards: FoldCard[];
  notes?: NoteIndexEntry[];
  linkableVaults?: LinkableVaultNotes[];
  vaultId?: number;
  loading?: boolean;
  /** Esc returns to editor (toolbar already has Back). */
  onClose?: () => void;
  onOpenNote?: (noteId: number, vaultId?: number) => void;
  onPeekNote?: (target: NotePeekTarget) => void;
  onCreateNoteFromWikilink?: (title: string) => void;
  onCreateCrossVaultNote?: (vaultId: number, title: string) => void;
  emptyHint?: string;
};

function CardAnswer({
  markdown,
  notes,
  linkableVaults,
  noteId,
  vaultId,
  onOpenNote,
  onPeekNote,
  onCreateNoteFromWikilink,
  onCreateCrossVaultNote,
  onExpandMermaid,
}: {
  markdown: string;
  notes: NoteIndexEntry[];
  linkableVaults: LinkableVaultNotes[];
  noteId?: number;
  vaultId?: number;
  onOpenNote?: (noteId: number, vaultId?: number) => void;
  onPeekNote?: (target: NotePeekTarget) => void;
  onCreateNoteFromWikilink?: (title: string) => void;
  onCreateCrossVaultNote?: (vaultId: number, title: string) => void;
  onExpandMermaid?: (svgHtml: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const html = useMemo(
    () => renderSynapseMarkdown(markdown, notes, linkableVaults, noteId ?? null),
    [markdown, notes, linkableVaults, noteId]
  );

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = html || '';
    void renderMermaidInRoot(root);
  }, [html]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onClick = (e: MouseEvent) => {
      if (handleMarkdownCodeCopyClick(e, root)) return;

      const mermaidHit = (e.target as HTMLElement).closest(
        '.synapse-mermaid-expand, .synapse-mermaid:not(.synapse-mermaid-error) svg'
      );
      if (mermaidHit && root.contains(mermaidHit) && onExpandMermaid) {
        const wrap = mermaidHit.closest('.synapse-mermaid');
        const svg = wrap?.querySelector('svg');
        if (svg) {
          e.preventDefault();
          e.stopPropagation();
          onExpandMermaid(svg.outerHTML);
          return;
        }
      }

      const locked = (e.target as HTMLElement).closest('.synapse-wikilink.is-locked');
      if (locked && root.contains(locked)) {
        e.preventDefault();
        return;
      }

      const goto = (e.target as HTMLElement).closest('.synapse-note-goto') as HTMLElement | null;
      const peekBtn = (e.target as HTMLElement).closest(
        '.synapse-note-peek'
      ) as HTMLElement | null;
      const hit = goto || peekBtn;
      if (!hit || !root.contains(hit)) return;

      const ref = hit.closest('.synapse-note-ref') as HTMLElement | null;
      if (!ref) return;
      e.preventDefault();
      e.stopPropagation();

      const id = Number(ref.dataset.noteId || 0);
      const crossVaultId = Number(ref.dataset.vaultId || 0);
      const currentVaultId = vaultId && vaultId > 0 ? vaultId : 0;
      const missingTitle = String(ref.dataset.noteTitle || '').trim();
      const isMissing =
        ref.classList.contains('synapse-wikilink') &&
        (ref.classList.contains('is-missing') || !id);

      if (isMissing) {
        if (!missingTitle) return;
        const external =
          crossVaultId > 0 && currentVaultId > 0 && crossVaultId !== currentVaultId;
        if (external && onCreateCrossVaultNote) {
          onCreateCrossVaultNote(crossVaultId, missingTitle);
          return;
        }
        onCreateNoteFromWikilink?.(missingTitle);
        return;
      }

      if (peekBtn && id && onPeekNote) {
        const peekVault =
          crossVaultId && currentVaultId && crossVaultId !== currentVaultId
            ? crossVaultId
            : currentVaultId || crossVaultId;
        if (peekVault > 0) {
          onPeekNote({
            noteId: id,
            vaultId: peekVault,
            titleHint: missingTitle || undefined,
          });
        }
        return;
      }

      if (
        id &&
        crossVaultId &&
        currentVaultId &&
        crossVaultId !== currentVaultId &&
        onOpenNote
      ) {
        onOpenNote(id, crossVaultId);
        return;
      }
      if (id && onOpenNote) onOpenNote(id);
    };

    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [
    html,
    vaultId,
    onOpenNote,
    onPeekNote,
    onCreateNoteFromWikilink,
    onCreateCrossVaultNote,
    onExpandMermaid,
  ]);

  if (!markdown.trim()) {
    return <p className="text-sm italic text-[var(--muted)]">No answer</p>;
  }

  return (
    <div
      ref={rootRef}
      className="synapse-md-preview prose-synapse text-sm leading-relaxed text-[var(--text)]"
    />
  );
}

export default function FlashcardsStudy({
  cards,
  notes = [],
  linkableVaults = [],
  vaultId,
  loading = false,
  onClose,
  onOpenNote,
  onPeekNote,
  onCreateNoteFromWikilink,
  onCreateCrossVaultNote,
  emptyHint = 'No fold cards in this vault. Use :::fold- Question … ::: with the answer in the body.',
}: FlashcardsStudyProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const [mermaidLightbox, setMermaidLightbox] = useState<string | null>(null);

  useEffect(() => {
    setQuery('');
    setOpenKeys(new Set());
    setMermaidLightbox(null);
  }, [cards]);

  useEffect(() => {
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [cards]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mermaidLightbox) return;
        if (query) {
          e.preventDefault();
          setQuery('');
          return;
        }
        if (onClose) {
          e.preventDefault();
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, query, mermaidLightbox]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return cards;
    return cards.filter(
      (c) =>
        c.front.toLowerCase().includes(needle) ||
        c.backMarkdown.toLowerCase().includes(needle)
    );
  }, [cards, query]);

  const cardKey = (card: FoldCard, i: number) => `${card.front}::${i}`;

  const toggle = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="shrink-0 text-base font-semibold tracking-tight">Flashcards</h2>
        <input
          ref={searchRef}
          type="search"
          className="input min-w-[8rem] flex-1 py-1.5 text-sm sm:max-w-xs"
          placeholder="Search cards…"
          value={query}
          aria-label="Search cards"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="shrink-0 tabular-nums text-xs text-[var(--muted)]">
          {query.trim() ? `${filtered.length}/${cards.length}` : cards.length}
        </span>
      </div>

      {!loading && !cards.length && (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--panel)]/50 p-8 text-center text-sm text-[var(--muted)]">
          {emptyHint}
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
          Loading cards…
        </div>
      )}

      {!loading && cards.length > 0 && !filtered.length && (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--panel)]/50 p-8 text-center text-sm text-[var(--muted)]">
          No cards match “{query.trim()}”.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
          {filtered.map((card, i) => {
            const key = cardKey(card, i);
            const open = openKeys.has(key);
            return (
              <li key={key}>
                <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-sm shadow-black/15">
                  <div className="flex items-start gap-2 px-3 py-2.5">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-1 py-0.5 text-left transition hover:bg-[var(--surface-2)]/50"
                      aria-expanded={open}
                      onClick={() => toggle(key)}
                    >
                      <span
                        className="mt-0.5 shrink-0 text-[var(--muted)] transition-transform"
                        aria-hidden
                        style={{ transform: open ? 'rotate(90deg)' : undefined }}
                      >
                        ›
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-semibold tracking-tight text-[var(--text)]">
                          {card.front}
                        </span>
                        {card.sourceTitle ? (
                          <span className="mt-0.5 block truncate text-[11px] text-[var(--muted)]">
                            {card.sourceTitle}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {card.sourceNoteId && onOpenNote ? (
                      <button
                        type="button"
                        className="btn-ghost shrink-0 py-1 text-xs"
                        title="Open source note"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenNote(card.sourceNoteId!);
                        }}
                      >
                        Open note
                      </button>
                    ) : null}
                  </div>
                  {open && (
                    <div className="border-t border-[var(--border)] px-4 py-3 pl-10">
                      <CardAnswer
                        markdown={card.backMarkdown}
                        notes={notes}
                        linkableVaults={linkableVaults}
                        noteId={card.sourceNoteId}
                        vaultId={vaultId}
                        onOpenNote={onOpenNote}
                        onPeekNote={onPeekNote}
                        onCreateNoteFromWikilink={onCreateNoteFromWikilink}
                        onCreateCrossVaultNote={onCreateCrossVaultNote}
                        onExpandMermaid={(svg) => setMermaidLightbox(svg)}
                      />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <MermaidLightbox
        svgHtml={mermaidLightbox}
        onClose={() => setMermaidLightbox(null)}
      />
    </div>
  );
}
