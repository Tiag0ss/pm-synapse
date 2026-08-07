'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  applyFrontmatterTodosList,
  type ApplyFrontmatterTodoInput,
} from '@/lib/frontmatter';

export type ExistingTodoSuggestion = {
  id: string;
  content: string;
  status: string;
  hours: number | null;
  category: string | null;
  unscheduled?: boolean;
  noteTarget?: string | null;
};

export type ProposedTodoSuggestion = {
  content: string;
  hours?: number | null;
  category?: string | null;
  status?: string;
  rationale?: string | null;
};

type ExistingRow = {
  key: string;
  id: string;
  content: string;
  status: string;
  hours: string;
  category: string;
  unscheduled: boolean;
  note: string | null;
  keep: boolean;
};

type ProposedAction = 'add' | 'merge' | 'discard';

type ProposedRow = {
  key: string;
  content: string;
  status: string;
  hours: string;
  category: string;
  rationale: string;
  action: ProposedAction;
  mergeTargetKey: string;
};

interface AiTodosReviewModalProps {
  open: boolean;
  bodyMarkdown: string;
  existing: ExistingTodoSuggestion[];
  proposed: ProposedTodoSuggestion[];
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onApply: (nextMarkdown: string) => Promise<void> | void;
}

function findFuzzyMatchKey(
  content: string,
  existing: Array<{ key: string; content: string }>
): string {
  const needle = content.trim().toLowerCase();
  if (!needle) return '';
  const hit = existing.find((e) => e.content.trim().toLowerCase() === needle);
  return hit?.key || '';
}

function hoursToInput(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '';
  return String(hours);
}

function parseHours(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function AiTodosReviewModal({
  open,
  bodyMarkdown,
  existing,
  proposed,
  busy = false,
  error = '',
  onClose,
  onApply,
}: AiTodosReviewModalProps) {
  const [existingRows, setExistingRows] = useState<ExistingRow[]>([]);
  const [proposedRows, setProposedRows] = useState<ProposedRow[]>([]);
  const [applyBusy, setApplyBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLocalError('');
    const nextExisting: ExistingRow[] = existing.map((t, i) => ({
      key: t.id || `ex-${i}`,
      id: t.id || '',
      content: t.content || '',
      status: t.status || 'pending',
      hours: hoursToInput(t.hours),
      category: t.category || '',
      unscheduled: t.unscheduled === true,
      note: t.noteTarget || null,
      keep: true,
    }));
    setExistingRows(nextExisting);

    setProposedRows(
      proposed.map((p, i) => {
        const matchKey = findFuzzyMatchKey(p.content || '', nextExisting);
        return {
          key: `prop-${i}`,
          content: p.content || '',
          status: p.status || 'pending',
          hours: hoursToInput(p.hours),
          category: p.category || '',
          rationale: p.rationale || '',
          action: matchKey ? 'merge' : 'add',
          mergeTargetKey: matchKey,
        };
      })
    );
  }, [open, existing, proposed]);

  const keepTargets = useMemo(
    () => existingRows.filter((r) => r.keep),
    [existingRows]
  );

  if (!open) return null;

  const updateExisting = (key: string, patch: Partial<ExistingRow>) => {
    setExistingRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const updateProposed = (key: string, patch: Partial<ProposedRow>) => {
    setProposedRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const buildFinalTodos = (): ApplyFrontmatterTodoInput[] | null => {
    const byKey = new Map(existingRows.map((r) => [r.key, { ...r }]));

    for (const p of proposedRows) {
      if (p.action === 'discard') continue;
      if (p.action === 'merge') {
        const target = byKey.get(p.mergeTargetKey);
        if (!target || !target.keep) {
          setLocalError('Choose a kept existing todo for each merge');
          return null;
        }
        target.content = p.content.trim() || target.content;
        target.status = target.status;
        target.hours = p.hours.trim() || target.hours;
        target.category = p.category.trim() || target.category;
        byKey.set(target.key, target);
        continue;
      }
    }

    const out: ApplyFrontmatterTodoInput[] = [];
    for (const r of existingRows) {
      const cur = byKey.get(r.key);
      if (!cur || !cur.keep) continue;
      const content = cur.content.trim();
      if (!content) continue;
      out.push({
        id: cur.id || null,
        content,
        status: cur.status.trim() || 'pending',
        hours: parseHours(cur.hours),
        category: cur.category.trim() || null,
        unscheduled: cur.unscheduled,
        note: cur.note,
      });
    }

    for (const p of proposedRows) {
      if (p.action !== 'add') continue;
      const content = p.content.trim();
      if (!content) continue;
      out.push({
        content,
        status: p.status.trim() || 'pending',
        hours: parseHours(p.hours),
        category: p.category.trim() || null,
      });
    }

    return out;
  };

  const handleApply = async () => {
    setLocalError('');
    const todos = buildFinalTodos();
    if (!todos) return;
    setApplyBusy(true);
    try {
      const next = applyFrontmatterTodosList(bodyMarkdown, todos);
      await onApply(next);
    } catch {
      setLocalError('Failed to apply todos');
    } finally {
      setApplyBusy(false);
    }
  };

  const displayError = localError || error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/40"
      >
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">
            Review AI todo suggestions
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Edit, merge into existing, or discard before updating the note. Nothing is saved until
            you apply.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {busy && (
            <p className="text-sm text-[var(--muted)]">Analyzing note with Ollama…</p>
          )}
          {displayError && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {displayError}
            </p>
          )}

          {!busy && (
            <>
              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Existing · {existingRows.length}
                </h3>
                {existingRows.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No frontmatter todos yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {existingRows.map((row) => (
                      <li
                        key={row.key}
                        className={`rounded-lg border border-[var(--border)] bg-[var(--surface)]/40 p-3 ${
                          row.keep ? '' : 'opacity-50'
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                            Existing
                          </span>
                          <label className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                            <input
                              type="checkbox"
                              checked={row.keep}
                              onChange={(e) => updateExisting(row.key, { keep: e.target.checked })}
                            />
                            Keep
                          </label>
                        </div>
                        <input
                          className="input mb-2 w-full text-sm"
                          value={row.content}
                          disabled={!row.keep}
                          onChange={(e) => updateExisting(row.key, { content: e.target.value })}
                        />
                        <div className="grid gap-2 sm:grid-cols-3">
                          <label className="block text-[11px] text-[var(--muted)]">
                            Hours
                            <input
                              className="input mt-0.5 w-full text-sm"
                              value={row.hours}
                              disabled={!row.keep}
                              onChange={(e) => updateExisting(row.key, { hours: e.target.value })}
                            />
                          </label>
                          <label className="block text-[11px] text-[var(--muted)]">
                            Category
                            <input
                              className="input mt-0.5 w-full text-sm"
                              value={row.category}
                              disabled={!row.keep}
                              onChange={(e) =>
                                updateExisting(row.key, { category: e.target.value })
                              }
                            />
                          </label>
                          <label className="block text-[11px] text-[var(--muted)]">
                            Status
                            <input
                              className="input mt-0.5 w-full text-sm"
                              value={row.status}
                              disabled={!row.keep}
                              onChange={(e) => updateExisting(row.key, { status: e.target.value })}
                            />
                          </label>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Proposed · {proposedRows.length}
                </h3>
                {proposedRows.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No suggestions returned.</p>
                ) : (
                  <ul className="space-y-2">
                    {proposedRows.map((row) => (
                      <li
                        key={row.key}
                        className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/40 p-3"
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent-soft)]">
                            Proposed
                          </span>
                          <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                            Action
                            <select
                              className="input py-1 text-[11px]"
                              value={row.action}
                              onChange={(e) => {
                                const action = e.target.value as ProposedAction;
                                updateProposed(row.key, {
                                  action,
                                  mergeTargetKey:
                                    action === 'merge'
                                      ? row.mergeTargetKey || keepTargets[0]?.key || ''
                                      : '',
                                });
                              }}
                            >
                              <option value="add">Add as new</option>
                              <option value="merge" disabled={keepTargets.length === 0}>
                                Merge into existing
                              </option>
                              <option value="discard">Discard</option>
                            </select>
                          </label>
                          {row.action === 'merge' && (
                            <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                              Target
                              <select
                                className="input max-w-[14rem] py-1 text-[11px]"
                                value={row.mergeTargetKey}
                                onChange={(e) =>
                                  updateProposed(row.key, { mergeTargetKey: e.target.value })
                                }
                              >
                                <option value="">Select…</option>
                                {keepTargets.map((t) => (
                                  <option key={t.key} value={t.key}>
                                    {t.content || t.id || t.key}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                        {row.rationale ? (
                          <p className="mb-2 text-[11px] italic text-[var(--muted)]">
                            {row.rationale}
                          </p>
                        ) : null}
                        <input
                          className="input mb-2 w-full text-sm"
                          value={row.content}
                          disabled={row.action === 'discard'}
                          onChange={(e) => updateProposed(row.key, { content: e.target.value })}
                        />
                        <div className="grid gap-2 sm:grid-cols-3">
                          <label className="block text-[11px] text-[var(--muted)]">
                            Hours
                            <input
                              className="input mt-0.5 w-full text-sm"
                              value={row.hours}
                              disabled={row.action === 'discard'}
                              onChange={(e) => updateProposed(row.key, { hours: e.target.value })}
                            />
                          </label>
                          <label className="block text-[11px] text-[var(--muted)]">
                            Category
                            <input
                              className="input mt-0.5 w-full text-sm"
                              value={row.category}
                              disabled={row.action === 'discard'}
                              onChange={(e) =>
                                updateProposed(row.key, { category: e.target.value })
                              }
                            />
                          </label>
                          <label className="block text-[11px] text-[var(--muted)]">
                            Status
                            <input
                              className="input mt-0.5 w-full text-sm"
                              value={row.status}
                              disabled={row.action === 'discard' || row.action === 'merge'}
                              onChange={(e) => updateProposed(row.key, { status: e.target.value })}
                            />
                          </label>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={applyBusy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || applyBusy || Boolean(error && proposedRows.length === 0)}
            onClick={() => void handleApply()}
          >
            {applyBusy ? 'Applying…' : 'Apply to note'}
          </button>
        </div>
      </div>
    </div>
  );
}
