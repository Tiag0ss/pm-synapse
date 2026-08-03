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
    <main className="flex h-screen flex-col overflow-hidden">
      <header className="relative z-40 flex shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)]/95 px-4 py-2.5 backdrop-blur-md">
        <div className="min-w-0">
          <Link
            href={`/w/${slug}`}
            className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-soft)] no-underline hover:underline"
          >
            ← Wiki
          </Link>
          <h1 className="truncate text-sm font-semibold tracking-tight">Mindmap</h1>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
          <Link href="/w" className="text-[var(--muted)] no-underline hover:text-[var(--accent-soft)] hover:underline">
            All wikis
          </Link>
          {graph && (
            <span>
              {graph.nodes.length} notes · {graph.edges.length} connections
            </span>
          )}
          <div className="border-l border-[var(--border)] pl-2">
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
