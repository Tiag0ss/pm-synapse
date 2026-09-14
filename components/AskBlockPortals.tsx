'use client';

import { createPortal } from 'react-dom';
import { useCallback, useMemo, useState } from 'react';
import ConfirmModal from '@/components/ConfirmModal';
import {
  clearAskGuestEditToken,
  getAskGuestEditToken,
  setAskGuestEditToken,
} from '@/lib/askGuestEditTokens';

export type AskAnswerView = {
  id: number;
  body: string;
  authorName: string;
  status: 'pending' | 'approved' | 'rejected' | string;
  createdAt: string;
  deletedAt?: string | null;
};

export type AskAnswerEventView = {
  id: number;
  answerId: number;
  eventType: 'submitted' | 'approved' | 'unapproved' | 'rejected' | 'deleted' | 'edited' | string;
  actorKind: string;
  actorLabel: string;
  payload?: {
    body?: string;
    authorName?: string;
    fromStatus?: string;
    toStatus?: string;
    previousBody?: string;
  };
  createdAt: string;
};

export type AskBlockMount = {
  key: string;
  el: HTMLElement;
  askId: string;
  question: string;
};

export function collectAskBlockMounts(root: HTMLElement): AskBlockMount[] {
  const nodes = root.querySelectorAll<HTMLElement>('.synapse-ask');
  const mounts: AskBlockMount[] = [];
  nodes.forEach((el, i) => {
    const askId = String(el.getAttribute('data-ask-id') || '').trim();
    const question = String(el.getAttribute('data-ask-question') || 'Question').trim();
    mounts.push({
      key: `ask-${askId || 'x'}-${i}`,
      el,
      askId,
      question,
    });
  });
  return mounts;
}

type AskBlockPortalsProps = {
  mounts: AskBlockMount[];
  answersByAskId?: Record<string, AskAnswerView[]>;
  deletedAnswersByAskId?: Record<string, AskAnswerView[]>;
  eventsByAnswerId?: Record<string, AskAnswerEventView[]>;
  mode: 'share' | 'editor' | 'readonly';
  shareToken?: string;
  vaultId?: string | number;
  noteId?: number;
  onAnswersChange?: () => void;
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

function AskBlockPortalItem({
  mount,
  answers,
  deletedAnswers,
  eventsByAnswerId,
  mode,
  shareToken,
  vaultId,
  noteId,
  onAnswersChange,
}: {
  mount: AskBlockMount;
  answers: AskAnswerView[];
  deletedAnswers: AskAnswerView[];
  eventsByAnswerId: Record<string, AskAnswerEventView[]>;
  mode: 'share' | 'editor' | 'readonly';
  shareToken?: string;
  vaultId?: string | number;
  noteId?: number;
  onAnswersChange?: () => void;
}) {
  const [authorName, setAuthorName] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editBody, setEditBody] = useState('');
  const [editAuthorName, setEditAuthorName] = useState('');
  const [ownedTick, setOwnedTick] = useState(0);
  const [replyOpen, setReplyOpen] = useState(false);
  const [hintHtml] = useState(() => {
    const hint = mount.el.querySelector('.synapse-ask-hint');
    const html = hint?.innerHTML || '';
    mount.el.replaceChildren();
    return html;
  });

  const visibleAnswers = useMemo(() => {
    if (mode === 'readonly') {
      return answers.filter((a) => a.status === 'approved' && !a.deletedAt);
    }
    return answers.filter((a) => !a.deletedAt);
  }, [answers, mode]);

  const historyEntries = useMemo(() => {
    const ids = new Set<number>();
    for (const a of answers) ids.add(a.id);
    for (const a of deletedAnswers) ids.add(a.id);
    const events: AskAnswerEventView[] = [];
    for (const id of ids) {
      const list = eventsByAnswerId[String(id)] || [];
      events.push(...list);
    }
    return events.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }, [answers, deletedAnswers, eventsByAnswerId]);

  const canGuestMutate = (answer: AskAnswerView): boolean => {
    if (mode !== 'share' || !shareToken || answer.status !== 'pending' || answer.deletedAt) {
      return false;
    }
    void ownedTick;
    return Boolean(getAskGuestEditToken(shareToken, answer.id));
  };

  const submitShare = async () => {
    if (!shareToken || !mount.askId || busy) return;
    const trimmed = body.trim();
    if (!trimmed) {
      setError('Write an answer first');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/shares/${encodeURIComponent(shareToken)}/asks/${encodeURIComponent(mount.askId)}/answers`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: trimmed,
            authorName: authorName.trim() || undefined,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || 'Failed to submit');
        return;
      }
      const answerId = Number(data.data?.id);
      const guestEditToken = String(data.data?.guestEditToken || '');
      if (answerId > 0 && guestEditToken) {
        setAskGuestEditToken(shareToken, answerId, guestEditToken);
        setOwnedTick((n) => n + 1);
      }
      setBody('');
      setReplyOpen(false);
      onAnswersChange?.();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const patchStatus = async (
    answerId: number,
    status: 'approved' | 'pending' | 'rejected'
  ) => {
    if (!vaultId || !noteId || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/ask-answers/${answerId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || 'Update failed');
        return;
      }
      onAnswersChange?.();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const deleteAnswer = async (answerId: number) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'share' && shareToken && mount.askId) {
        const guestEditToken = getAskGuestEditToken(shareToken, answerId);
        if (!guestEditToken) {
          setError('You can only delete your own pending answers from this browser');
          return;
        }
        const res = await fetch(
          `/api/shares/${encodeURIComponent(shareToken)}/asks/${encodeURIComponent(mount.askId)}/answers/${answerId}`,
          {
            method: 'DELETE',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ guestEditToken }),
          }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.message || 'Delete failed');
          return;
        }
        clearAskGuestEditToken(shareToken, answerId);
        setOwnedTick((n) => n + 1);
      } else if (vaultId && noteId) {
        const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/ask-answers/${answerId}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.message || 'Delete failed');
          return;
        }
      } else {
        return;
      }
      setConfirmDeleteId(null);
      setEditingId(null);
      onAnswersChange?.();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const startGuestEdit = (a: AskAnswerView) => {
    setReplyOpen(false);
    setEditingId(a.id);
    setEditBody(a.body);
    setEditAuthorName(a.authorName === 'Anonymous' ? '' : a.authorName);
    setError('');
  };

  const openReply = () => {
    setEditingId(null);
    setReplyOpen(true);
    setError('');
  };

  const closeReply = () => {
    setReplyOpen(false);
    setBody('');
    setError('');
  };

  const saveGuestEdit = async (answerId: number) => {
    if (!shareToken || !mount.askId || busy) return;
    const guestEditToken = getAskGuestEditToken(shareToken, answerId);
    if (!guestEditToken) {
      setError('You can only edit your own pending answers from this browser');
      return;
    }
    const trimmed = editBody.trim();
    if (!trimmed) {
      setError('Write an answer first');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(
        `/api/shares/${encodeURIComponent(shareToken)}/asks/${encodeURIComponent(mount.askId)}/answers/${answerId}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: trimmed,
            authorName: editAuthorName.trim() || undefined,
            guestEditToken,
          }),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || 'Update failed');
        return;
      }
      setEditingId(null);
      onAnswersChange?.();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const eventLabel = (ev: AskAnswerEventView) => {
    switch (ev.eventType) {
      case 'submitted':
        return `Submitted by ${ev.actorLabel}`;
      case 'edited':
        return `Edited by ${ev.actorLabel}`;
      case 'approved':
        return `Approved by ${ev.actorLabel}`;
      case 'rejected':
        return `Rejected by ${ev.actorLabel}`;
      case 'unapproved':
        return `Unapproved by ${ev.actorLabel}`;
      case 'deleted':
        return `Deleted by ${ev.actorLabel}`;
      default:
        return `${ev.eventType} · ${ev.actorLabel}`;
    }
  };

  const confirmMessage =
    mode === 'share'
      ? 'This removes your pending answer from the shared note.'
      : 'This hides the answer from shares and the wiki. History is kept.';

  return createPortal(
    <div className="synapse-ask-ui">
      <div className="synapse-ask-question-row">
        <div className="synapse-ask-question">{mount.question}</div>
        {mode === 'share' && mount.askId && editingId == null && !replyOpen ? (
          <button type="button" className="synapse-ask-reply-toggle" onClick={openReply}>
            Reply
          </button>
        ) : null}
      </div>
      {hintHtml ? (
        <div className="synapse-ask-hint" dangerouslySetInnerHTML={{ __html: hintHtml }} />
      ) : null}
      {!mount.askId && mode === 'editor' ? (
        <p className="synapse-ask-hint-text">Save the note to enable answers for this question.</p>
      ) : null}

      {mode === 'share' && mount.askId && editingId == null && replyOpen ? (
        <form
          className="synapse-ask-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitShare();
          }}
        >
          <input
            className="input synapse-ask-form-name"
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            maxLength={128}
            placeholder="Name (optional)"
            autoComplete="nickname"
            aria-label="Your name (optional)"
          />
          <textarea
            className="input synapse-ask-form-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={8000}
            rows={1}
            required
            placeholder="Write a reply…"
            aria-label="Your answer"
            autoFocus
          />
          <button type="submit" className="btn-primary" disabled={busy || !body.trim()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button type="button" className="synapse-ask-btn" disabled={busy} onClick={closeReply}>
            Cancel
          </button>
          {error ? <p className="synapse-ask-form-error">{error}</p> : null}
        </form>
      ) : null}

      {visibleAnswers.length > 0 ? <hr className="synapse-ask-rule" /> : null}

      <ul className="synapse-ask-answers">
        {visibleAnswers.length === 0 ? (
          mode === 'share' ? null : (
            <li className="synapse-ask-empty">
              {mode === 'readonly' ? 'No approved answers yet.' : 'No answers yet.'}
            </li>
          )
        ) : (
          visibleAnswers.map((a) => (
            <li key={a.id} className={`synapse-ask-answer is-${a.status}`}>
              {editingId === a.id && mode === 'share' ? (
                <form
                  className="synapse-ask-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveGuestEdit(a.id);
                  }}
                >
                  <input
                    className="input synapse-ask-form-name"
                    value={editAuthorName}
                    onChange={(e) => setEditAuthorName(e.target.value)}
                    maxLength={128}
                    placeholder="Name (optional)"
                    aria-label="Your name (optional)"
                  />
                  <textarea
                    className="input synapse-ask-form-body"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    maxLength={8000}
                    rows={1}
                    required
                    aria-label="Your answer"
                    placeholder="Write a reply…"
                  />
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={busy || !editBody.trim()}
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="synapse-ask-btn"
                    disabled={busy}
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className="synapse-ask-answer-meta">
                    <span className="synapse-ask-author">{a.authorName || 'Anonymous'}</span>
                    <span className="synapse-ask-when">{formatWhen(a.createdAt)}</span>
                    {mode !== 'readonly' ? (
                      <span className={`synapse-ask-status is-${a.status}`}>{a.status}</span>
                    ) : null}
                    {mode === 'editor' ? (
                      <span className="synapse-ask-actions">
                        {a.status !== 'approved' ? (
                          <button
                            type="button"
                            className="synapse-ask-btn"
                            disabled={busy}
                            onClick={() => void patchStatus(a.id, 'approved')}
                          >
                            Approve
                          </button>
                        ) : null}
                        {a.status !== 'pending' ? (
                          <button
                            type="button"
                            className="synapse-ask-btn"
                            disabled={busy}
                            onClick={() => void patchStatus(a.id, 'pending')}
                          >
                            Pending
                          </button>
                        ) : null}
                        {a.status !== 'rejected' ? (
                          <button
                            type="button"
                            className="synapse-ask-btn synapse-ask-btn-danger"
                            disabled={busy}
                            onClick={() => void patchStatus(a.id, 'rejected')}
                          >
                            Reject
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="synapse-ask-btn synapse-ask-btn-danger"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(a.id)}
                        >
                          Delete
                        </button>
                      </span>
                    ) : null}
                    {canGuestMutate(a) ? (
                      <span className="synapse-ask-actions">
                        <button
                          type="button"
                          className="synapse-ask-btn"
                          disabled={busy}
                          onClick={() => startGuestEdit(a)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="synapse-ask-btn synapse-ask-btn-danger"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(a.id)}
                        >
                          Delete
                        </button>
                      </span>
                    ) : null}
                  </div>
                  <p className="synapse-ask-body">{a.body}</p>
                </>
              )}
            </li>
          ))
        )}
      </ul>

      {visibleAnswers.length > 0 ? <hr className="synapse-ask-rule" /> : null}

      {mode === 'share' && error && editingId != null ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : null}

      {mode === 'editor' ? (
        <div className="synapse-ask-history-wrap">
          <button
            type="button"
            className="synapse-ask-btn"
            onClick={() => setHistoryOpen(true)}
          >
            History
          </button>
          {error ? <p className="mt-1 text-sm text-[var(--danger)]">{error}</p> : null}
        </div>
      ) : null}

      {historyOpen && mode === 'editor'
        ? createPortal(
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setHistoryOpen(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setHistoryOpen(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={`History: ${mount.question}`}
                className="flex max-h-[min(80vh,36rem)] w-full max-w-lg flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-2xl shadow-black/40 sm:p-5"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold tracking-tight text-[var(--text)]">
                      Answer history
                    </h2>
                    <p className="mt-0.5 truncate text-sm text-[var(--muted)]">{mount.question}</p>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost shrink-0 py-1 text-xs"
                    onClick={() => setHistoryOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <ul className="synapse-ask-history min-h-0 flex-1 overflow-auto">
                  {historyEntries.length === 0 ? (
                    <li className="synapse-ask-empty">No history yet.</li>
                  ) : (
                    historyEntries.map((ev) => (
                      <li key={ev.id} className={`synapse-ask-history-item is-${ev.eventType}`}>
                        <div className="synapse-ask-history-meta">
                          <span>{eventLabel(ev)}</span>
                          <span className="synapse-ask-when">{formatWhen(ev.createdAt)}</span>
                        </div>
                        {ev.payload?.body ? (
                          <p className="synapse-ask-body synapse-ask-history-body">{ev.payload.body}</p>
                        ) : null}
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>,
            document.body
          )
        : null}

      <ConfirmModal
        open={confirmDeleteId != null}
        title="Delete answer?"
        message={confirmMessage}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (confirmDeleteId != null) void deleteAnswer(confirmDeleteId);
        }}
      />
    </div>,
    mount.el
  );
}

export default function AskBlockPortals({
  mounts,
  answersByAskId = {},
  deletedAnswersByAskId = {},
  eventsByAnswerId = {},
  mode,
  shareToken,
  vaultId,
  noteId,
  onAnswersChange,
}: AskBlockPortalsProps) {
  const onChange = useCallback(() => {
    onAnswersChange?.();
  }, [onAnswersChange]);

  if (!mounts.length) return null;
  return (
    <>
      {mounts.map((mount) => (
        <AskBlockPortalItem
          key={mount.key}
          mount={mount}
          answers={answersByAskId[mount.askId] || []}
          deletedAnswers={deletedAnswersByAskId[mount.askId] || []}
          eventsByAnswerId={eventsByAnswerId}
          mode={mode}
          shareToken={shareToken}
          vaultId={vaultId}
          noteId={noteId}
          onAnswersChange={onChange}
        />
      ))}
    </>
  );
}
