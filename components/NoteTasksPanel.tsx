'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listNoteTaskCandidates, sumNoteTaskEstimateHours } from '@/lib/noteTasks';
import {
  computeFrontmatterCategoryEstimates,
  recalculateFrontmatterEstimations,
} from '@/lib/frontmatter';
import {
  resolveCrossVaultWikilink,
  resolveNoteId,
  type LinkableVaultNotes,
  type NoteResolveEntry,
} from '@/lib/notePaths';
import { renderInlineMarkdown } from '@/lib/renderMarkdown';

interface NoteTaskItem {
  index: number;
  text: string;
  checked: boolean;
  markerId: string | null;
  indent: number;
  source: 'checkbox' | 'frontmatter';
  linkedNote: string | null;
  category: string | null;
  estimateHours: number | null;
  pmTaskId: number | null;
  openUrl: string | null;
}

interface NoteTasksPanelProps {
  vaultId: string;
  noteId: number;
  noteTitle?: string;
  body: string;
  hasProject: boolean;
  /**
   * Apply body already persisted by the server (PM sync / markers).
   * Must not leave the editor dirty or skip a needed save.
   */
  onBodyChange: (body: string) => void;
  /**
   * Client-side body rewrite that must be saved (e.g. Recalculate estimates).
   * Receives the full markdown and should persist it to the DB.
   */
  onCommitBody?: (body: string) => Promise<boolean>;
  /** Persist dirty editor content before PM ops that read the note from DB. */
  onEnsureSaved?: () => Promise<boolean>;
  onStatus?: (msg: string) => void;
  compact?: boolean;
  readOnly?: boolean;
  notes?: NoteResolveEntry[];
  linkableVaults?: LinkableVaultNotes[];
  onOpenNote?: (noteId: number) => void;
  onOpenCrossVaultNote?: (vaultId: number, noteId: number) => void;
}

export default function NoteTasksPanel({
  vaultId,
  noteId,
  noteTitle,
  body,
  hasProject,
  onBodyChange,
  onCommitBody,
  onEnsureSaved,
  onStatus,
  compact = false,
  readOnly = false,
  notes = [],
  linkableVaults = [],
  onOpenNote,
  onOpenCrossVaultNote,
}: NoteTasksPanelProps) {
  const [items, setItems] = useState<NoteTaskItem[]>([]);
  const [notePmTaskId, setNotePmTaskId] = useState<number | null>(null);
  const [noteOpenUrl, setNoteOpenUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const applyBodyFromServer = useCallback(
    (next: unknown) => {
      if (typeof next === 'string' && next !== bodyRef.current) {
        onBodyChange(next);
      }
    },
    [onBodyChange]
  );

  const load = useCallback(async () => {
    const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes`, {
      credentials: 'include',
    });
    const data = await res.json();
    if (res.ok) {
      setNeedsReauth(false);
      const payload = data.data;
      const list = Array.isArray(payload) ? payload : payload?.items || [];
      setItems(
        list.map(
          (b: {
            index: number;
            text: string;
            checked: boolean;
            markerId: string | null;
            indent?: number;
            source?: 'checkbox' | 'frontmatter';
            linkedNote?: string | null;
            category?: string | null;
            estimateHours?: number | null;
            pmTaskId: number | null;
            openUrl: string | null;
          }) => ({
            index: b.index,
            text: b.text,
            checked: b.checked,
            markerId: b.markerId,
            indent: typeof b.indent === 'number' ? b.indent : 0,
            source:
              b.source === 'frontmatter' ||
              (typeof b.markerId === 'string' && b.markerId.startsWith('fm:'))
                ? 'frontmatter'
                : 'checkbox',
            linkedNote: b.linkedNote ? String(b.linkedNote) : null,
            category: b.category ? String(b.category) : null,
            estimateHours:
              b.estimateHours != null && Number.isFinite(Number(b.estimateHours))
                ? Number(b.estimateHours)
                : null,
            pmTaskId: b.pmTaskId,
            openUrl: b.openUrl,
          })
        )
      );
      setNotePmTaskId(
        payload && !Array.isArray(payload) && payload.notePmTaskId != null
          ? Number(payload.notePmTaskId)
          : null
      );
      setNoteOpenUrl(
        payload && !Array.isArray(payload) && payload.noteOpenUrl
          ? String(payload.noteOpenUrl)
          : null
      );
      if (payload && !Array.isArray(payload) && typeof payload.bodyMarkdown === 'string') {
        applyBodyFromServer(payload.bodyMarkdown);
        if (payload.syncedFromPm > 0) {
          onStatus?.(
            payload.syncedFromPm === 1
              ? 'Synced 1 task from Project Management'
              : `Synced ${payload.syncedFromPm} tasks from Project Management`
          );
        } else if (payload.clearedStale > 0) {
          onStatus?.(
            payload.clearedStale === 1
              ? 'Cleared 1 stale Planner link'
              : `Cleared ${payload.clearedStale} stale Planner links`
          );
        }
      }
      return;
    }
    setItems(
      listNoteTaskCandidates(body).map((b) => ({
        index: b.index,
        text: b.text,
        checked: b.checked,
        markerId: b.markerId,
        indent: b.indent,
        source: b.source,
        linkedNote: b.linkedNote ? String(b.linkedNote) : null,
        category: b.category ? String(b.category) : null,
        estimateHours:
          b.estimate?.estimatedHours != null ? Number(b.estimate.estimatedHours) : null,
        pmTaskId: null,
        openUrl: null,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- body only used as API failure fallback
  }, [vaultId, noteId, applyBodyFromServer, onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const local = listNoteTaskCandidates(body);
    setItems((prev) =>
      local.map((b) => {
        const old =
          (b.markerId && prev.find((p) => p.markerId === b.markerId)) ||
          prev.find((p) => p.index === b.index && p.text === b.text);
        return {
          index: b.index,
          text: b.text,
          checked: b.checked,
          markerId: b.markerId || old?.markerId || null,
          indent: b.indent,
          source: b.source,
          linkedNote: b.linkedNote ? String(b.linkedNote) : old?.linkedNote ?? null,
          category: b.category ? String(b.category) : null,
          estimateHours:
            b.estimate?.estimatedHours != null ? Number(b.estimate.estimatedHours) : null,
          pmTaskId: old?.pmTaskId ?? null,
          openUrl: old?.openUrl ?? null,
        };
      })
    );
  }, [body]);

  const ensureSaved = async () => {
    if (!onEnsureSaved) return true;
    return onEnsureSaved();
  };

  const toggle = async (item: NoteTaskItem) => {
    if (!(await ensureSaved())) {
      onStatus?.('Save the note before updating tasks');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          index: item.index,
          markerId: item.markerId || undefined,
          checked: !item.checked,
        }),
      });
      const data = await res.json();
      if (res.ok && data.data?.bodyMarkdown != null) {
        applyBodyFromServer(data.data.bodyMarkdown);
        onStatus?.(item.checked ? 'Marked open' : 'Marked done');
        await load();
      } else {
        if (data.reauth) setNeedsReauth(true);
        onStatus?.(data.message || 'Could not update checkbox');
      }
    } finally {
      setBusy(false);
    }
  };

  const createTask = async (item: NoteTaskItem) => {
    if (!hasProject) {
      onStatus?.('Link a PM project in Vault settings first');
      return;
    }
    if (!(await ensureSaved())) {
      onStatus?.('Save the note before creating tasks');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: item.index }),
      });
      const data = await res.json();
      if (res.ok || (res.status === 409 && data.data?.pmTaskId)) {
        applyBodyFromServer(data.data?.bodyMarkdown);
        onStatus?.(
          res.ok && !data.data?.alreadyLinked
            ? `Created PM task #${data.data.pmTaskId}`
            : `Already linked as PM #${data.data.pmTaskId}`
        );
        await load();
      } else {
        if (data.reauth) setNeedsReauth(true);
        onStatus?.(data.message || 'Could not create task');
      }
    } finally {
      setBusy(false);
    }
  };

  const createNoteTask = async (withCheckboxes: boolean) => {
    if (!hasProject) {
      onStatus?.('Link a PM project in Vault settings first');
      return;
    }
    if (!(await ensureSaved())) {
      onStatus?.('Save the note before creating tasks');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/push-task`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withCheckboxes }),
      });
      const data = await res.json();
      if (res.ok) {
        applyBodyFromServer(data.data?.bodyMarkdown);
        const created = data.data?.checkboxes?.created;
        onStatus?.(
          data.data?.alreadyLinked
            ? `Note already linked as PM #${data.data.pmTaskId}${
                created != null ? ` · created ${created} checkbox task(s)` : ''
              }`
            : `Created note task #${data.data.pmTaskId}${
                created != null ? ` · created ${created} checkbox task(s)` : ''
              }`
        );
        await load();
      } else {
        if (data.reauth) setNeedsReauth(true);
        onStatus?.(data.message || 'Could not create note task');
      }
    } finally {
      setBusy(false);
    }
  };

  const createAllMissing = async () => {
    if (!hasProject) {
      onStatus?.('Link a PM project in Vault settings first');
      return;
    }
    if (!(await ensureSaved())) {
      onStatus?.('Save the note before creating tasks');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes/push-missing`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (res.ok) {
        applyBodyFromServer(data.data?.bodyMarkdown);
        onStatus?.(
          `Created ${data.data.created} task(s)` +
            (data.data.skipped ? ` · skipped ${data.data.skipped}` : '') +
            (data.data.failed ? ` · failed ${data.data.failed}` : '')
        );
        await load();
      } else {
        if (data.reauth) setNeedsReauth(true);
        onStatus?.(data.message || 'Could not create tasks');
      }
    } finally {
      setBusy(false);
    }
  };

  const missingCount = items.filter((i) => !i.pmTaskId).length;
  const totalHours = useMemo(() => sumNoteTaskEstimateHours(body), [body]);
  const categoryEstimates = useMemo(
    () => computeFrontmatterCategoryEstimates(body),
    [body]
  );
  const hasEstimateSources = useMemo(
    () =>
      listNoteTaskCandidates(body).some(
        (t) => t.estimate?.estimatedHours != null && Number.isFinite(t.estimate.estimatedHours)
      ),
    [body]
  );

  const recalculateEstimates = async () => {
    if (readOnly) return;
    const result = recalculateFrontmatterEstimations(body);
    if (!result.changed) {
      onStatus?.(
        result.totalHours > 0
          ? `Estimates already up to date · ${result.totalHours}h total`
          : 'No task hours to recalculate'
      );
      return;
    }
    setBusy(true);
    try {
      // Must persist: export/PM read BodyMarkdown from DB, not the editor buffer.
      if (onCommitBody) {
        const ok = await onCommitBody(result.markdown);
        if (!ok) {
          onStatus?.('Updated estimates in editor, but save failed — save before export');
          return;
        }
      } else {
        onBodyChange(result.markdown);
      }
      const catCount = Object.keys(result.categories).length;
      onStatus?.(
        `Updated estimate (${catCount} tasks + Total) · ${result.totalHours}h`
      );
    } finally {
      setBusy(false);
    }
  };

  const showPanel = items.length > 0 || !readOnly;

  if (!showPanel) return null;

  return (
    <div className={compact ? '' : 'rounded-xl border border-[var(--border)] bg-[var(--panel)]/50 p-3'}>
      {needsReauth && (
        <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
          <p>Reconnect Project Management to create or sync tasks.</p>
          <div className="mt-1.5 flex flex-wrap gap-3">
            <a
              href="/api/auth/sso/start"
              className="font-medium text-[var(--accent-soft)] no-underline hover:underline"
            >
              Reconnect SSO
            </a>
            <a href="/profile" className="font-medium text-[var(--accent-soft)] no-underline hover:underline">
              Add personal token in Profile
            </a>
          </div>
        </div>
      )}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Tasks · {items.length}
          {totalHours > 0 ? (
            <>
              {' · '}
              <span className="group/hours relative inline-block">
                <span
                  className="cursor-default border-b border-dotted border-[var(--muted)]/50 text-[var(--text)]"
                  tabIndex={0}
                  aria-describedby="note-tasks-hours-breakdown"
                >
                  {totalHours}h
                </span>
                <span
                  id="note-tasks-hours-breakdown"
                  role="tooltip"
                  className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 hidden min-w-[9rem] rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-2 text-left font-normal normal-case tracking-normal shadow-lg group-hover/hours:block group-focus-within/hours:block"
                >
                  <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                    By category
                  </span>
                  <span className="block space-y-0.5 text-[11px] text-[var(--text)]">
                    {Object.entries(categoryEstimates.categories).map(([name, hours]) => (
                      <span key={name} className="flex justify-between gap-4">
                        <span className="text-[var(--muted)]">{name}</span>
                        <span className="tabular-nums">{hours}h</span>
                      </span>
                    ))}
                    <span className="mt-1 flex justify-between gap-4 border-t border-[var(--border)] pt-1 font-medium">
                      <span>Total</span>
                      <span className="tabular-nums">{categoryEstimates.totalHours}h</span>
                    </span>
                  </span>
                </span>
              </span>
            </>
          ) : null}
        </h3>
        <span className="text-[10px] text-[var(--muted)]">
          {items.filter((i) => i.checked).length} done
          {missingCount > 0 ? ` · ${missingCount} unlinked` : ''}
        </span>
      </div>

      {!readOnly && hasEstimateSources && (
        <div className="mb-3">
          <button
            type="button"
            className="btn-ghost py-1 text-[11px]"
            disabled={busy}
            title="Sum checkbox + YAML todo hours by category into estimate (missing → Other; Total indent 0)"
            onClick={() => void recalculateEstimates()}
          >
            Recalculate estimates
          </button>
        </div>
      )}

      <div className="mb-3 space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)]/40 px-2.5 py-2">
        <p className="text-[11px] text-[var(--muted)]">
          Note task{noteTitle ? ` · ${noteTitle}` : ''}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {notePmTaskId ? (
            <a
              href={noteOpenUrl || '#'}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost py-1 text-[11px] no-underline"
              title="Open note task in Project Management"
            >
              Planner #{notePmTaskId}
            </a>
          ) : (
            !readOnly && (
              <>
                <button
                  type="button"
                  className="btn-primary py-1 text-[11px]"
                  disabled={busy || !hasProject}
                  title={
                    hasProject
                      ? 'Creates one Planner task named after this note. Does not create tasks for checkboxes or YAML todos.'
                      : 'Link a vault project first'
                  }
                  onClick={() => void createNoteTask(false)}
                >
                  Create note task
                </button>
                {items.length > 0 && (
                  <button
                    type="button"
                    className="btn-ghost py-1 text-[11px]"
                    disabled={busy || !hasProject}
                    title={
                      hasProject
                        ? 'Creates the note task and Planner tasks for all unlinked items (checkboxes and YAML todos). Indented checkboxes become nested subtasks; top-level ones nest under the note task.'
                        : 'Link a vault project first'
                    }
                    onClick={() => void createNoteTask(true)}
                  >
                    Note + Subtasks
                  </button>
                )}
              </>
            )
          )}
          {!readOnly && missingCount > 0 && (
            <button
              type="button"
              className="btn-ghost py-1 text-[11px]"
              disabled={busy || !hasProject}
              title={
                hasProject
                  ? 'Creates Planner tasks only for unlinked checkboxes (not a note-level task). Indented lines become subtasks of their parent checkbox.'
                  : 'Link a vault project first'
              }
              onClick={() => void createAllMissing()}
            >
              Create missing ({missingCount})
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-[11px] text-[var(--muted)]">
          Add <code className="text-[var(--accent-soft)]">- [ ]</code> lines or YAML{' '}
          <code className="text-[var(--accent-soft)]">todos:</code> for tasks. Indent nested
          checkboxes to create Planner subtasks.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li
              key={`${item.index}-${item.markerId || item.text}`}
              className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-[var(--surface-2)]/60"
              style={{ paddingLeft: `${0.25 + Math.min(item.indent, 12) * 0.35}rem` }}
            >
              <button
                type="button"
                disabled={busy || readOnly}
                onClick={() => void toggle(item)}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs transition ${
                  item.checked
                    ? 'border-emerald-400/60 bg-emerald-500/25 text-emerald-200'
                    : 'border-[var(--border-strong)] text-transparent hover:border-[var(--accent)]'
                }`}
                title={
                  readOnly
                    ? item.checked
                      ? 'Done'
                      : 'Open'
                    : item.checked
                      ? 'Mark as open'
                      : 'Mark as done'
                }
                aria-label={item.checked ? 'Mark as open' : 'Mark as done'}
              >
                ✓
              </button>
              {item.source === 'frontmatter' && (
                <span
                  className="shrink-0 rounded border border-[var(--border)] px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--muted)]"
                  title="From YAML frontmatter todos"
                >
                  YAML
                </span>
              )}
              {item.category ? (
                <span
                  className="shrink-0 rounded border border-[var(--border)] px-1 py-0.5 text-[9px] font-medium text-[var(--accent-soft)]"
                  title="Category"
                >
                  {item.category}
                </span>
              ) : null}
              {item.estimateHours != null ? (
                <span className="shrink-0 text-[10px] text-[var(--muted)]" title="Estimate">
                  {item.estimateHours}h
                </span>
              ) : null}
              <span
                className={`synapse-task-label min-w-0 flex-1 text-sm leading-snug ${
                  item.checked ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'
                }`}
                onClick={(e) => {
                  const a = (e.target as HTMLElement).closest(
                    'a.synapse-wikilink'
                  ) as HTMLAnchorElement | null;
                  if (!a) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const id = Number(a.dataset.noteId || 0);
                  const crossVaultId = Number(a.dataset.vaultId || 0);
                  if (id && crossVaultId && crossVaultId !== Number(vaultId) && onOpenCrossVaultNote) {
                    onOpenCrossVaultNote(crossVaultId, id);
                    return;
                  }
                  if (id && onOpenNote) onOpenNote(id);
                }}
                dangerouslySetInnerHTML={{
                  __html: renderInlineMarkdown(item.text || '(empty)', notes, linkableVaults),
                }}
              />
              {item.linkedNote &&
                (() => {
                  const target = item.linkedNote;
                  const sameVaultId = resolveNoteId(target, notes);
                  if (sameVaultId && onOpenNote) {
                    return (
                      <button
                        type="button"
                        className="synapse-wikilink shrink-0 max-w-[9rem] truncate rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium no-underline"
                        title={`Open note ${target}`}
                        onClick={() => onOpenNote(sameVaultId)}
                      >
                        {target}
                      </button>
                    );
                  }
                  const cross = target.trim().startsWith('@')
                    ? resolveCrossVaultWikilink(target, linkableVaults)
                    : null;
                  if (cross?.status === 'ok' && onOpenCrossVaultNote) {
                    return (
                      <button
                        type="button"
                        className="synapse-wikilink shrink-0 max-w-[9rem] truncate rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium no-underline"
                        title={`Open note ${cross.label}`}
                        onClick={() => onOpenCrossVaultNote(cross.vaultId, cross.noteId)}
                      >
                        {cross.label}
                      </button>
                    );
                  }
                  if (cross?.status === 'locked') {
                    return (
                      <span
                        className="synapse-wikilink is-locked shrink-0 max-w-[12rem] truncate rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium"
                        title="You don't have access to this note"
                      >
                        {cross.label}
                        <span className="synapse-wikilink-lock ml-1">no access</span>
                      </span>
                    );
                  }
                  return (
                    <span
                      className="synapse-wikilink is-missing shrink-0 max-w-[9rem] truncate rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-medium"
                      title={`Missing note: ${target}`}
                    >
                      {target}
                    </span>
                  );
                })()}
              {item.pmTaskId ? (
                <a
                  href={item.openUrl || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-[10px] text-[var(--accent-soft)] no-underline"
                  title="Open in Project Management"
                >
                  Planner #{item.pmTaskId}
                </a>
              ) : (
                !readOnly && (
                  <button
                    type="button"
                    className="shrink-0 text-[10px] font-medium text-[var(--accent-soft)] disabled:opacity-40"
                    disabled={busy || !hasProject}
                    title={
                      hasProject
                        ? 'Create a Planner task for this checkbox only. If indented, also creates missing parents and nests it as a subtask.'
                        : 'Link a vault project first'
                    }
                    onClick={() => void createTask(item)}
                  >
                    Create task
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
