'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import NoteGraphMindmap from '@/components/NoteGraphMindmap';
import AppUserMenu from '@/components/AppUserMenu';

export default function PublicGraphPage() {
  const params = useParams();
  const router = useRouter();
  const slug = String(params.slug);
  const boxRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(520);
  const [graph, setGraph] = useState<{
    nodes: Array<{ Id: number; Title: string }>;
    edges: Array<{ FromNoteId: number; ToNoteId: number; Kind: string }>;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/public/${slug}/graph`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Graph unavailable');
        return;
      }
      setGraph(data.data);
    })();
  }, [slug]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setHeight(Math.max(360, el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [graph, error]);

  return (
    <main className="flex h-dvh flex-col overflow-hidden">
      <header className="relative z-40 shrink-0 border-b border-[var(--border)] bg-[var(--panel)]/95 backdrop-blur-md">
        <div className="flex h-12 items-center gap-2 px-3 pt-[env(safe-area-inset-top)] lg:h-auto lg:px-4 lg:py-2.5 lg:pt-[max(0.625rem,env(safe-area-inset-top))]">
          <div className="min-w-0 flex-1">
            <Link
              href={`/w/${slug}`}
              className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-soft)] no-underline hover:underline"
            >
              ← Wiki
            </Link>
            <h1 className="truncate text-[15px] font-semibold tracking-tight lg:text-sm">Mindmap</h1>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">
            <Link
              href="/w"
              className="hidden text-[var(--muted)] no-underline hover:text-[var(--accent-soft)] hover:underline sm:inline"
            >
              All wikis
            </Link>
            {graph && (
              <span className="hidden sm:inline">
                {graph.nodes.length} notes · {graph.edges.length} connections
              </span>
            )}
            <AppUserMenu dense showSignInWhenGuest />
          </div>
        </div>
      </header>

      <div ref={boxRef} className="min-h-0 flex-1 p-3">
        {error && <p className="p-4 text-sm text-[var(--danger)]">{error}</p>}
        {!graph && !error && (
          <p className="p-4 text-sm text-[var(--muted)]">Loading mindmap…</p>
        )}
        {graph && (
          <NoteGraphMindmap
            nodes={graph.nodes}
            edges={graph.edges}
            height={height - 24}
            variant="full"
            onNodeClick={(id) => router.push(`/w/${slug}?n=${id}`)}
          />
        )}
      </div>
    </main>
  );
}
