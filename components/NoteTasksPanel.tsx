'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseCheckboxes } from '@/lib/checkboxes';
import { renderInlineMarkdown } from '@/lib/renderMarkdown';

interface NoteTaskItem {
  index: number;
  text: string;
  checked: boolean;
  markerId: string | null;
  pmTaskId: number | null;
  openUrl: string | null;
}

interface NoteTasksPanelProps {
  vaultId: string;
  noteId: number;
  body: string;
  hasProject: boolean;
  onBodyChange: (body: string) => void;
  onStatus?: (msg: string) => void;
  compact?: boolean;
  readOnly?: boolean;
}

export default function NoteTasksPanel({
  vaultId,
  noteId,
  body,
  hasProject,
  onBodyChange,
  onStatus,
  compact = false,
  readOnly = false,
}: NoteTasksPanelProps) {
  const [items, setItems] = useState<NoteTaskItem[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes`, {
      credentials: 'include',
    });
    const data = await res.json();
    if (res.ok) {
      const payload = data.data;
      const list = Array.isArray(payload) ? payload : payload?.items || [];
      setItems(list);
      if (payload && !Array.isArray(payload) && typeof payload.bodyMarkdown === 'string') {
        onBodyChange(payload.bodyMarkdown);
        if (payload.syncedFromPm > 0) {
          onStatus?.(
            payload.syncedFromPm === 1
              ? 'Synced 1 task from Project Management'
              : `Synced ${payload.syncedFromPm} tasks from Project Management`
          );
        }
      }
      return;
    }
    // Fallback: parse locally if API fails
    setItems(
      parseCheckboxes(body).map((b) => ({
        index: b.index,
        text: b.text,
        checked: b.checked,
        markerId: b.markerId,
        pmTaskId: null,
        openUrl: null,
      }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- body only used as API failure fallback
  }, [vaultId, noteId, onBodyChange, onStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep list in sync while typing (local parse) then refresh links after save via load
  useEffect(() => {
    const local = parseCheckboxes(body);
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
          pmTaskId: old?.pmTaskId ?? null,
          openUrl: old?.openUrl ?? null,
        };
      })
    );
  }, [body]);

  const toggle = async (item: NoteTaskItem) => {
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
        onBodyChange(data.data.bodyMarkdown);
        onStatus?.(item.checked ? 'Marked open' : 'Marked done');
        await load();
      } else {
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
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes/push`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: item.index }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.data.bodyMarkdown) onBodyChange(data.data.bodyMarkdown);
        onStatus?.(`Created PM task #${data.data.pmTaskId}`);
        if (data.data.openUrl) window.open(data.data.openUrl, '_blank');
        await load();
      } else {
        onStatus?.(data.message || 'Could not create task');
      }
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={compact ? '' : 'rounded-xl border border-[var(--border)] bg-[var(--panel)]/50 p-3'}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
          Tasks · {items.length}
        </h3>
        <span className="text-[10px] text-[var(--muted)]">
          {items.filter((i) => i.checked).length} done
        </span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li
            key={`${item.index}-${item.markerId || item.text}`}
            className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-[var(--surface-2)]/60"
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
            <span
              className={`synapse-task-label min-w-0 flex-1 text-sm leading-snug ${
                item.checked ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'
              }`}
              dangerouslySetInnerHTML={{
                __html: renderInlineMarkdown(item.text || '(empty)'),
              }}
            />
            {item.pmTaskId ? (
              <a
                href={item.openUrl || '#'}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[10px] text-[var(--accent-soft)] no-underline"
              >
                PM #{item.pmTaskId}
              </a>
            ) : (
              !readOnly && (
              <button
                type="button"
                className="shrink-0 text-[10px] font-medium text-[var(--accent-soft)] disabled:opacity-40"
                disabled={busy || !hasProject}
                title={hasProject ? 'Create PM task' : 'Link a vault project first'}
                onClick={() => void createTask(item)}
              >
                → PM
              </button>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
