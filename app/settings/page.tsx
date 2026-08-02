'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import ConfirmModal from '@/components/ConfirmModal';
import PromptModal from '@/components/PromptModal';

type Tab = 'general' | 'auth' | 'email' | 'pm' | 'users';

interface SettingsData {
  general: { siteName: string; allowPublicWikiDirectory: boolean };
  auth: { allowPublicRegistration: boolean; allowSsoLogin: boolean; minPasswordLength: number };
  email: {
    smtpHost: string;
    smtpPort: string;
    smtpSecure: boolean;
    smtpUser: string;
    smtpFrom: string;
    smtpFromName: string;
    hasSmtpPassword: boolean;
    smtpConfigured: boolean;
  };
  projectManagement: {
    pmBaseUrl: string;
    pmIntegrationEnabled: boolean;
    hasApiKey: boolean;
    apiKeyPrefix: string | null;
    apiKeyFromEnv: boolean;
  };
}

interface UserRow {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
  hasPassword: boolean;
  pmUserId: number | null;
  lastLoginAt: string | null;
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [data, setData] = useState<SettingsData | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);

  const [siteName, setSiteName] = useState('');
  const [allowWikiDir, setAllowWikiDir] = useState(true);
  const [allowReg, setAllowReg] = useState(true);
  const [allowSso, setAllowSso] = useState(true);
  const [minPass, setMinPass] = useState(8);
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpFrom, setSmtpFrom] = useState('');
  const [smtpFromName, setSmtpFromName] = useState('PM Synapse');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [clearSmtpPassword, setClearSmtpPassword] = useState(false);
  const [pmEnabled, setPmEnabled] = useState(true);
  const [pmApiKey, setPmApiKey] = useState('');
  const [clearPmApiKey, setClearPmApiKey] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [passwordUserId, setPasswordUserId] = useState<number | null>(null);
  const [deleteUserId, setDeleteUserId] = useState<number | null>(null);
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/settings/general', { credentials: 'include' });
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    const json = await res.json();
    if (!res.ok) {
      setError(json.message || 'Failed to load settings');
      setLoading(false);
      return;
    }
    const d = json.data as SettingsData;
    setData(d);
    setSiteName(d.general.siteName);
    setAllowWikiDir(d.general.allowPublicWikiDirectory);
    setAllowReg(d.auth.allowPublicRegistration);
    setAllowSso(d.auth.allowSsoLogin);
    setMinPass(d.auth.minPasswordLength);
    setSmtpHost(d.email.smtpHost);
    setSmtpPort(d.email.smtpPort);
    setSmtpSecure(d.email.smtpSecure);
    setSmtpUser(d.email.smtpUser);
    setSmtpFrom(d.email.smtpFrom);
    setSmtpFromName(d.email.smtpFromName);
    setPmEnabled(d.projectManagement.pmIntegrationEnabled);
    setLoading(false);
  }, []);

  const loadUsers = useCallback(async () => {
    const res = await fetch('/api/users', { credentials: 'include' });
    if (!res.ok) return;
    const json = await res.json();
    setUsers(json.data || []);
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (tab === 'users' && !forbidden) void loadUsers();
  }, [tab, forbidden, loadUsers]);

  const save = async (extra: Record<string, unknown> = {}) => {
    setStatus('');
    setError('');
    const body: Record<string, unknown> = {
      siteName,
      allowPublicWikiDirectory: allowWikiDir,
      allowPublicRegistration: allowReg,
      allowSsoLogin: allowSso,
      minPasswordLength: minPass,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpFrom,
      smtpFromName,
      pmIntegrationEnabled: pmEnabled,
      ...extra,
    };
    if (clearSmtpPassword) body.smtpPassword = '';
    else if (smtpPassword) body.smtpPassword = smtpPassword;
    if (clearPmApiKey) body.pmApiKey = '';
    else if (pmApiKey) body.pmApiKey = pmApiKey;

    const res = await fetch('/api/settings/general', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.message || 'Save failed');
      return;
    }
    setStatus(json.message || 'Saved');
    setSmtpPassword('');
    setClearSmtpPassword(false);
    setPmApiKey('');
    setClearPmApiKey(false);
    await loadSettings();
  };

  const testEmail = async () => {
    setStatus('');
    setError('');
    const res = await fetch('/api/settings/email/test', {
      method: 'POST',
      credentials: 'include',
    });
    const json = await res.json();
    if (!res.ok) setError(json.message || 'Test failed');
    else setStatus(json.message || 'Sent');
  };

  async function toggleAdmin(u: UserRow) {
    setError('');
    const res = await fetch(`/api/users/${u.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: !u.isAdmin }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.message || 'Update failed');
    else await loadUsers();
  }

  async function toggleActive(u: UserRow) {
    setError('');
    const res = await fetch(`/api/users/${u.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !u.isActive }),
    });
    const json = await res.json();
    if (!res.ok) setError(json.message || 'Update failed');
    else await loadUsers();
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[var(--muted)]">
        Loading settings…
      </main>
    );
  }

  if (forbidden) {
    return (
      <main className="mx-auto max-w-lg px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">Admin access required</h1>
        <Link href="/" className="mt-4 inline-block text-[var(--accent-soft)]">
          ← Back home
        </Link>
      </main>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'auth', label: 'Authentication' },
    { id: 'email', label: 'Email' },
    { id: 'pm', label: 'Project Management' },
    { id: 'users', label: 'Users' },
  ];

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-soft)]">
            Administration
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Settings</h1>
        </div>
        <Link href="/" className="btn-ghost no-underline hover:no-underline">
          ← Vaults
        </Link>
      </header>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-[var(--border)] pb-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === t.id
                ? 'bg-[var(--surface-2)] text-[var(--text)]'
                : 'text-[var(--muted)] hover:text-[var(--text)]'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {status && (
        <p className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
          {status}
        </p>
      )}

      {tab === 'general' && (
        <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <label className="block text-sm">
            Site name
            <input className="input mt-1 w-full" value={siteName} onChange={(e) => setSiteName(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowWikiDir} onChange={(e) => setAllowWikiDir(e.target.checked)} />
            Show public wiki directory (/w)
          </label>
          <button type="button" className="btn-primary" onClick={() => void save()}>
            Save
          </button>
        </section>
      )}

      {tab === 'auth' && (
        <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowReg} onChange={(e) => setAllowReg(e.target.checked)} />
            Allow public registration
          </label>
          <p className="text-xs text-[var(--muted)]">
            When disabled, only admins can create users (first user on a fresh install can always
            register).
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowSso} onChange={(e) => setAllowSso(e.target.checked)} />
            Allow Sign in with Project Management
          </label>
          <label className="block text-sm">
            Minimum password length
            <input
              className="input mt-1 w-24"
              type="number"
              min={6}
              max={128}
              value={minPass}
              onChange={(e) => setMinPass(Number(e.target.value))}
            />
          </label>
          <button type="button" className="btn-primary" onClick={() => void save()}>
            Save
          </button>
        </section>
      )}

      {tab === 'email' && (
        <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <p className="text-xs text-[var(--muted)]">
            SMTP is required for password reset emails.
            {data?.email.smtpConfigured ? ' Status: configured.' : ' Status: incomplete.'}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm sm:col-span-2">
              Host
              <input className="input mt-1 w-full" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
            </label>
            <label className="block text-sm">
              Port
              <input className="input mt-1 w-full" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 self-end text-sm pb-2">
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
              Use TLS/SSL
            </label>
            <label className="block text-sm">
              Username
              <input className="input mt-1 w-full" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
            </label>
            <label className="block text-sm">
              Password {data?.email.hasSmtpPassword ? '(saved)' : ''}
              <input
                className="input mt-1 w-full"
                type="password"
                placeholder={data?.email.hasSmtpPassword ? '••••••••' : ''}
                value={smtpPassword}
                onChange={(e) => {
                  setSmtpPassword(e.target.value);
                  setClearSmtpPassword(false);
                }}
              />
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={clearSmtpPassword}
                onChange={(e) => {
                  setClearSmtpPassword(e.target.checked);
                  if (e.target.checked) setSmtpPassword('');
                }}
              />
              Clear stored SMTP password
            </label>
            <label className="block text-sm">
              From email
              <input className="input mt-1 w-full" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} />
            </label>
            <label className="block text-sm">
              From name
              <input
                className="input mt-1 w-full"
                value={smtpFromName}
                onChange={(e) => setSmtpFromName(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn-ghost" onClick={() => void testEmail()}>
              Send test email
            </button>
          </div>
        </section>
      )}

      {tab === 'pm' && (
        <section className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pmEnabled} onChange={(e) => setPmEnabled(e.target.checked)} />
            Enable Project Management integration
          </label>
          <label className="block text-sm">
            PM base URL (from environment)
            <input className="input mt-1 w-full opacity-70" readOnly value={data?.projectManagement.pmBaseUrl || ''} />
          </label>
          <label className="block text-sm">
            Instance API key{' '}
            {data?.projectManagement.hasApiKey
              ? `(${data.projectManagement.apiKeyPrefix}${data.projectManagement.apiKeyFromEnv ? ' via env' : ''})`
              : ''}
            <input
              className="input mt-1 w-full"
              type="password"
              placeholder={data?.projectManagement.hasApiKey ? '••••••••' : 'pt_…'}
              value={pmApiKey}
              onChange={(e) => {
                setPmApiKey(e.target.value);
                setClearPmApiKey(false);
              }}
            />
          </label>
          <p className="text-xs text-[var(--muted)]">
            Create a personal API token in Project Management → Administration → API Tokens. Used when
            the signed-in user has no SSO token (local login).
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={clearPmApiKey}
              onChange={(e) => {
                setClearPmApiKey(e.target.checked);
                if (e.target.checked) setPmApiKey('');
              }}
            />
            Clear stored API key
          </label>
          <button type="button" className="btn-primary" onClick={() => void save()}>
            Save
          </button>
        </section>
      )}

      {tab === 'users' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-xl text-xs text-[var(--muted)]">
              Sync pulls accounts from Project Management (admin API). New users are SSO-ready with no
              local password; existing Synapse users are linked by PM id or email.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={syncBusy}
                title="Import and link users from Project Management"
                onClick={() => setSyncConfirmOpen(true)}
              >
                {syncBusy ? 'Syncing…' : 'Sync from PM'}
              </button>
              <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
                Create user
              </button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="border-b border-[var(--border)] bg-[var(--panel)]/80 text-[var(--muted)]">
                <tr>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Flags</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-[var(--border)]/60">
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.username}</div>
                      <div className="text-xs text-[var(--muted)]">{u.email}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--muted)]">
                      {u.isAdmin ? 'admin · ' : ''}
                      {u.isActive ? 'active' : 'disabled'}
                      {u.hasPassword ? '' : ' · SSO-only'}
                      {u.pmUserId != null ? ` · PM #${u.pmUserId}` : ''}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => void toggleAdmin(u)}
                        >
                          {u.isAdmin ? 'Revoke admin' : 'Make admin'}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => void toggleActive(u)}
                        >
                          {u.isActive ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => setPasswordUserId(u.id)}
                        >
                          Set password
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs text-red-300"
                          onClick={() => setDeleteUserId(u.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Create user</h2>
            <div className="mt-4 space-y-3">
              <input
                className="input w-full"
                placeholder="Username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
              />
              <input
                className="input w-full"
                type="email"
                placeholder="Email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
              <input
                className="input w-full"
                type="password"
                placeholder="Password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={newIsAdmin} onChange={(e) => setNewIsAdmin(e.target.checked)} />
                Admin
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={async () => {
                  setError('');
                  const res = await fetch('/api/users', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      username: newUsername,
                      email: newEmail,
                      password: newPassword,
                      isAdmin: newIsAdmin,
                    }),
                  });
                  const json = await res.json();
                  if (!res.ok) {
                    setError(json.message || 'Create failed');
                    return;
                  }
                  setCreateOpen(false);
                  setNewUsername('');
                  setNewEmail('');
                  setNewPassword('');
                  setNewIsAdmin(false);
                  setStatus('User created');
                  await loadUsers();
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <PromptModal
        open={passwordUserId != null}
        title="Set password"
        label="New password"
        confirmLabel="Save"
        inputType="password"
        onCancel={() => setPasswordUserId(null)}
        onConfirm={async (value) => {
          if (passwordUserId == null) return;
          const res = await fetch(`/api/users/${passwordUserId}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: value }),
          });
          const json = await res.json();
          if (!res.ok) {
            setError(json.message || 'Failed');
            return;
          }
          setStatus('Password updated');
          setPasswordUserId(null);
          await loadUsers();
        }}
      />

      <ConfirmModal
        open={deleteUserId != null}
        title="Delete user?"
        message="This cannot be undone. The user must not own any vaults."
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteUserId(null)}
        onConfirm={async () => {
          if (deleteUserId == null) return;
          const res = await fetch(`/api/users/${deleteUserId}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          const json = await res.json();
          if (!res.ok) {
            setError(json.message || 'Delete failed');
            setDeleteUserId(null);
            return;
          }
          setStatus('User deleted');
          setDeleteUserId(null);
          await loadUsers();
        }}
      />

      <ConfirmModal
        open={syncConfirmOpen}
        title="Sync users from Project Management"
        message="Import PM users into Synapse. Matched by PM user id or email. New accounts are SSO-ready (no local password). Existing Synapse-only users are not deleted. Requires a PM admin token or API key."
        confirmLabel={syncBusy ? 'Syncing…' : 'Sync now'}
        cancelLabel="Cancel"
        onCancel={() => {
          if (!syncBusy) setSyncConfirmOpen(false);
        }}
        onConfirm={async () => {
          if (syncBusy) return;
          setSyncBusy(true);
          setError('');
          setStatus('');
          try {
            const res = await fetch('/api/users/sync-from-pm', {
              method: 'POST',
              credentials: 'include',
            });
            const json = await res.json();
            if (!res.ok) {
              setError(json.message || 'Sync failed');
              return;
            }
            const d = json.data as {
              created?: number;
              updated?: number;
              linked?: number;
              skipped?: number;
              failed?: number;
            };
            setStatus(
              json.message ||
                `Created ${d.created ?? 0}, updated ${d.updated ?? 0}, linked ${d.linked ?? 0}, skipped ${d.skipped ?? 0}, failed ${d.failed ?? 0}`
            );
            setSyncConfirmOpen(false);
            await loadUsers();
          } finally {
            setSyncBusy(false);
          }
        }}
      />
    </main>
  );
}
