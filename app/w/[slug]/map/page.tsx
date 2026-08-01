'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import NoteGraphMindmap from '@/components/NoteGraphMindmap';

export default function PublicGraphPage() {
  const params = useParams();
  const router = useRouter();
  const slug = String(params.slug);
  const [graph, setGraph] = useState<{
    nodes: Array<{ Id: number; Title: string }>;
    edges: Array<{ FromNoteId: number; ToNoteId: number; Kind: string }>;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/public/${slug}/graph`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Graph unavailable');
        return;
      }
      setGraph(data.data);
    })();
  }, [slug]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href={`/w/${slug}`} className="text-sm text-[var(--muted)] no-underline hover:text-[var(--text)]">
        ← Wiki
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Mindmap</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Public notes linked by wikilinks and mentions · /{slug}
      </p>
      {error && <p className="mt-4 text-[var(--danger)]">{error}</p>}
      {!graph && !error && <p className="mt-6 text-[var(--muted)]">Loading mindmap…</p>}
      {graph && (
        <div className="mt-6">
          <NoteGraphMindmap
            nodes={graph.nodes}
            edges={graph.edges}
            height={560}
            onNodeClick={(id) => router.push(`/w/${slug}?n=${id}`)}
          />
          <p className="mt-3 text-xs text-[var(--muted)]">
            {graph.nodes.length} notes · {graph.edges.length} connections
          </p>
        </div>
      )}
    </main>
  );
}
