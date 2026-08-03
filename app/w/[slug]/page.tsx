'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { resolveNoteId, type NoteIndexEntry } from '@/lib/renderMarkdown';
import NotesFolderTree from '@/components/NotesFolderTree';
import NoteGraphMindmap from '@/components/NoteGraphMindmap';
import QuickSwitcher from '@/components/QuickSwitcher';
import { noteLeafName } from '@/lib/notePaths';
import { handleMarkdownCodeCopyClick } from '@/lib/codeCopy';
import { applyPlannerButtons, type PlannerLinkItem } from '@/lib/plannerLinks';
import { renderMermaidInRoot } from '@/lib/mermaidRender';
import ImageLightbox from '@/components/ImageLightbox';
import MermaidLightbox from '@/components/MermaidLightbox';
import AppUserMenu from '@/components/AppUserMenu';
import { useIsLgUp } from '@/lib/useMediaQuery';

interface WikiLinkRow {
  Id: number;
  Title: string;
  Path: string;
  Kind: string;
}

export default function PublicWikiPage() {
  const params = useParams();
  const slug = String(params.slug);
  const [notes, setNotes] = useState<Array<{ Id: number; Title: string; Path: string; Icon?: string | null }>>([]);
  const [vaultName, setVaultName] = useState('');
  const [vaultId, setVaultId] = useState<number | null>(null);
  const [canOpenVault, setCanOpenVault] = useState(false);
  const [error, setError] = useState('');
  const [html, setHtml] = useState('');
  const [title, setTitle] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const isLgUp = useIsLgUp();
  const [backlinks, setBacklinks] = useState<WikiLinkRow[]>([]);
  const [references, setReferences] = useState<WikiLinkRow[]>([]);
  const [graph, setGraph] = useState<{
    nodes: Array<{ Id: number; Title: string }>;
    edges: Array<{ FromNoteId: number; ToNoteId: number; Kind: string }>;
  } | null>(null);
  const [graphToken, setGraphToken] = useState(0);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [mermaidLightbox, setMermaidLightbox] = useState<string | null>(null);
  const [plannerLinks, setPlannerLinks] = useState<PlannerLinkItem[]>([]);
  const articleRef = useRef<HTMLDivElement>(null);

  const noteIndex: NoteIndexEntry[] = notes.map((n) => ({
    id: n.Id,
    title: n.Title,
    path: n.Path,
  }));

  const filteredNotes = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter(
      (n) =>
        n.Title.toLowerCase().includes(needle) ||
        n.Path.toLowerCase().includes(needle) ||
        noteLeafName(n.Title).toLowerCase().includes(needle)
    );
  }, [notes, q]);

  const loadGraph = useCallback(async () => {
    const res = await fetch(`/api/public/${slug}/graph`, { credentials: 'include' });
    const data = await res.json();
    if (res.ok) {
      setGraph(data.data || { nodes: [], edges: [] });
      setGraphToken((t) => t + 1);
    }
  }, [slug]);

  const openNote = useCallback(
    async (id: number) => {
      const res = await fetch(`/api/public/${slug}/notes/${id}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401 || data.requiresAuth) {
          setError('This note requires sign-in. Sign in with Project Management, then reload.');
        } else {
          setError(data.message || 'Note unavailable');
        }
        return;
      }
      setError('');
      setActiveId(id);
      setNotesOpen(false);
      setContextOpen(false);
      setTitle(data.data.title);
      setHtml(data.data.html);
      setBacklinks(data.data.backlinks || []);
      setReferences(data.data.references || []);
      setPlannerLinks(
        Array.isArray(data.data.checkboxTasks)
          ? data.data.checkboxTasks.map(
              (t: { markerId?: string | null; openUrl?: string | null; pmTaskId?: number | null }) => ({
                markerId: t.markerId ?? null,
                openUrl: t.openUrl ?? null,
                pmTaskId: t.pmTaskId ?? null,
              })
            )
          : []
      );
      const url = new URL(window.location.href);
      url.searchParams.set('n', String(id));
      window.history.replaceState({}, '', url.toString());
    },
    [slug]
  );

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/public/${slug}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Not found');
        return;
      }
      setVaultName(data.data.vault.name);
      setVaultId(Number(data.data.vault.id) || null);
      setCanOpenVault(Boolean(data.data.canOpenVault));
      const list = data.data.notes || [];
      setNotes(list);
      if (data.data.robots) {
        const meta = document.createElement('meta');
        meta.name = 'robots';
        meta.content = data.data.robots;
        document.head.appendChild(meta);
      }
      void loadGraph();
      const fromQuery = Number(new URL(window.location.href).searchParams.get('n') || 0);
      if (fromQuery && list.some((n: { Id: number }) => n.Id === fromQuery)) {
        await openNote(fromQuery);
      } else if (fromQuery && !list.some((n: { Id: number }) => n.Id === fromQuery)) {
        await openNote(fromQuery);
      } else if (list[0]) {
        await openNote(list[0].Id);
      }
    })();
  }, [slug, openNote, loadGraph]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && quickOpen) {
        setQuickOpen(false);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [quickOpen]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      if (handleMarkdownCodeCopyClick(e, root)) return;

      const tocLink = (e.target as HTMLElement).closest(
        'a.synapse-toc-link'
      ) as HTMLAnchorElement | null;
      if (tocLink && root.contains(tocLink)) {
        const href = tocLink.getAttribute('href') || '';
        if (href.startsWith('#')) {
          e.preventDefault();
          e.stopPropagation();
          const id = decodeURIComponent(href.slice(1));
          const targetEl = root.querySelector(`#${CSS.escape(id)}`);
          if (targetEl instanceof HTMLElement) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }
      }

      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (img?.src && root.contains(img)) {
        e.preventDefault();
        e.stopPropagation();
        setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
        return;
      }
      const mermaidHit = (e.target as HTMLElement).closest(
        '.synapse-mermaid-expand, .synapse-mermaid:not(.synapse-mermaid-error) svg'
      );
      if (mermaidHit && root.contains(mermaidHit)) {
        const wrap = mermaidHit.closest('.synapse-mermaid');
        const svg = wrap?.querySelector('svg');
        if (svg) {
          e.preventDefault();
          e.stopPropagation();
          setMermaidLightbox(svg.outerHTML);
          return;
        }
      }
      const target = (e.target as HTMLElement).closest(
        'a.synapse-wikilink, a.synapse-mention'
      ) as HTMLAnchorElement | null;
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const byId = Number(target.dataset.noteId || 0);
      if (byId) {
        void openNote(byId);
        return;
      }
      const byTitle = target.dataset.noteTitle || '';
      const resolved = resolveNoteId(byTitle, noteIndex);
      if (resolved) void openNote(resolved);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [html, noteIndex, openNote]);

  useLayoutEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    root.innerHTML = html || '';
    applyPlannerButtons(root, plannerLinks);
    void renderMermaidInRoot(root);
  }, [html, plannerLinks]);

  if (error && !notes.length) {
    return (
      <main className="p-8">
        <p className="text-[var(--danger)]">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-[var(--accent-soft)]">
          Sign in →
        </Link>
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col overflow-hidden">
      <header className="relative z-40 shrink-0 border-b border-[var(--border)] bg-[var(--panel)]/95 backdrop-blur-md">
        {/* Mobile */}
        <div className="lg:hidden">
          <div className="flex h-12 items-center gap-1.5 px-2.5 pt-[env(safe-area-inset-top)]">
            <button
              type="button"
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                notesOpen
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
              aria-label="Notes"
              aria-pressed={notesOpen}
              onClick={() => {
                setNotesOpen((v) => !v);
                setContextOpen(false);
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M4 7h16M4 12h16M4 17h10"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <div className="min-w-0 flex-1 px-1">
              <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                {canOpenVault && vaultId != null ? (
                  <Link
                    href={activeId ? `/vaults/${vaultId}?note=${activeId}` : `/vaults/${vaultId}`}
                    className="text-[var(--accent-soft)] no-underline hover:underline"
                    title="Open this vault in Synapse"
                  >
                    PM Synapse
                  </Link>
                ) : (
                  'Public wiki'
                )}
              </p>
              <h1 className="truncate text-[15px] font-semibold tracking-tight">
                {vaultName || slug}
              </h1>
            </div>
            <button
              type="button"
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                contextOpen
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
              aria-label="Info"
              aria-pressed={contextOpen}
              onClick={() => {
                setContextOpen((v) => !v);
                setNotesOpen(false);
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
                <path
                  d="M12 11v5M12 8h.01"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <div className="pl-0.5">
              <AppUserMenu dense showSignInWhenGuest />
            </div>
          </div>
          <div className="flex items-center gap-1 border-t border-[var(--border)] bg-[var(--surface)]/40 px-2 py-1.5">
            <button
              type="button"
              className="inline-flex h-9 flex-1 items-center justify-center rounded-lg text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              onClick={() => setQuickOpen(true)}
            >
              Jump
            </button>
            <Link
              href={`/w/${slug}/map`}
              className="inline-flex h-9 flex-1 items-center justify-center rounded-lg text-xs font-medium text-[var(--muted)] no-underline transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            >
              Mindmap
            </Link>
            <Link
              href="/w"
              className="inline-flex h-9 flex-1 items-center justify-center rounded-lg text-xs font-medium text-[var(--muted)] no-underline transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            >
              All wikis
            </Link>
          </div>
        </div>

        {/* Desktop */}
        <div className="hidden items-center gap-3 px-4 py-2.5 lg:flex">
          <div className="min-w-0">
            {canOpenVault && vaultId != null ? (
              <Link
                href={activeId ? `/vaults/${vaultId}?note=${activeId}` : `/vaults/${vaultId}`}
                className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-soft)] no-underline hover:underline"
                title="Open this vault in Synapse"
              >
                PM Synapse
              </Link>
            ) : (
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Public wiki
              </span>
            )}
            <h1 className="truncate text-sm font-semibold tracking-tight">{vaultName || slug}</h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Link
              href="/w"
              className="text-[var(--muted)] no-underline hover:text-[var(--accent-soft)] hover:underline"
            >
              All wikis
            </Link>
            <input
              className="input w-44 py-1.5"
              placeholder="Filter notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              title="Filters the note list by title or path"
            />
            <button
              type="button"
              className="btn-ghost py-1.5"
              onClick={() => setQuickOpen(true)}
              title="Search notes including body (Ctrl/Cmd+O)"
            >
              Jump…
            </button>
            <Link
              href={`/w/${slug}/map`}
              className="text-[var(--accent-soft)] no-underline hover:underline"
            >
              Mindmap
            </Link>
            <span>{notes.length} notes</span>
            <div className="border-l border-[var(--border)] pl-2">
              <AppUserMenu dense showSignInWhenGuest />
            </div>
          </div>
        </div>
      </header>

      <div
        className={`relative grid min-h-0 flex-1 ${
          isLgUp ? 'grid-cols-[260px_minmax(0,1fr)_300px]' : 'grid-cols-1'
        }`}
      >
        {!isLgUp && (notesOpen || contextOpen) && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/55 lg:hidden"
            aria-label="Close panel"
            onClick={() => {
              setNotesOpen(false);
              setContextOpen(false);
            }}
          />
        )}

        <aside
          className={`min-h-0 overflow-auto border-[var(--border)] bg-[var(--panel)] p-3 ${
            isLgUp
              ? 'border-r bg-[var(--panel)]/40'
              : `fixed inset-y-0 left-0 z-50 w-[min(100%,18rem)] border-r shadow-2xl transition-transform duration-200 ease-out ${
                  notesOpen ? 'translate-x-0' : '-translate-x-full'
                } pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`
          }`}
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-2 lg:block">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Notes · {filteredNotes.length}
              {q.trim() ? ` / ${notes.length}` : ''}
            </p>
            <button
              type="button"
              className="btn-ghost py-1 text-xs lg:hidden"
              onClick={() => setNotesOpen(false)}
            >
              Close
            </button>
          </div>
          <input
            className="input mb-3 w-full py-1.5 lg:hidden"
            placeholder="Filter notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <NotesFolderTree
            notes={filteredNotes}
            selectedId={activeId}
            onOpenNote={(id) => void openNote(id)}
            emptyLabel={q.trim() ? 'No matching notes' : 'No public notes'}
          />
        </aside>

        <section className="min-h-0 overflow-auto px-4 py-4 sm:px-5 sm:py-5 lg:px-8 lg:py-6">
          {error && (
            <p className="mb-3 text-sm text-[var(--danger)]">
              {error}{' '}
              {error.toLowerCase().includes('sign-in') && (
                <Link href="/" className="text-[var(--accent-soft)] underline">
                  Sign in
                </Link>
              )}
            </p>
          )}
          {title ? (
            <h2 className="mb-5 text-2xl font-semibold tracking-tight lg:text-3xl">
              {noteLeafName(title)}
              {title.includes('/') && (
                <span className="mt-1 block text-sm font-normal text-[var(--muted)]">{title}</span>
              )}
            </h2>
          ) : (
            <div className="space-y-3">
              <p className="text-[var(--muted)]">Select a public note</p>
              <button
                type="button"
                className="btn-ghost lg:hidden"
                onClick={() => setNotesOpen(true)}
              >
                Browse notes
              </button>
            </div>
          )}
          <div ref={articleRef} className="synapse-md-preview" />
        </section>

        <aside
          className={`flex min-h-0 flex-col overflow-hidden border-[var(--border)] bg-[var(--panel)] ${
            isLgUp
              ? 'border-l bg-[var(--panel)]/40'
              : `fixed inset-y-0 right-0 z-50 w-[min(100%,20rem)] border-l shadow-2xl transition-transform duration-200 ease-out ${
                  contextOpen ? 'translate-x-0' : 'translate-x-full'
                } pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`
          }`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 lg:hidden">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Info</p>
            <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setContextOpen(false)}>
              Close
            </button>
          </div>
          <div className="shrink-0 border-b border-[var(--border)] p-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Focused mindmap
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">Current note + links</p>
            <div className="mt-2">
              {graph ? (
                <NoteGraphMindmap
                  nodes={graph.nodes}
                  edges={graph.edges}
                  height={200}
                  focusId={activeId}
                  variant="focus"
                  reloadToken={`${graphToken}-${activeId ?? 'none'}`}
                  compactLegend
                  onNodeClick={(id) => void openNote(id)}
                />
              ) : (
                <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-xs text-[var(--muted)]">
                  Loading…
                </div>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4 text-sm">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                References
              </h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">Links from this note</p>
              <div className="mt-2 space-y-1">
                {references.length === 0 && <p className="text-[var(--muted)]">None</p>}
                {references.map((b) => (
                  <button
                    key={`ref-${b.Id}-${b.Kind}`}
                    type="button"
                    className="block w-full rounded-lg px-2 py-1.5 text-left text-[var(--accent-soft)] transition hover:bg-[var(--surface-2)]"
                    onClick={() => void openNote(b.Id)}
                  >
                    → {b.Title}{' '}
                    <span className="text-[11px] text-[var(--muted)]">({b.Kind})</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Backlinks
              </h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">Notes that link here</p>
              <div className="mt-2 space-y-1">
                {backlinks.length === 0 && <p className="text-[var(--muted)]">None</p>}
                {backlinks.map((b) => (
                  <button
                    key={`bl-${b.Id}-${b.Kind}`}
                    type="button"
                    className="block w-full rounded-lg px-2 py-1.5 text-left text-[var(--accent-soft)] transition hover:bg-[var(--surface-2)]"
                    onClick={() => void openNote(b.Id)}
                  >
                    ← {b.Title}{' '}
                    <span className="text-[11px] text-[var(--muted)]">({b.Kind})</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>

      <QuickSwitcher
        open={quickOpen}
        searchUrl={`/api/public/${slug}/search`}
        notes={noteIndex}
        onClose={() => setQuickOpen(false)}
        onOpenNote={(id) => void openNote(id)}
      />

      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
      <MermaidLightbox svgHtml={mermaidLightbox} onClose={() => setMermaidLightbox(null)} />
    </main>
  );
}
