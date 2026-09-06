'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import WhiteboardPeekCanvas from '@/components/WhiteboardPeekCanvas';
import ImageLightbox from '@/components/ImageLightbox';
import MermaidLightbox from '@/components/MermaidLightbox';
import BoardEmbedPortals from '@/components/BoardEmbedPortals';
import { handleMarkdownCodeCopyClick } from '@/lib/codeCopy';
import { renderMermaidInRoot } from '@/lib/mermaidRender';
import { useBoardEmbedPreview } from '@/lib/useBoardEmbedPreview';
import { noteLeafName } from '@/lib/notePaths';

type ShareKind = 'note' | 'whiteboard';

export default function SharedNotePage() {
  const params = useParams();
  const token = String(params.token || '');
  const articleRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<'loading' | 'password' | 'content' | 'error'>('loading');
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ShareKind>('note');
  const [noteId, setNoteId] = useState(0);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [html, setHtml] = useState('');
  const [boardJson, setBoardJson] = useState<string | null>(null);
  const [embeddedBoards, setEmbeddedBoards] = useState<Record<string, string | null>>({});
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [mermaidLightbox, setMermaidLightbox] = useState<string | null>(null);

  const loadContent = useCallback(async () => {
    const res = await fetch(`/api/shares/${encodeURIComponent(token)}/content`, {
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || data.code === 'locked') {
      setPhase('password');
      setError('');
      return;
    }
    if (!res.ok) {
      setPhase('error');
      setError(data.message || 'Share not found');
      return;
    }
    const d = data.data || {};
    setTitle(String(d.title || 'Note'));
    setKind(String(d.kind) === 'whiteboard' ? 'whiteboard' : 'note');
    setNoteId(Number(d.noteId) || 0);
    setExpiresAt(d.expiresAt ? String(d.expiresAt) : null);
    setHtml(String(d.html || ''));
    setBoardJson(d.boardJson != null ? String(d.boardJson) : null);
    const boards =
      d.embeddedBoards && typeof d.embeddedBoards === 'object'
        ? (d.embeddedBoards as Record<string, string | null>)
        : {};
    setEmbeddedBoards(boards);
    setPhase('content');
    setError('');
  }, [token]);

  useEffect(() => {
    if (!token) {
      setPhase('error');
      setError('Share not found');
      return;
    }
    void (async () => {
      const metaRes = await fetch(`/api/shares/${encodeURIComponent(token)}`, {
        credentials: 'include',
      });
      const meta = await metaRes.json().catch(() => ({}));
      if (!metaRes.ok) {
        setPhase('error');
        setError(meta.message || 'Share not found');
        return;
      }
      setTitle(String(meta.data?.title || 'Note'));
      setKind(String(meta.data?.kind) === 'whiteboard' ? 'whiteboard' : 'note');
      setExpiresAt(meta.data?.expiresAt ? String(meta.data.expiresAt) : null);
      if (meta.data?.unlocked) {
        await loadContent();
      } else {
        setPhase('password');
      }
    })();
  }, [token, loadContent]);

  const afterShareWrite = useCallback((root: HTMLElement) => {
    void renderMermaidInRoot(root);
  }, []);

  const embedMounts = useBoardEmbedPreview(articleRef, {
    html,
    enabled: phase === 'content' && kind !== 'whiteboard',
    afterWrite: afterShareWrite,
  });

  useEffect(() => {
    const root = articleRef.current;
    if (!root || phase !== 'content' || kind === 'whiteboard') return;
    const onClick = (e: MouseEvent) => {
      if (handleMarkdownCodeCopyClick(e, root)) return;
      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (img?.src && root.contains(img)) {
        e.preventDefault();
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
          setMermaidLightbox(svg.outerHTML);
        }
      }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [html, phase, kind]);

  const onUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim() || unlockBusy) return;
    setUnlockBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/shares/${encodeURIComponent(token)}/unlock`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || 'Incorrect password');
        return;
      }
      setPassword('');
      await loadContent();
    } catch {
      setError('Network error');
    } finally {
      setUnlockBusy(false);
    }
  };

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <header className="shrink-0 border-b border-[var(--border)] bg-[var(--panel)]/95 px-4 py-2.5 backdrop-blur-md sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/"
              className="shrink-0 text-sm font-semibold tracking-tight text-[var(--text)] no-underline"
            >
              Synapse
            </Link>
            {phase === 'content' && title ? (
              <h1 className="truncate text-sm font-medium text-[var(--muted)]">
                {noteLeafName(title)}
              </h1>
            ) : null}
          </div>
          {expiresAt ? (
            <p className="shrink-0 truncate text-[11px] text-[var(--muted)]">
              Expires {new Date(expiresAt).toLocaleString()}
            </p>
          ) : null}
        </div>
      </header>

      {phase === 'loading' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6">
            <h1 className="text-lg font-semibold">Share unavailable</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">{error}</p>
            <Link href="/" className="mt-4 inline-block text-sm text-[var(--accent-soft)]">
              Back to Synapse
            </Link>
          </div>
        </div>
      )}

      {phase === 'password' && (
        <div className="flex flex-1 items-center justify-center p-6">
          <form
            onSubmit={(e) => void onUnlock(e)}
            className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-lg"
          >
            <h1 className="text-lg font-semibold tracking-tight">
              {noteLeafName(title) || 'Shared note'}
            </h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Enter the password to view this {kind === 'whiteboard' ? 'whiteboard' : 'note'}.
            </p>
            <label className="mt-4 block text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Password
              <input
                type="password"
                className="input mt-1.5 w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
                required
              />
            </label>
            {error ? <p className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
            <button
              type="submit"
              className="btn-primary mt-4 w-full"
              disabled={unlockBusy || !password.trim()}
            >
              {unlockBusy ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>
        </div>
      )}

      {phase === 'content' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {kind === 'whiteboard' ? (
            <WhiteboardPeekCanvas
              noteId={noteId || 1}
              boardJson={boardJson}
              className="synapse-whiteboard synapse-whiteboard-viewer synapse-whiteboard-fill w-full overflow-hidden"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-8 lg:px-12">
              <div ref={articleRef} className="synapse-md-preview w-full" />
              <BoardEmbedPortals mounts={embedMounts} boardMap={embeddedBoards} />
            </div>
          )}
        </div>
      )}

      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
      {mermaidLightbox ? (
        <MermaidLightbox svgHtml={mermaidLightbox} onClose={() => setMermaidLightbox(null)} />
      ) : null}
    </main>
  );
}
