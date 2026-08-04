'use client';

import { useEffect, useState } from 'react';
import { resolveNoteId, type NoteResolveEntry } from '@/lib/notePaths';
import { renderInlineMarkdown } from '@/lib/renderMarkdown';

export interface VaultCheckboxItem {
  noteId: number;
  noteTitle: string;
  index: number;
  text: string;
  checked: boolean;
  markerId: string | null;
  indent?: number;
  source?: 'checkbox' | 'frontmatter';
  linkedNote?: string | null;
  pmTaskId: number | null;
  openUrl: string | null;
}

interface BulkProgress {
  phase: 'prepare' | 'create';
  done: number;
  total: number;
  created: number;
  failed: number;
  skipped: number;
  label?: string;
}

interface VaultPmSettingsModalProps {
  open: boolean;
  vaultId: string;
  vaultName: string;
  pmProjectId?: number | null;
  pmOrganizationId?: number | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenNote?: (noteId: number) => void;
  notes?: NoteResolveEntry[];
  /** Render as a panel inside Vault options (no overlay chrome). */
  embedded?: boolean;
}

export default function VaultPmSettingsModal({
  open,
  vaultId,
  vaultName,
  pmProjectId,
  pmOrganizationId,
  onClose,
  onChanged,
  onOpenNote,
  notes = [],
  embedded = false,
}: VaultPmSettingsModalProps) {
  const [orgs, setOrgs] = useState<Array<{ Id: number; Name: string }>>([]);
  const [orgId, setOrgId] = useState(pmOrganizationId ? String(pmOrganizationId) : '');
  const [linkProjectId, setLinkProjectId] = useState('');
  const [linkedProjectId, setLinkedProjectId] = useState<number | null>(pmProjectId ?? null);
  const [items, setItems] = useState<VaultCheckboxItem[]>([]);
  const [status, setStatus] = useState('');
  const [orgError, setOrgError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingOrgs, setLoadingOrgs] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unlinked' | 'open'>('unlinked');
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);

  const load = async () => {
    setLoadingOrgs(true);
    setOrgError('');
    try {
      const [orgRes, cbRes] = await Promise.all([
        fetch('/api/vaults/pm/organizations', { credentials: 'include' }),
        fetch(`/api/vaults/${vaultId}/checkboxes`, { credentials: 'include' }),
      ]);
      const orgJson = await orgRes.json();
      if (orgRes.ok) {
        const list = Array.isArray(orgJson.data) ? orgJson.data : [];
        setOrgs(
          list.map((o: { Id?: number; id?: number; Name?: string; name?: string }) => ({
            Id: Number(o.Id ?? o.id),
            Name: String(o.Name ?? o.name ?? o.Id),
          }))
        );
        if (list.length === 0) {
          setOrgError('No organizations returned for your PM account.');
        }
      } else {
        setOrgs([]);
        const msg =
          orgJson.message ||
          'Failed to load organizations — sign in with Project Management or ask an admin to set an API key in Settings';
        setOrgError(msg);
        setStatus(msg);
      }
      const cbJson = await cbRes.json();
      if (cbRes.ok) setItems(cbJson.data?.items || []);
    } catch {
      setOrgError('Network error while loading organizations');
    } finally {
      setLoadingOrgs(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setOrgId(pmOrganizationId ? String(pmOrganizationId) : '');
    setLinkedProjectId(pmProjectId ?? null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaultId, pmOrganizationId, pmProjectId]);

  if (!open) return null;

  const visible = items.filter((i) => {
    if (filter === 'unlinked') return !i.pmTaskId;
    if (filter === 'open') return !i.checked;
    return true;
  });

  const createProject = async () => {
    if (!orgId) {
      setStatus('Pick an organization first');
      return;
    }
    setBusy(true);
    setStatus('Creating project…');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/push-project`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: Number(orgId), projectName: vaultName }),
      });
      const data = await res.json();
      if (res.ok) {
        const id = Number(data.data.pmProjectId);
        setLinkedProjectId(id);
        setStatus(`Linked PM project #${id}`);
        onChanged();
        await load();
      } else if (res.status === 409 && data.data?.pmProjectId) {
        setLinkedProjectId(Number(data.data.pmProjectId));
        setStatus('Already linked');
        if (data.data.openUrl) window.open(data.data.openUrl, '_blank');
        onChanged();
      } else {
        setStatus(data.message || 'Failed to create project');
      }
    } finally {
      setBusy(false);
    }
  };

  const linkProject = async () => {
    if (!orgId || !linkProjectId) {
      setStatus('Organization and project id required');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/link-project`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: Number(orgId), projectId: Number(linkProjectId) }),
      });
      const data = await res.json();
      if (res.ok) {
        const id = Number(data.data.pmProjectId);
        setLinkedProjectId(id);
        setStatus(`Linked project #${id}`);
        onChanged();
        await load();
      } else {
        setStatus(data.message || 'Link failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/unlink-pm`, {
        method: 'POST',
        credentials: 'include',
      });
      setStatus(res.ok ? 'Project unlinked from vault' : 'Unlink failed');
      if (res.ok) {
        setLinkedProjectId(null);
        onChanged();
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const pushCheckbox = async (item: VaultCheckboxItem) => {
    if (!linkedProjectId) {
      setStatus('Link a PM project first');
      return;
    }
    setBusy(true);
    setStatus('Creating task…');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${item.noteId}/checkboxes/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: item.index }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus(`Created PM task #${data.data.pmTaskId}`);
        if (data.data.openUrl) window.open(data.data.openUrl, '_blank');
        onChanged();
        await load();
      } else {
        setStatus(data.message || 'Could not create task');
      }
    } finally {
      setBusy(false);
    }
  };

  const pushAllMissing = async () => {
    if (!linkedProjectId) {
      setStatus('Link a PM project first');
      return;
    }
    const missing = items.filter((i) => !i.pmTaskId).length;
    if (!missing) {
      setStatus('No missing tasks — all checkboxes are already linked');
      return;
    }
    setBusy(true);
    setBulkProgress({
      phase: 'prepare',
      done: 0,
      total: 0,
      created: 0,
      failed: 0,
      skipped: 0,
      label: `Preparing to create up to ${missing} task${missing === 1 ? '' : 's'}…`,
    });
    setStatus(`Creating missing tasks…`);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/checkboxes/push-missing?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/x-ndjson' },
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setStatus((data as { message?: string }).message || 'Bulk create failed');
        setBulkProgress(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalMessage = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: {
            type?: string;
            phase?: 'prepare' | 'create';
            done?: number;
            total?: number;
            created?: number;
            failed?: number;
            skipped?: number;
            label?: string;
            message?: string;
            success?: boolean;
            data?: {
              created?: number;
              skipped?: number;
              failed?: number;
              errors?: unknown[];
            };
          };
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (event.type === 'progress') {
            setBulkProgress({
              phase: event.phase === 'create' ? 'create' : 'prepare',
              done: Number(event.done || 0),
              total: Number(event.total || 0),
              created: Number(event.created || 0),
              failed: Number(event.failed || 0),
              skipped: Number(event.skipped || 0),
              label: event.label,
            });
          } else if (event.type === 'done') {
            const d = event.data || {};
            finalMessage =
              `Created ${d.created || 0}, skipped ${d.skipped || 0}, failed ${d.failed || 0}` +
              (d.errors?.length ? ` · ${d.errors.length} error(s)` : '');
            setStatus(finalMessage);
          } else if (event.type === 'error') {
            finalMessage = event.message || 'Bulk create failed';
            setStatus(finalMessage);
          }
        }
      }

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as {
            type?: string;
            message?: string;
            data?: { created?: number; skipped?: number; failed?: number; errors?: unknown[] };
          };
          if (event.type === 'done') {
            const d = event.data || {};
            setStatus(
              `Created ${d.created || 0}, skipped ${d.skipped || 0}, failed ${d.failed || 0}` +
                (d.errors?.length ? ` · ${d.errors.length} error(s)` : '')
            );
          } else if (event.type === 'error') {
            setStatus(event.message || 'Bulk create failed');
          }
        } catch {
          /* ignore trailing garbage */
        }
      }

      onChanged();
      await load();
    } catch {
      setStatus('Network error during bulk create');
    } finally {
      setBusy(false);
      setBulkProgress(null);
    }
  };

  const missingCount = items.filter((i) => !i.pmTaskId).length;

  const inner = (
    <>
        {!embedded && (
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Vault · Project Management</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Link one PM project to this vault, then create tasks from note checkboxes.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        )}

        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-5">
          {embedded && (
            <p className="text-sm text-[var(--muted)]">
              Link one PM project to this vault, then create tasks from note checkboxes.
            </p>
          )}
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/50 p-4">
            <h3 className="text-sm font-semibold">PM project</h3>
            {linkedProjectId ? (
              <p className="mt-2 text-sm text-[var(--muted)]">
                Linked to project{' '}
                <a
                  className="text-[var(--accent-soft)]"
                  href={`${process.env.NEXT_PUBLIC_PM_BASE_URL || 'http://localhost:3000'}/projects/${linkedProjectId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{linkedProjectId}
                </a>
              </p>
            ) : (
              <p className="mt-2 text-sm text-[var(--muted)]">No project linked yet.</p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="input min-w-[14rem]"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                disabled={loadingOrgs}
              >
                <option value="">
                  {loadingOrgs ? 'Loading organizations…' : orgs.length ? 'Organization…' : 'No organizations'}
                </option>
                {orgs.map((o) => (
                  <option key={o.Id} value={o.Id}>
                    {o.Name}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-ghost" disabled={loadingOrgs} onClick={() => void load()}>
                Refresh
              </button>
              {!linkedProjectId && (
                <>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={busy || !orgId}
                    onClick={() => void createProject()}
                  >
                    Create project from vault
                  </button>
                  <input
                    className="input w-40"
                    placeholder="Existing project id"
                    value={linkProjectId}
                    onChange={(e) => setLinkProjectId(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={busy || !orgId || !linkProjectId}
                    onClick={() => void linkProject()}
                  >
                    Link existing
                  </button>
                </>
              )}
              {linkedProjectId && (
                <button type="button" className="btn-danger" disabled={busy} onClick={() => void unlink()}>
                  Unlink project
                </button>
              )}
            </div>
            {orgError && (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                <p>{orgError}</p>
                {(orgError.toLowerCase().includes('sso') ||
                  orgError.toLowerCase().includes('sign in') ||
                  orgError.toLowerCase().includes('expired') ||
                  orgError.toLowerCase().includes('401')) && (
                  <a href="/api/auth/sso/start" className="mt-2 inline-block font-medium text-[var(--accent-soft)]">
                    Sign in again with Project Management →
                  </a>
                )}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Checkbox tasks</h3>
              <div className="flex flex-wrap items-center gap-1">
                {(['unlinked', 'open', 'all'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`rounded-md px-2.5 py-1 text-xs capitalize ${
                      filter === f ? 'bg-[var(--accent)] text-[var(--accent-fg)]' : 'btn-ghost py-1'
                    }`}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn-primary py-1 text-xs"
                  disabled={busy || !linkedProjectId || missingCount === 0}
                  title={
                    !linkedProjectId
                      ? 'Link a project first'
                      : missingCount === 0
                        ? 'All checkboxes already have PM tasks'
                        : `Create ${missingCount} missing PM task${missingCount === 1 ? '' : 's'}`
                  }
                  onClick={() => void pushAllMissing()}
                >
                  Create all missing{missingCount > 0 ? ` (${missingCount})` : ''}
                </button>
              </div>
            </div>
            <p className="mb-3 text-xs text-[var(--muted)]">
              From notes with <code className="text-[var(--accent-soft)]">- [ ]</code> lines. Create a PM task
              per checkbox, or create all missing in one click. Indented checkboxes become Planner subtasks;
              create a note task from the note sidebar to nest top-level checkboxes under the note.
            </p>
            {bulkProgress && (
              <div
                className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--surface)]/60 px-3 py-3"
                role="status"
                aria-live="polite"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[var(--text)]">
                    {bulkProgress.phase === 'prepare' ? 'Preparing…' : 'Creating tasks…'}
                  </span>
                  <span className="tabular-nums text-[var(--muted)]">
                    {bulkProgress.total > 0
                      ? `${bulkProgress.done} / ${bulkProgress.total}`
                      : '…'}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className={`h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ${
                      bulkProgress.total <= 0 ? 'animate-pulse' : ''
                    }`}
                    style={{
                      width:
                        bulkProgress.total > 0
                          ? `${Math.min(100, Math.round((bulkProgress.done / bulkProgress.total) * 100))}%`
                          : '35%',
                    }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
                  <span className="min-w-0 truncate" title={bulkProgress.label}>
                    {bulkProgress.label || 'Working…'}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    created {bulkProgress.created}
                    {bulkProgress.failed > 0 ? ` · failed ${bulkProgress.failed}` : ''}
                    {bulkProgress.skipped > 0 ? ` · skipped ${bulkProgress.skipped}` : ''}
                  </span>
                </div>
              </div>
            )}
            {visible.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted)]">
                No matching checkboxes for this filter.
              </p>
            ) : (
              <ul className="space-y-2">
                {visible.map((item) => (
                  <li
                    key={`${item.noteId}-${item.index}-${item.markerId || item.text}`}
                    className="flex flex-wrap items-start gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 px-3 py-2.5"
                    style={{
                      marginLeft: `${Math.min(item.indent || 0, 12) * 0.45}rem`,
                    }}
                  >
                    <span
                      className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${
                        item.checked
                          ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-300'
                          : 'border-[var(--border)] text-transparent'
                      }`}
                      title={item.checked ? 'Done' : 'Open'}
                    >
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(item.source === 'frontmatter' ||
                          (typeof item.markerId === 'string' &&
                            item.markerId.startsWith('fm:'))) && (
                          <span
                            className="shrink-0 rounded border border-[var(--border)] px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--muted)]"
                            title="From YAML frontmatter todos"
                          >
                            YAML
                          </span>
                        )}
                        <div
                          className={`synapse-task-label text-sm leading-snug ${
                            item.checked
                              ? 'text-[var(--muted)] line-through'
                              : 'text-[var(--text)]'
                          }`}
                          dangerouslySetInnerHTML={{
                            __html: renderInlineMarkdown(item.text || '(empty checkbox)'),
                          }}
                        />
                        {item.linkedNote &&
                          (() => {
                            const target = item.linkedNote;
                            const linkedId = resolveNoteId(target, notes);
                            if (linkedId && onOpenNote) {
                              return (
                                <button
                                  type="button"
                                  className="synapse-wikilink shrink-0 max-w-[9rem] truncate rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium no-underline"
                                  title={`Open note ${target}`}
                                  onClick={() => onOpenNote(linkedId)}
                                >
                                  {target}
                                </button>
                              );
                            }
                            return (
                              <span
                                className="synapse-wikilink is-missing shrink-0 max-w-[9rem] truncate rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium"
                                title={
                                  linkedId
                                    ? `Linked note: ${target}`
                                    : `Missing note: ${target}`
                                }
                              >
                                {target}
                              </span>
                            );
                          })()}
                      </div>
                      <button
                        type="button"
                        className="mt-1 text-[11px] text-[var(--accent-soft)]"
                        onClick={() => onOpenNote?.(item.noteId)}
                      >
                        {item.noteTitle}
                      </button>
                    </div>
                    {item.pmTaskId ? (
                      <a
                        className="btn-ghost shrink-0 py-1 text-xs no-underline"
                        href={item.openUrl || '#'}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PM #{item.pmTaskId}
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary shrink-0 py-1 text-xs"
                        disabled={busy || !linkedProjectId}
                        title={linkedProjectId ? 'Create PM task' : 'Link a project first'}
                        onClick={() => void pushCheckbox(item)}
                      >
                        Create task
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {status && (
          <footer className="shrink-0 border-t border-[var(--border)] px-5 py-2 text-xs text-[var(--muted)]">
            {status}
          </footer>
        )}
    </>
  );

  if (embedded) {
    return <div className="flex h-full min-h-0 flex-col overflow-hidden">{inner}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[min(820px,92vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        {inner}
      </div>
    </div>
  );
}
