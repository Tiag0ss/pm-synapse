'use client';

import { useEffect, useState } from 'react';

interface MemberRow {
  pmUserId: number;
  username: string;
  email: string;
  role: 'owner' | 'read' | 'edit';
  createdAt?: string;
}

interface UserHit {
  pmUserId: number;
  username: string;
  email: string;
}

interface VaultShareModalProps {
  open: boolean;
  vaultId: string;
  vaultName: string;
  isOwner: boolean;
  onClose: () => void;
  /** Render as a panel inside Vault options (no overlay chrome). */
  embedded?: boolean;
}

export default function VaultShareModal({
  open,
  vaultId,
  vaultName,
  isOwner,
  onClose,
  embedded = false,
}: VaultShareModalProps) {
  const [owner, setOwner] = useState<MemberRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [role, setRole] = useState<'read' | 'edit'>('read');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await fetch(`/api/vaults/${vaultId}/members`, { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.message || 'Failed to load members');
      return;
    }
    setOwner(data.data.owner);
    setMembers(data.data.members || []);
  };

  useEffect(() => {
    if (!open) return;
    setStatus('');
    setQuery('');
    setHits([]);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaultId]);

  useEffect(() => {
    if (!open || !isOwner) return;
    const q = query.trim();
    if (q.length < 1) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void (async () => {
        const res = await fetch(`/api/vaults/users/search?q=${encodeURIComponent(q)}`, {
          credentials: 'include',
        });
        const data = await res.json();
        if (res.ok) setHits(data.data || []);
      })();
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, open, isOwner]);

  if (!open) return null;

  const addMember = async (user: UserHit) => {
    setBusy(true);
    setStatus('');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/members`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pmUserId: user.pmUserId, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.message || 'Could not add member');
        return;
      }
      setQuery('');
      setHits([]);
      setStatus(`Granted ${role} to ${user.username}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (pmUserId: number, next: 'read' | 'edit') => {
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/members/${pmUserId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      });
      const data = await res.json();
      if (!res.ok) setStatus(data.message || 'Update failed');
      else await load();
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (pmUserId: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/members/${pmUserId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) setStatus(data.message || 'Remove failed');
      else await load();
    } finally {
      setBusy(false);
    }
  };

  const memberIds = new Set(members.map((m) => m.pmUserId));

  if (!open) return null;

  const body = (
    <>
        {!embedded && (
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Share vault</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {vaultName} — invite Synapse users with read or edit access.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        )}

        <div className={`min-h-0 flex-1 space-y-4 overflow-auto ${embedded ? 'p-5' : 'p-5'}`}>
          {embedded && (
            <p className="text-sm text-[var(--muted)]">
              Invite Synapse users with read or edit access to this vault.
            </p>
          )}
          {owner && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 px-3 py-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Owner
              </p>
              <p className="mt-1 text-sm font-medium">{owner.username}</p>
              <p className="text-xs text-[var(--muted)]">{owner.email}</p>
            </div>
          )}

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Members
            </p>
            {members.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--muted)]">
                No shared members yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {members.map((m) => (
                  <li
                    key={m.pmUserId}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{m.username}</p>
                      <p className="truncate text-xs text-[var(--muted)]">{m.email}</p>
                    </div>
                    {isOwner ? (
                      <>
                        <select
                          className="input py-1 text-xs"
                          value={m.role}
                          disabled={busy}
                          onChange={(e) =>
                            void changeRole(m.pmUserId, e.target.value as 'read' | 'edit')
                          }
                        >
                          <option value="read">Read</option>
                          <option value="edit">Edit</option>
                        </select>
                        <button
                          type="button"
                          className="btn-danger py-1 text-xs"
                          disabled={busy}
                          onClick={() => void removeMember(m.pmUserId)}
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <span className="rounded-md bg-[var(--surface-2)] px-2 py-1 text-xs capitalize text-[var(--muted)]">
                        {m.role}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {isOwner && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/50 p-3">
              <p className="text-sm font-semibold">Add people</p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                They must have signed into Synapse at least once.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  className="input min-w-[12rem] flex-1"
                  placeholder="Search username or email…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="input w-auto"
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'read' | 'edit')}
                >
                  <option value="read">Read</option>
                  <option value="edit">Edit</option>
                </select>
              </div>
              {hits.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-auto rounded-lg border border-[var(--border)]">
                  {hits.map((u) => {
                    const already = memberIds.has(u.pmUserId);
                    return (
                      <li
                        key={u.pmUserId}
                        className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 last:border-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm">{u.username}</p>
                          <p className="truncate text-xs text-[var(--muted)]">{u.email}</p>
                        </div>
                        <button
                          type="button"
                          className="btn-primary py-1 text-xs"
                          disabled={busy || already}
                          onClick={() => void addMember(u)}
                        >
                          {already ? 'Added' : 'Add'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {status && (
          <footer className="shrink-0 border-t border-[var(--border)] px-5 py-2 text-xs text-[var(--muted)]">
            {status}
          </footer>
        )}
    </>
  );

  if (embedded) {
    return <div className="flex h-full min-h-0 flex-col overflow-hidden">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[min(640px,90vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        {body}
      </div>
    </div>
  );
}
