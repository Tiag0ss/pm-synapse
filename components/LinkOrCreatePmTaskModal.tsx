'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export type LinkablePmTaskOption = {
  id: number;
  taskName: string;
  statusName: string | null;
  projectId: number;
  projectName: string;
  openUrl: string;
};

export type LinkablePmProjectOption = {
  id: number;
  name: string;
};

interface LinkOrCreatePmTaskModalProps {
  open: boolean;
  vaultId: string;
  checkboxLabel: string;
  busy?: boolean;
  onClose: () => void;
  onCreate: () => void | Promise<void>;
  onLink: (pmTaskId: number, pmProjectId: number) => void | Promise<void>;
}

function normalizeLinkableTask(raw: Record<string, unknown>): LinkablePmTaskOption | null {
  const id = Number(raw.id ?? raw.Id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const projectId = Number(raw.projectId ?? raw.ProjectId ?? 0);
  const taskName = String(raw.taskName ?? raw.TaskName ?? raw.Name ?? `Task #${id}`).trim();
  const statusNameRaw = raw.statusName ?? raw.StatusName;
  return {
    id,
    taskName: taskName || `Task #${id}`,
    statusName: statusNameRaw != null && String(statusNameRaw).trim() ? String(statusNameRaw) : null,
    projectId: Number.isFinite(projectId) && projectId > 0 ? projectId : 0,
    projectName: String(raw.projectName ?? raw.ProjectName ?? '').trim() || 'Project',
    openUrl: String(raw.openUrl ?? raw.OpenUrl ?? ''),
  };
}

export default function LinkOrCreatePmTaskModal({
  open,
  vaultId,
  checkboxLabel,
  busy = false,
  onClose,
  onCreate,
  onLink,
}: LinkOrCreatePmTaskModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [projects, setProjects] = useState<LinkablePmProjectOption[]>([]);
  const [tasks, setTasks] = useState<LinkablePmTaskOption[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [defaultProjectId, setDefaultProjectId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedId(null);
    setError('');
    setNeedsReauth(false);
    setProjectFilter('all');
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/vaults/${vaultId}/pm-tasks/linkable`, {
          credentials: 'include',
        });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          if (json.reauth || res.status === 401) setNeedsReauth(true);
          setTasks([]);
          setProjects([]);
          setError(json.message || 'Failed to load Planner tasks');
          return;
        }
        const payload = json.data;
        const rawTasks = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.tasks)
            ? payload.tasks
            : [];
        const rawProjects = Array.isArray(payload?.projects) ? payload.projects : [];
        const normalized = rawTasks
          .map((row: unknown) =>
            row && typeof row === 'object'
              ? normalizeLinkableTask(row as Record<string, unknown>)
              : null
          )
          .filter((t: LinkablePmTaskOption | null): t is LinkablePmTaskOption => t != null);
        setTasks(normalized);
        setProjects(
          rawProjects
            .map((p: { id?: number; Id?: number; name?: string; Name?: string }) => ({
              id: Number(p.id ?? p.Id),
              name: String(p.name ?? p.Name ?? '').trim() || `Project #${p.id ?? p.Id}`,
            }))
            .filter((p: LinkablePmProjectOption) => Number.isFinite(p.id) && p.id > 0)
        );
        const def = Number(payload?.defaultProjectId);
        setDefaultProjectId(Number.isFinite(def) && def > 0 ? def : null);
      } catch {
        if (!cancelled) {
          setTasks([]);
          setProjects([]);
          setError('Network error loading Planner tasks');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, vaultId]);

  useEffect(() => {
    if (!open || loading) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open, loading]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const projId = projectFilter === 'all' ? null : Number(projectFilter);
    return tasks.filter((t) => {
      if (projId != null && Number.isFinite(projId) && t.projectId !== projId) return false;
      if (!q) return true;
      const name = String(t.taskName || '').toLowerCase();
      const status = String(t.statusName || '').toLowerCase();
      const project = String(t.projectName || '').toLowerCase();
      const id = String(t.id);
      return name.includes(q) || status.includes(q) || project.includes(q) || id.includes(q);
    });
  }, [tasks, query, projectFilter]);

  const selectedTask = selectedId != null ? tasks.find((t) => t.id === selectedId) : null;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-or-create-pm-title"
        className="flex max-h-[min(640px,92vh)] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl sm:rounded-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="shrink-0 border-b border-[var(--border)] px-5 py-4">
          <h2 id="link-or-create-pm-title" className="text-lg font-semibold text-[var(--text)]">
            Link or create Planner task
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            For{' '}
            <span className="font-medium text-[var(--text)]">
              {checkboxLabel.trim() || 'this checkbox'}
            </span>
            . Link any Synapse-free task in the organization (including other projects).
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-4">
          {needsReauth && (
            <p className="shrink-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              Reconnect SSO or add a personal API token in Profile to load Planner tasks.
            </p>
          )}
          {error && !needsReauth && (
            <p className="shrink-0 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          )}

          {projects.length > 0 && (
            <div className="shrink-0">
              <label className="mb-1 block text-xs font-medium text-[var(--muted)]" htmlFor="linkable-project">
                Project
              </label>
              <select
                id="linkable-project"
                className="input w-full"
                value={projectFilter}
                disabled={busy || loading}
                onChange={(e) => {
                  setProjectFilter(e.target.value);
                  setSelectedId(null);
                }}
              >
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                    {defaultProjectId === p.id ? ' (vault)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <label className="shrink-0 block text-xs font-medium text-[var(--muted)]" htmlFor="linkable-search">
            Search existing tasks
          </label>
          <input
            ref={inputRef}
            id="linkable-search"
            type="text"
            autoComplete="off"
            className="input w-full shrink-0"
            placeholder="Filter by name, project, or id…"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                onClose();
              }
            }}
          />

          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-[var(--border)]">
            {loading ? (
              <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">
                {tasks.length === 0
                  ? 'No linkable Planner tasks in this organization.'
                  : 'No tasks match this filter.'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {filtered.map((t) => {
                  const selected = selectedId === t.id;
                  return (
                    <li key={`${t.projectId}-${t.id}`}>
                      <button
                        type="button"
                        disabled={busy}
                        className={`flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm transition ${
                          selected
                            ? 'bg-[var(--accent)]/20 text-[var(--text)]'
                            : 'hover:bg-[var(--surface)]/60 text-[var(--text)]'
                        }`}
                        onClick={() => setSelectedId(t.id)}
                      >
                        <span
                          className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            selected
                              ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]'
                              : 'border-[var(--border)]'
                          }`}
                          aria-hidden
                        >
                          {selected ? '✓' : ''}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{t.taskName}</span>
                          <span className="mt-0.5 block text-[11px] text-[var(--muted)]">
                            #{t.id}
                            {t.projectName ? ` · ${t.projectName}` : ''}
                            {t.statusName ? ` · ${t.statusName}` : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={busy || loading}
            onClick={() => void onCreate()}
          >
            Create new task
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || loading || !selectedTask || !selectedTask.projectId}
            onClick={() => {
              if (selectedTask) void onLink(selectedTask.id, selectedTask.projectId);
            }}
          >
            Link selected
          </button>
        </footer>
      </div>
    </div>
  );
}
