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
  /** Render inside vault options Share tab (no overlay). */
  embedded?: boolean;
  /**
   * API root for members CRUD. Default `/api/vaults/{vaultId}`.
   * Admin settings uses `/api/settings/vaults/{vaultId}`.
   */
  membersBasePath?: string;
  /** Force manage UI (admin). Defaults to `isOwner`, and also follows API `accessRole`. */
  canManage?: boolean;
}

export default function VaultShareModal({
  open,
  vaultId,
  vaultName,
  isOwner,
  onClose,
  embedded = false,
  membersBasePath,
  canManage,
}: VaultShareModalProps) {
  const [owner, setOwner] = useState<MemberRow | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [accessRole, setAccessRole] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [role, setRole] = useState<'read' | 'edit'>('read');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const base = membersBasePath || `/api/vaults/${vaultId}`;
  const manage =
    canManage === true ||
    isOwner ||
    accessRole === 'owner';

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/members`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.message || 'Failed to load members');
        return;
      }
      setOwner(data.data.owner);
      setMembers(data.data.members || []);
      if (data.data.accessRole != null) {
        setAccessRole(String(data.data.accessRole));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStatus('');
    setQuery('');
    setHits([]);
    setAccessRole(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaultId, base]);

  useEffect(() => {
    if (!open || !manage) return;
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
  }, [query, open, manage]);

  if (!open) return null;

  const addMember = async (user: UserHit) => {
    setBusy(true);
    setStatus('');
    try {
      const res = await fetch(`${base}/members`, {
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
      setStatus(
        data.data?.pendingFirstLogin
          ? `Invited user#${user.pmUserId} (${role}) — they get access on first Synapse sign-in`
          : `Granted ${role} to ${user.username}`
      );
      await load();
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (pmUserId: number, next: 'read' | 'edit') => {
    setBusy(true);
    try {
      const res = await fetch(`${base}/members/${pmUserId}`, {
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
      const res = await fetch(`${base}/members/${pmUserId}`, {
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
  const rows: Array<MemberRow & { kind: 'owner' | 'member' }> = [
    ...(owner ? [{ ...owner, kind: 'owner' as const }] : []),
    ...members.map((m) => ({ ...m, kind: 'member' as const })),
  ];

  const body = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-5">
        <p className="text-sm text-[var(--muted)]">
          {vaultName} — <strong className="font-medium text-[var(--text)]">Read</strong> = wiki only;{' '}
          <strong className="font-medium text-[var(--text)]">Edit</strong> = vault + wiki.
        </p>

        {loading && rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--panel)]/80 text-[var(--muted)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 font-medium">Access</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-[var(--muted)]">
                      No people on this vault yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr
                      key={`${row.kind}-${row.pmUserId}`}
                      className="border-b border-[var(--border)]/60"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-[var(--text)]">{row.username}</div>
                        <div className="text-xs text-[var(--muted)]">{row.email || '—'}</div>
                      </td>
                      <td className="px-3 py-2">
                        {row.kind === 'owner' ? (
                          <span className="text-xs font-medium text-[var(--accent-soft)]">
                            Owner
                          </span>
                        ) : manage ? (
                          <select
                            className="input py-1 text-xs"
                            value={row.role}
                            disabled={busy}
                            onChange={(e) =>
                              void changeRole(row.pmUserId, e.target.value as 'read' | 'edit')
                            }
                          >
                            <option value="read">Wiki only (Read)</option>
                            <option value="edit">Vault + wiki (Edit)</option>
                          </select>
                        ) : (
                          <span className="text-xs capitalize text-[var(--muted)]">{row.role}</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.kind === 'owner' ? (
                          <span className="text-xs text-[var(--muted)]">Full access</span>
                        ) : manage ? (
                          <button
                            type="button"
                            className="btn-danger py-1 text-xs"
                            disabled={busy}
                            onClick={() => void removeMember(row.pmUserId)}
                          >
                            Remove
                          </button>
                        ) : (
                          <span className="text-xs text-[var(--muted)]">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {manage && (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
            <p className="text-sm font-semibold text-[var(--text)]">Add people</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Search signed-in users, or invite by Project Management user id before first Synapse
              login.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                className="input min-w-[12rem] flex-1"
                placeholder="Username, email, or PM user id…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                className="input w-auto"
                value={role}
                onChange={(e) => setRole(e.target.value as 'read' | 'edit')}
              >
                <option value="read">Wiki only (Read)</option>
                <option value="edit">Vault + wiki (Edit)</option>
              </select>
              {/^\d+$/.test(query.trim()) &&
                !memberIds.has(Number(query.trim())) &&
                Number(query.trim()) !== owner?.pmUserId && (
                  <button
                    type="button"
                    className="btn-primary py-1.5 text-xs"
                    disabled={busy}
                    onClick={() =>
                      void addMember({
                        pmUserId: Number(query.trim()),
                        username: `user#${query.trim()}`,
                        email: '',
                      })
                    }
                  >
                    Invite id {query.trim()}
                  </button>
                )}
            </div>
            {hits.length > 0 && (
              <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--border)]">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[var(--border)] bg-[var(--panel)]/80 text-[var(--muted)]">
                    <tr>
                      <th className="px-3 py-2 font-medium">User</th>
                      <th className="px-3 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((u) => {
                      const already =
                        memberIds.has(u.pmUserId) || u.pmUserId === owner?.pmUserId;
                      return (
                        <tr key={u.pmUserId} className="border-b border-[var(--border)]/60">
                          <td className="px-3 py-2">
                            <div className="font-medium">{u.username}</div>
                            <div className="text-xs text-[var(--muted)]">{u.email}</div>
                          </td>
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              className="btn-primary py-1 text-xs"
                              disabled={busy || already}
                              onClick={() => void addMember(u)}
                            >
                              {already ? 'Added' : 'Add'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!manage && (
          <p className="text-xs text-[var(--muted)]">
            Only the vault owner can change sharing. Ask the owner for Edit access if you need to
            manage members.
          </p>
        )}
      </div>

      {status && (
        <footer className="shrink-0 border-t border-[var(--border)] px-5 py-2 text-xs text-[var(--muted)]">
          {status}
        </footer>
      )}
    </div>
  );

  if (embedded) {
    return <div className="flex h-full min-h-0 flex-col overflow-hidden">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[min(720px,92vh)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Share vault</h2>
            <p className="mt-0.5 text-sm text-[var(--muted)]">{vaultName}</p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
      </div>
    </div>
  );
}
