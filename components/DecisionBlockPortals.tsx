'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type DecisionView = {
  choiceKind: 'option' | 'custom' | null;
  optionIndex: number | null;
  choiceLabel: string | null;
  locked: boolean;
  authorName: string | null;
  updatedAt: string;
};

export type DecisionEventView = {
  id: number;
  decisionId: number;
  eventType: 'chose' | 'cleared' | 'locked' | 'unlocked' | string;
  actorKind: string;
  actorLabel: string;
  payload?: {
    choiceKind?: string | null;
    optionIndex?: number | null;
    choiceLabel?: string | null;
    previousChoiceLabel?: string | null;
    locked?: boolean;
  };
  createdAt: string;
};

export type DecisionBlockMount = {
  key: string;
  el: HTMLElement;
  decisionId: string;
  title: string;
  options: string[];
};

function parseOptionsAttr(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x)).filter(Boolean);
  } catch {
    return [];
  }
}

export function collectDecisionBlockMounts(root: HTMLElement): DecisionBlockMount[] {
  const nodes = root.querySelectorAll<HTMLElement>('.synapse-decision');
  const mounts: DecisionBlockMount[] = [];
  nodes.forEach((el, i) => {
    const decisionId = String(el.getAttribute('data-decision-id') || '').trim();
    const title = String(el.getAttribute('data-decision-title') || 'Decision').trim();
    const options = parseOptionsAttr(el.getAttribute('data-decision-options'));
    mounts.push({
      key: `decision-${decisionId || 'x'}-${i}`,
      el,
      decisionId,
      title,
      options,
    });
  });
  return mounts;
}

type DecisionBlockPortalsProps = {
  mounts: DecisionBlockMount[];
  decisionsById?: Record<string, DecisionView>;
  eventsByMarkerId?: Record<string, DecisionEventView[]>;
  mode: 'share' | 'editor' | 'readonly';
  shareToken?: string;
  vaultId?: string | number;
  noteId?: number;
  onDecisionsChange?: () => void;
};

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function DecisionBlockPortalItem({
  mount,
  decision,
  events,
  mode,
  shareToken,
  vaultId,
  noteId,
  onDecisionsChange,
}: {
  mount: DecisionBlockMount;
  decision: DecisionView | null;
  events: DecisionEventView[];
  mode: 'share' | 'editor' | 'readonly';
  shareToken?: string;
  vaultId?: string | number;
  noteId?: number;
  onDecisionsChange?: () => void;
}) {
  // Clear placeholder once before portal children mount (same pattern as ask blocks).
  // Do not clear in an effect — that races React portal ownership and throws removeChild.
  useState(() => {
    mount.el.replaceChildren();
    return true;
  });

  const locked = Boolean(decision?.locked);
  const canMutate = (mode === 'share' || mode === 'editor') && !locked && Boolean(mount.decisionId);
  const [selected, setSelected] = useState<'option' | 'other'>(
    decision?.choiceKind === 'custom' ? 'other' : 'option'
  );
  const [optionIndex, setOptionIndex] = useState<number>(
    decision?.choiceKind === 'option' && decision.optionIndex != null ? decision.optionIndex : 0
  );
  const [customText, setCustomText] = useState(
    decision?.choiceKind === 'custom' ? String(decision.choiceLabel || '') : ''
  );
  const [authorName, setAuthorName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (decision?.choiceKind === 'custom') {
      setSelected('other');
      setCustomText(String(decision.choiceLabel || ''));
    } else if (decision?.choiceKind === 'option' && decision.optionIndex != null) {
      setSelected('option');
      setOptionIndex(decision.optionIndex);
    }
  }, [decision?.choiceKind, decision?.optionIndex, decision?.choiceLabel, decision?.updatedAt]);

  const historyEntries = useMemo(
    () => [...events].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    [events]
  );

  const saveChoice = async () => {
    if (!canMutate) return;
    setBusy(true);
    setError('');
    try {
      const body =
        selected === 'other'
          ? { customText: customText.trim(), ...(mode === 'share' ? { authorName } : {}) }
          : {
              optionIndex,
              ...(mode === 'share' ? { authorName } : {}),
            };
      const url =
        mode === 'share'
          ? `/api/shares/${encodeURIComponent(String(shareToken || ''))}/decisions/${encodeURIComponent(mount.decisionId)}`
          : `/api/vaults/${vaultId}/notes/${noteId}/decisions/${encodeURIComponent(mount.decisionId)}`;
      const res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data.message || 'Failed to save decision'));
        return;
      }
      onDecisionsChange?.();
    } catch {
      setError('Failed to save decision');
    } finally {
      setBusy(false);
    }
  };

  const setLocked = async (next: boolean) => {
    if (mode !== 'editor' || !vaultId || noteId == null || !mount.decisionId) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/vaults/${vaultId}/notes/${noteId}/decisions/${encodeURIComponent(mount.decisionId)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locked: next }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data.message || 'Failed to update lock'));
        return;
      }
      onDecisionsChange?.();
    } catch {
      setError('Failed to update lock');
    } finally {
      setBusy(false);
    }
  };

  const historyModal =
    historyOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Decision history"
            onClick={() => setHistoryOpen(false)}
          >
            <div
              className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--text)]">Decision history</h3>
                <button type="button" className="btn-ghost text-sm" onClick={() => setHistoryOpen(false)}>
                  Close
                </button>
              </div>
              {historyEntries.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No history yet.</p>
              ) : (
                <ul className="synapse-decision-history">
                  {historyEntries.map((ev) => (
                    <li key={ev.id} className="synapse-decision-history-item">
                      <div className="synapse-decision-history-meta">
                        <span>
                          {ev.eventType} · {ev.actorLabel || ev.actorKind}
                        </span>
                        <span>{formatWhen(ev.createdAt)}</span>
                      </div>
                      {ev.payload?.choiceLabel ? (
                        <p className="synapse-decision-history-body">{ev.payload.choiceLabel}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return createPortal(
    <div className="synapse-decision-ui">
      <div className="synapse-decision-header">
        <p className="synapse-decision-title">{mount.title}</p>
        {locked ? <span className="synapse-decision-locked-badge">Locked</span> : null}
      </div>

      {!mount.decisionId && mode === 'editor' ? (
        <p className="synapse-decision-hint-text">Save the note to enable this decision.</p>
      ) : null}

      {decision?.choiceLabel ? (
        <p className="synapse-decision-current">
          <span className="synapse-decision-current-label">Current:</span>{' '}
          <strong>{decision.choiceLabel}</strong>
          {decision.authorName ? (
            <span className="synapse-decision-current-meta">
              {' '}
              · {decision.authorName}
              {decision.updatedAt ? ` · ${formatWhen(decision.updatedAt)}` : ''}
            </span>
          ) : null}
        </p>
      ) : (
        <p className="synapse-decision-empty">No decision yet.</p>
      )}

      {canMutate ? (
        <form
          className="synapse-decision-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveChoice();
          }}
        >
          <fieldset className="synapse-decision-options" disabled={busy}>
            <legend className="sr-only">Choose an option</legend>
            {mount.options.map((opt, i) => (
              <label key={`${i}:${opt}`} className="synapse-decision-option">
                <input
                  type="radio"
                  name={`decision-${mount.key}`}
                  checked={selected === 'option' && optionIndex === i}
                  onChange={() => {
                    setSelected('option');
                    setOptionIndex(i);
                  }}
                />
                <span>{opt}</span>
              </label>
            ))}
            <label className="synapse-decision-option">
              <input
                type="radio"
                name={`decision-${mount.key}`}
                checked={selected === 'other'}
                onChange={() => setSelected('other')}
              />
              <span>Other</span>
            </label>
          </fieldset>
          {selected === 'other' ? (
            <input
              className="input synapse-decision-custom"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              maxLength={8000}
              placeholder="Describe the decision…"
              aria-label="Custom decision"
              required
            />
          ) : null}
          {mode === 'share' ? (
            <input
              className="input synapse-decision-name"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              maxLength={128}
              placeholder="Name (optional)"
              aria-label="Your name (optional)"
            />
          ) : null}
          <button
            type="submit"
            className="btn-primary"
            disabled={
              busy ||
              (selected === 'other' ? !customText.trim() : mount.options.length === 0)
            }
          >
            {busy ? 'Saving…' : 'Save decision'}
          </button>
          {error ? <p className="synapse-decision-form-error">{error}</p> : null}
        </form>
      ) : null}

      {mode === 'editor' && mount.decisionId ? (
        <div className="synapse-decision-editor-actions">
          <button
            type="button"
            className="synapse-decision-btn"
            disabled={busy}
            onClick={() => void setLocked(!locked)}
          >
            {locked ? 'Unlock' : 'Lock'}
          </button>
          <button
            type="button"
            className="synapse-decision-btn"
            disabled={busy}
            onClick={() => setHistoryOpen(true)}
          >
            History
          </button>
          {error && !canMutate ? <p className="synapse-decision-form-error">{error}</p> : null}
        </div>
      ) : null}

      {historyModal}
    </div>,
    mount.el
  );
}

export default function DecisionBlockPortals({
  mounts,
  decisionsById = {},
  eventsByMarkerId = {},
  mode,
  shareToken,
  vaultId,
  noteId,
  onDecisionsChange,
}: DecisionBlockPortalsProps) {
  const onChange = useCallback(() => {
    onDecisionsChange?.();
  }, [onDecisionsChange]);

  if (!mounts.length) return null;
  return (
    <>
      {mounts.map((mount) => (
        <DecisionBlockPortalItem
          key={mount.key}
          mount={mount}
          decision={decisionsById[mount.decisionId] || null}
          events={eventsByMarkerId[mount.decisionId] || []}
          mode={mode}
          shareToken={shareToken}
          vaultId={vaultId}
          noteId={noteId}
          onDecisionsChange={onChange}
        />
      ))}
    </>
  );
}
