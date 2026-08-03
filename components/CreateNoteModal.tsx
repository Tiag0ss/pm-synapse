'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { applyNoteTemplateBody } from '@/lib/noteTemplates';
import { renderSynapseMarkdown } from '@/lib/renderMarkdown';

export type CatalogTemplate = {
  id: number;
  slug: string | null;
  label: string;
  description: string | null;
  bodyMarkdown: string;
  kind: 'system' | 'global' | 'user';
  shareStatus: 'private' | 'pending' | 'published';
  ownerUserId: number | null;
};

export type SelectedTemplate = {
  id: number;
  bodyMarkdown: string;
};

interface CreateNoteModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (title: string, template: SelectedTemplate) => void;
}

function badgeFor(t: CatalogTemplate): { text: string; className: string } {
  if (t.kind === 'system') {
    return { text: 'System', className: 'border-[var(--border)] text-[var(--muted)]' };
  }
  if (t.kind === 'global') {
    return { text: 'Global', className: 'border-[var(--accent)]/40 text-[var(--accent-soft)]' };
  }
  if (t.shareStatus === 'published') {
    return { text: 'Shared', className: 'border-emerald-500/40 text-emerald-300/90' };
  }
  if (t.shareStatus === 'pending') {
    return { text: 'Pending', className: 'border-amber-500/40 text-amber-300/90' };
  }
  return { text: 'Mine', className: 'border-[var(--border-strong)] text-[var(--text)]' };
}

export default function CreateNoteModal({ open, onCancel, onConfirm }: CreateNoteModalProps) {
  const [title, setTitle] = useState('');
  const [filter, setFilter] = useState('');
  const [templates, setTemplates] = useState<CatalogTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setFilter('');
    setError('');
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch('/api/templates', { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) {
          setError(data.message || 'Failed to load templates');
          setTemplates([]);
          setSelectedId(null);
          return;
        }
        const list = (data.data || []) as CatalogTemplate[];
        setTemplates(list);
        const blank = list.find((t) => t.slug === 'blank') || list[0];
        setSelectedId(blank ? blank.id : null);
      } catch {
        setError('Failed to load templates');
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.slug || '').toLowerCase().includes(q)
    );
  }, [templates, filter]);

  const selected = templates.find((t) => t.id === selectedId) || null;

  const previewHtml = useMemo(() => {
    if (!selected) return '<p class="text-[var(--muted)]">Select a template</p>';
    const leaf = title.trim() || 'Note title';
    const md = applyNoteTemplateBody(selected.bodyMarkdown, leaf);
    return renderSynapseMarkdown(md, []);
  }, [selected, title]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="New note"
        className="flex max-h-[min(90vh,720px)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/40"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || !selected) return;
          onConfirm(title.trim(), { id: selected.id, bodyMarkdown: selected.bodyMarkdown });
        }}
      >
        <div className="border-b border-[var(--border)] px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">New note</h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                Pick a template, then set the title. Nested paths like{' '}
                <code className="text-[var(--accent-soft)]">meta/risks</code> are supported.
              </p>
            </div>
          <Link
            href="/templates"
            className="text-[11px] text-[var(--muted)] no-underline hover:text-[var(--accent-soft)] hover:underline"
            onClick={onCancel}
          >
            Manage templates
          </Link>
          </div>
          <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Title
            <input
              autoFocus
              className="input mt-1.5 w-full"
              placeholder="meta/risks or Meeting notes"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,14rem)_1fr]">
          <aside className="flex min-h-0 flex-col border-b border-[var(--border)] md:border-b-0 md:border-r">
            <div className="border-b border-[var(--border)] p-3">
              <input
                className="input w-full text-sm"
                placeholder="Filter templates…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Filter templates"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {loading ? (
                <p className="px-2 py-3 text-xs text-[var(--muted)]">Loading…</p>
              ) : error ? (
                <p className="px-2 py-3 text-xs text-red-300">{error}</p>
              ) : filtered.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[var(--muted)]">No matching templates</p>
              ) : (
                <ul className="space-y-1">
                  {filtered.map((t) => {
                    const badge = badgeFor(t);
                    const active = t.id === selectedId;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          className={`w-full rounded-lg border px-2.5 py-2 text-left transition ${
                            active
                              ? 'border-[var(--accent)] bg-[var(--surface-2)]'
                              : 'border-transparent hover:bg-[var(--surface)]/70'
                          }`}
                          onClick={() => setSelectedId(t.id)}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-[var(--text)]">
                              {t.label}
                            </span>
                            <span
                              className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${badge.className}`}
                            >
                              {badge.text}
                            </span>
                          </span>
                          {t.description ? (
                            <span className="mt-0.5 line-clamp-2 block text-[11px] text-[var(--muted)]">
                              {t.description}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          <div className="flex min-h-0 flex-col">
            <div className="border-b border-[var(--border)] px-4 py-2 text-[11px] uppercase tracking-wide text-[var(--muted)]">
              Preview{selected ? ` · ${selected.label}` : ''}
            </div>
            <div
              className="synapse-md-preview min-h-[220px] flex-1 overflow-auto p-4 text-[14px] leading-6"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!title.trim() || !selected}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
