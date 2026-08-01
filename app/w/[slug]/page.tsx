'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { resolveNoteId, type NoteIndexEntry } from '@/lib/renderMarkdown';
import NotesFolderTree from '@/components/NotesFolderTree';
import { noteLeafName } from '@/lib/notePaths';
import ImageLightbox from '@/components/ImageLightbox';

export default function PublicWikiPage() {
  const params = useParams();
  const slug = String(params.slug);
  const [notes, setNotes] = useState<Array<{ Id: number; Title: string; Path: string }>>([]);
  const [vaultName, setVaultName] = useState('');
  const [error, setError] = useState('');
  const [html, setHtml] = useState('');
  const [title, setTitle] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);

  const noteIndex: NoteIndexEntry[] = notes.map((n) => ({
    id: n.Id,
    title: n.Title,
    path: n.Path,
  }));

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
      const list = data.data.notes || [];
      setNotes(list);
      if (data.data.robots) {
        const meta = document.createElement('meta');
        meta.name = 'robots';
        meta.content = data.data.robots;
        document.head.appendChild(meta);
      }
      const fromQuery = Number(new URL(window.location.href).searchParams.get('n') || 0);
      if (fromQuery && list.some((n: { Id: number }) => n.Id === fromQuery)) {
        await openNote(fromQuery);
      } else if (fromQuery && !list.some((n: { Id: number }) => n.Id === fromQuery)) {
        // May be authenticated-only note — try open (shows sign-in hint on 401)
        await openNote(fromQuery);
      } else if (list[0]) {
        await openNote(list[0].Id);
      }
    })();
  }, [slug, openNote]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (img?.src && root.contains(img)) {
        e.preventDefault();
        e.stopPropagation();
        setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
        return;
      }
      const target = (e.target as HTMLElement).closest('a.synapse-wikilink') as HTMLAnchorElement | null;
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

  if (error && !notes.length) {
    return (
      <main className="p-8">
        <p className="text-[var(--danger)]">{error}</p>
        <a href="/api/auth/sso/start" className="mt-4 inline-block text-sm text-[var(--accent-soft)]">
          Sign in with Project Management →
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-5xl grid-cols-[240px_1fr] gap-8 px-6 py-10">
      <aside className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]/60 p-4 backdrop-blur">
        <Link href="/" className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] no-underline">
          PM Synapse
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{vaultName || slug}</h1>
        <div className="mt-4">
          <NotesFolderTree
            notes={notes}
            selectedId={activeId}
            onOpenNote={(id) => void openNote(id)}
            emptyLabel="No public notes"
          />
        </div>
        <Link href={`/w/${slug}/map`} className="mt-4 inline-block text-xs text-[var(--muted)]">
          Mindmap →
        </Link>
      </aside>
      <article className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]/40 p-8 backdrop-blur">
        {error && (
          <p className="mb-3 text-sm text-[var(--danger)]">
            {error}{' '}
            {error.toLowerCase().includes('sign-in') && (
              <a href="/api/auth/sso/start" className="text-[var(--accent-soft)] underline">
                Sign in
              </a>
            )}
          </p>
        )}
        {title ? (
          <h2 className="mb-5 text-2xl font-semibold tracking-tight">
            {noteLeafName(title)}
            {title.includes('/') && (
              <span className="mt-1 block text-sm font-normal text-[var(--muted)]">{title}</span>
            )}
          </h2>
        ) : (
          <p className="text-[var(--muted)]">Select a public note</p>
        )}
        <div
          ref={articleRef}
          className="synapse-md-preview"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>

      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </main>
  );
}
