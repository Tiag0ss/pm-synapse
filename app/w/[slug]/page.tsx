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
  const [authenticated, setAuthenticated] = useState(false);
  const [authUser, setAuthUser] = useState<{ username: string; email: string } | null>(null);
  const [error, setError] = useState('');
  const [html, setHtml] = useState('');
  const [title, setTitle] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [backlinks, setBacklinks] = useState<WikiLinkRow[]>([]);
  const [references, setReferences] = useState<WikiLinkRow[]>([]);
  const [graph, setGraph] = useState<{
    nodes: Array<{ Id: number; Title: string }>;
    edges: Array<{ FromNoteId: number; ToNoteId: number; Kind: string }>;
  } | null>(null);
  const [graphToken, setGraphToken] = useState(0);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
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
      setAuthenticated(Boolean(data.data.authenticated));
      setAuthUser(
        data.data.user
          ? { username: String(data.data.user.username || ''), email: String(data.data.user.email || '') }
          : null
      );
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
      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (img?.src && root.contains(img)) {
        e.preventDefault();
        e.stopPropagation();
        setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
        return;
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
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)]/95 px-4 py-2.5 backdrop-blur-md">
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
          <Link href="/w" className="text-[var(--muted)] no-underline hover:text-[var(--accent-soft)] hover:underline">
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
          <Link href={`/w/${slug}/map`} className="text-[var(--accent-soft)] no-underline hover:underline">
            Full mindmap
          </Link>
          <span>{notes.length} notes</span>
          {authenticated && authUser ? (
            <div className="flex items-center gap-2 border-l border-[var(--border)] pl-2">
              <span className="max-w-[10rem] truncate text-[var(--text)]" title={authUser.email}>
                {authUser.username || authUser.email}
              </span>
              <button
                type="button"
                className="btn-ghost py-1.5"
                onClick={async () => {
                  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
                  window.location.reload();
                }}
              >
                Log out
              </button>
            </div>
          ) : (
            <Link
              href="/"
              className="btn-ghost py-1.5 no-underline hover:no-underline border-l border-[var(--border)] pl-2"
              title="Sign in to see authenticated notes and Planner links"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)_300px]">
        <aside className="min-h-0 overflow-auto border-r border-[var(--border)] bg-[var(--panel)]/40 p-3">
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
            Notes · {filteredNotes.length}
            {q.trim() ? ` / ${notes.length}` : ''}
          </p>
          <NotesFolderTree
            notes={filteredNotes}
            selectedId={activeId}
            onOpenNote={(id) => void openNote(id)}
            emptyLabel={q.trim() ? 'No matching notes' : 'No public notes'}
          />
        </aside>

        <section className="min-h-0 overflow-auto px-5 py-5 lg:px-8 lg:py-6">
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
            <p className="text-[var(--muted)]">Select a public note</p>
          )}
          <div ref={articleRef} className="synapse-md-preview" />
        </section>

        <aside className="flex min-h-0 flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--panel)]/40">
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
    </main>
  );
}
