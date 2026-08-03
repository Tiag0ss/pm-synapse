'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AppUserMenu from '@/components/AppUserMenu';
import ConfirmModal from '@/components/ConfirmModal';
import { applyNoteTemplateBody } from '@/lib/noteTemplates';
import { renderSynapseMarkdown } from '@/lib/renderMarkdown';

type TemplateKind = 'system' | 'global' | 'user';
type ShareStatus = 'private' | 'pending' | 'published';

type Template = {
  id: number;
  slug: string | null;
  label: string;
  description: string | null;
  bodyMarkdown: string;
  kind: TemplateKind;
  shareStatus: ShareStatus;
  ownerUserId: number | null;
  ownerUsername?: string | null;
};

type Me = { userId: number; username: string; email: string; isAdmin: boolean };

export default function TemplatesPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showMineOnly, setShowMineOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const meRes = await fetch('/api/auth/me', { credentials: 'include' });
      if (!meRes.ok) {
        window.location.href = '/';
        return;
      }
      const meJson = await meRes.json();
      setMe(meJson.data);

      const q = showMineOnly ? '?mine=1' : '';
      const res = await fetch(`/api/templates${q}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Failed to load templates');
        return;
      }
      const list = (json.data || []) as Template[];
      setTemplates(list);
      setSelectedId((prev) => {
        if (prev && list.some((t) => t.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch {
      setError('Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [showMineOnly]);

  useEffect(() => {
    void load();
  }, [load]);

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
  const isOwner = Boolean(
    selected && me && selected.kind === 'user' && selected.ownerUserId === me.userId
  );
  const canEdit =
    Boolean(selected) &&
    (isOwner || (me?.isAdmin && (selected!.kind === 'global' || selected!.kind === 'system')));
  const canDelete =
    Boolean(selected) &&
    selected!.kind !== 'system' &&
    (isOwner || (me?.isAdmin && selected!.kind === 'global'));

  const startEdit = () => {
    if (!selected) return;
    setDraftLabel(selected.label);
    setDraftDescription(selected.description || '');
    setDraftBody(selected.bodyMarkdown);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    if (!selected) return;
    setBusy(true);
    setStatus('');
    try {
      const res = await fetch(`/api/templates/${selected.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: draftLabel,
          description: draftDescription,
          bodyMarkdown: draftBody,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Save failed');
        return;
      }
      setEditing(false);
      setStatus('Template saved');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const createMine = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'My template',
          description: 'Personal note template',
          bodyMarkdown: '# {{title}}\n\n',
          kind: 'user',
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Create failed');
        return;
      }
      setShowMineOnly(true);
      setStatus('Created personal template');
      await load();
      setSelectedId(Number(json.data.id));
      setDraftLabel(json.data.label);
      setDraftDescription(json.data.description || '');
      setDraftBody(json.data.bodyMarkdown);
      setEditing(true);
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${selected.id}/share`, {
        method: 'POST',
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Share request failed');
        return;
      }
      setStatus('Share requested — waiting for admin approval');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${selected.id}/withdraw`, {
        method: 'POST',
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Withdraw failed');
        return;
      }
      setStatus('Template is private again');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (deleteId == null) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/templates/${deleteId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Delete failed');
        return;
      }
      setDeleteId(null);
      setEditing(false);
      setStatus('Template deleted');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const previewHtml = useMemo(() => {
    const body = editing ? draftBody : selected?.bodyMarkdown || '';
    if (!body) return '<p class="text-[var(--muted)]">No preview</p>';
    return renderSynapseMarkdown(applyNoteTemplateBody(body, 'Note title'), []);
  }, [editing, draftBody, selected]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-soft)]">
            Synapse
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Note templates</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Built-in and shared templates for everyone. Create your own and request admin approval to
            share.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/" className="btn-ghost no-underline hover:no-underline">
            ← Vaults
          </Link>
          <AppUserMenu user={me} dense />
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {status && (
        <p className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
          {status}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className="input max-w-xs"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={showMineOnly}
            onChange={(e) => setShowMineOnly(e.target.checked)}
          />
          Mine only
        </label>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void createMine()}>
          New personal template
        </button>
      </div>

      <div className="grid min-h-[28rem] grid-cols-1 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 md:grid-cols-[minmax(0,16rem)_1fr]">
        <aside className="border-b border-[var(--border)] md:border-b-0 md:border-r">
          <div className="max-h-[70vh] overflow-y-auto p-2">
            {loading ? (
              <p className="px-2 py-3 text-xs text-[var(--muted)]">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-xs text-[var(--muted)]">No templates</p>
            ) : (
              <ul className="space-y-1">
                {filtered.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={`w-full rounded-lg border px-2.5 py-2 text-left ${
                        t.id === selectedId
                          ? 'border-[var(--accent)] bg-[var(--surface-2)]'
                          : 'border-transparent hover:bg-[var(--surface)]/70'
                      }`}
                      onClick={() => {
                        setSelectedId(t.id);
                        setEditing(false);
                      }}
                    >
                      <span className="block truncate text-sm font-medium text-[var(--text)]">
                        {t.label}
                      </span>
                      <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-[var(--muted)]">
                        {t.kind}
                        {t.kind === 'user' ? ` · ${t.shareStatus}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className="flex min-h-0 flex-col">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
                <h2 className="mr-auto text-base font-semibold text-[var(--text)]">{selected.label}</h2>
                {canEdit && !editing && (
                  <button type="button" className="btn-ghost py-1 text-xs" onClick={startEdit}>
                    Edit
                  </button>
                )}
                {editing && (
                  <>
                    <button
                      type="button"
                      className="btn-primary py-1 text-xs"
                      disabled={busy}
                      onClick={() => void saveEdit()}
                    >
                      Save
                    </button>
                    <button type="button" className="btn-ghost py-1 text-xs" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </>
                )}
                {isOwner && selected.shareStatus === 'private' && (
                  <button
                    type="button"
                    className="btn-ghost py-1 text-xs"
                    disabled={busy}
                    onClick={() => void share()}
                  >
                    Request share
                  </button>
                )}
                {isOwner &&
                  (selected.shareStatus === 'pending' || selected.shareStatus === 'published') && (
                    <button
                      type="button"
                      className="btn-ghost py-1 text-xs"
                      disabled={busy}
                      onClick={() => void withdraw()}
                    >
                      Make private
                    </button>
                  )}
                {canDelete && (
                  <button
                    type="button"
                    className="btn-ghost py-1 text-xs text-red-300"
                    onClick={() => setDeleteId(selected.id)}
                  >
                    Delete
                  </button>
                )}
              </div>

              {editing ? (
                <div className="space-y-3 overflow-y-auto p-4">
                  <label className="block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Label
                    <input
                      className="input mt-1 w-full"
                      value={draftLabel}
                      onChange={(e) => setDraftLabel(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Description
                    <input
                      className="input mt-1 w-full"
                      value={draftDescription}
                      onChange={(e) => setDraftDescription(e.target.value)}
                    />
                  </label>
                  <label className="block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Body (use {'{{title}}'} for the note title)
                    <textarea
                      className="input mt-1 min-h-[16rem] w-full font-mono text-sm"
                      value={draftBody}
                      onChange={(e) => setDraftBody(e.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <div
                  className="synapse-md-preview min-h-[20rem] flex-1 overflow-auto p-4"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}
            </>
          ) : (
            <p className="p-6 text-sm text-[var(--muted)]">Select a template</p>
          )}
        </div>
      </div>

      <ConfirmModal
        open={deleteId != null}
        title="Delete template?"
        message="This cannot be undone."
        confirmLabel="Delete"
        onCancel={() => setDeleteId(null)}
        onConfirm={() => void confirmDelete()}
      />
    </main>
  );
}
