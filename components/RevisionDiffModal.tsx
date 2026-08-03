'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSideBySideDiff, wordHighlight } from '@/lib/sideBySideDiff';

export interface RevisionSnapshot {
  RevisionNumber: number;
  Title: string;
  Path: string;
  BodyMarkdown: string;
  Visibility?: string | null;
  CreatedAt?: string;
}

interface RevisionDiffModalProps {
  open: boolean;
  loading?: boolean;
  revision: RevisionSnapshot | null;
  current: {
    title: string;
    path: string;
    bodyMarkdown: string;
    visibility: string;
  };
  onClose: () => void;
  onRestore: () => void;
  restoring?: boolean;
}

function MetaChip({ label, value, changed }: { label: string; value: string; changed?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-2.5 py-1.5 text-xs ${
        changed
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]'
      }`}
    >
      <div className="font-medium uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-0.5 break-all font-mono text-[11px] text-[var(--text)]">{value || '—'}</div>
    </div>
  );
}

export default function RevisionDiffModal({
  open,
  loading,
  revision,
  current,
  onClose,
  onRestore,
  restoring,
}: RevisionDiffModalProps) {
  const leftScroll = useRef<HTMLDivElement>(null);
  const rightScroll = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const [onlyChanges, setOnlyChanges] = useState(false);

  const rows = useMemo(() => {
    if (!revision) return [];
    return buildSideBySideDiff(String(revision.BodyMarkdown || ''), current.bodyMarkdown || '');
  }, [revision, current.bodyMarkdown]);

  const visibleRows = useMemo(
    () => (onlyChanges ? rows.filter((r) => r.op !== 'equal') : rows),
    [rows, onlyChanges]
  );

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const r of rows) {
      if (r.op === 'insert') added++;
      else if (r.op === 'delete') removed++;
      else if (r.op === 'replace') changed++;
    }
    return { added, removed, changed };
  }, [rows]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const syncScroll = (source: 'left' | 'right') => {
    if (syncing.current) return;
    const a = source === 'left' ? leftScroll.current : rightScroll.current;
    const b = source === 'left' ? rightScroll.current : leftScroll.current;
    if (!a || !b) return;
    syncing.current = true;
    const ratio = a.scrollTop / Math.max(1, a.scrollHeight - a.clientHeight);
    b.scrollTop = ratio * Math.max(1, b.scrollHeight - b.clientHeight);
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[min(880px,100dvh)] w-full max-w-6xl flex-col overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/50 sm:h-[min(880px,92vh)] sm:rounded-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Compare &amp; restore</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Meld-style diff · left is revision #{revision?.RevisionNumber ?? '…'} · right is the
              current note
            </p>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
              <span className="text-emerald-300">+{stats.added} added</span>
              <span className="text-red-300">−{stats.removed} removed</span>
              <span className="text-amber-200">~{stats.changed} changed</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input
                type="checkbox"
                checked={onlyChanges}
                onChange={(e) => setOnlyChanges(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Only changes
            </label>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={!revision || loading || restoring}
              onClick={onRestore}
            >
              {restoring ? 'Restoring…' : `Restore #${revision?.RevisionNumber ?? ''}`}
            </button>
          </div>
        </header>

        {loading || !revision ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]">
            Loading revision…
          </div>
        ) : (
          <>
            <div className="grid shrink-0 grid-cols-1 gap-3 border-b border-[var(--border)] px-5 py-3 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Revision #{revision.RevisionNumber}
                  {revision.CreatedAt ? ` · ${new Date(revision.CreatedAt).toLocaleString()}` : ''}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <MetaChip
                    label="Title"
                    value={revision.Title}
                    changed={revision.Title !== current.title}
                  />
                  <MetaChip
                    label="Path"
                    value={revision.Path}
                    changed={revision.Path !== current.path}
                  />
                  <MetaChip
                    label="Visibility"
                    value={revision.Visibility || 'default'}
                    changed={(revision.Visibility || '') !== (current.visibility || '')}
                  />
                </div>
              </div>
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Current
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <MetaChip label="Title" value={current.title} />
                  <MetaChip label="Path" value={current.path} />
                  <MetaChip label="Visibility" value={current.visibility || 'default'} />
                </div>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
              <div className="flex min-h-0 flex-col border-b border-[var(--border)] md:border-b-0 md:border-r">
                <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] font-medium text-[var(--muted)]">
                  Revision body
                </div>
                <div
                  ref={leftScroll}
                  className="diff-pane min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5"
                  onScroll={() => syncScroll('left')}
                >
                  {visibleRows.map((row, idx) => {
                    const hl =
                      row.op === 'replace' && row.left != null && row.right != null
                        ? wordHighlight(row.left, row.right).leftHtml
                        : null;
                    return (
                      <div
                        key={`L-${idx}`}
                        className={`diff-row flex ${
                          row.op === 'delete' || row.op === 'replace'
                            ? 'diff-row-del'
                            : row.op === 'insert'
                              ? 'diff-row-empty'
                              : ''
                        }`}
                      >
                        <span className="diff-ln">{row.leftLine ?? ''}</span>
                        <pre className="diff-code">
                          {hl ? (
                            <span dangerouslySetInnerHTML={{ __html: hl }} />
                          ) : (
                            row.left ?? ''
                          )}
                        </pre>
                      </div>
                    );
                  })}
                  {visibleRows.length === 0 && (
                    <p className="p-4 text-sm text-[var(--muted)]">No differences in body.</p>
                  )}
                </div>
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[11px] font-medium text-[var(--muted)]">
                  Current body
                </div>
                <div
                  ref={rightScroll}
                  className="diff-pane min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-5"
                  onScroll={() => syncScroll('right')}
                >
                  {visibleRows.map((row, idx) => {
                    const hl =
                      row.op === 'replace' && row.left != null && row.right != null
                        ? wordHighlight(row.left, row.right).rightHtml
                        : null;
                    return (
                      <div
                        key={`R-${idx}`}
                        className={`diff-row flex ${
                          row.op === 'insert' || row.op === 'replace'
                            ? 'diff-row-ins'
                            : row.op === 'delete'
                              ? 'diff-row-empty'
                              : ''
                        }`}
                      >
                        <span className="diff-ln">{row.rightLine ?? ''}</span>
                        <pre className="diff-code">
                          {hl ? (
                            <span dangerouslySetInnerHTML={{ __html: hl }} />
                          ) : (
                            row.right ?? ''
                          )}
                        </pre>
                      </div>
                    );
                  })}
                  {visibleRows.length === 0 && (
                    <p className="p-4 text-sm text-[var(--muted)]">No differences in body.</p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
