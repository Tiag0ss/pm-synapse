'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import UserAvatar from '@/components/UserAvatar';
import AppUserMenu from '@/components/AppUserMenu';

type Profile = {
  userId: number;
  username: string;
  email: string;
  isAdmin: boolean;
  pmUserId: number | null;
  hasPassword: boolean;
  authMethods: { local: boolean; sso: boolean };
};

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (!res.ok) {
        window.location.href = '/';
        return;
      }
      const json = await res.json();
      const p = json.data as Profile;
      setProfile(p);
      setUsername(p.username);
      setEmail(p.email);
    } catch {
      setError('Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveProfile = async () => {
    if (!profile) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const body: Record<string, string> = {};
      if (username.trim() !== profile.username) body.username = username.trim();
      if (!profile.authMethods.sso && email.trim().toLowerCase() !== profile.email.toLowerCase()) {
        body.email = email.trim();
      }
      if (!Object.keys(body).length) {
        setError('No profile changes to save');
        return;
      }
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Save failed');
        return;
      }
      setStatus('Profile saved');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (!profile) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (!newPassword) {
        setError('Enter a new password');
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('New passwords do not match');
        return;
      }
      const body: Record<string, string> = { newPassword };
      if (profile.hasPassword) {
        if (!currentPassword) {
          setError('Current password is required');
          return;
        }
        body.currentPassword = currentPassword;
      }
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.message || 'Password update failed');
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setStatus(profile.hasPassword ? 'Password updated' : 'Local password set');
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading || !profile) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[var(--muted)]">
        Loading profile…
      </main>
    );
  }

  const sso = profile.authMethods.sso;

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[var(--border)]/80 bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3.5">
          <Link href="/" className="text-sm font-semibold text-[var(--text)] no-underline hover:no-underline">
            ← Vaults
          </Link>
          <AppUserMenu user={profile} dense />
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center gap-4">
          <UserAvatar userId={profile.userId} name={profile.username} size="lg" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">My profile</h1>
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              Account details
              {sso ? ' · linked to Project Management' : ''}
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        {status && (
          <p className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
            {status}
          </p>
        )}

        {sso && (
          <div className="mt-6 rounded-xl border border-[color-mix(in_srgb,var(--accent)_30%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-4 py-3 text-sm text-[var(--muted)]">
            <p className="font-medium text-[var(--accent-soft)]">SSO account</p>
            <p className="mt-1 text-[13px] leading-relaxed">
              Your email comes from Project Management and cannot be changed here. Username may be
              refreshed on the next SSO sign-in. You can still set a local password to sign in
              without SSO.
            </p>
            {profile.pmUserId != null && (
              <p className="mt-2 font-mono text-[11px] text-[var(--muted)]">
                PM user #{profile.pmUserId}
              </p>
            )}
          </div>
        )}

        <section className="mt-8 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">Profile</h2>
          <label className="block text-sm">
            Username
            <input
              className="input mt-1 w-full"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label className="block text-sm">
            Email
            <input
              className="input mt-1 w-full"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={sso}
              autoComplete="email"
            />
            {sso && (
              <span className="mt-1 block text-[11px] text-[var(--muted)]">
                Managed by Project Management SSO
              </span>
            )}
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void saveProfile()}
          >
            Save profile
          </button>
        </section>

        <section className="mt-6 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">
            {profile.hasPassword ? 'Change password' : 'Set local password'}
          </h2>
          <p className="text-xs text-[var(--muted)]">
            {profile.hasPassword
              ? 'Update the password used for username/email sign-in.'
              : 'Optional local password so you can sign in without SSO.'}
          </p>
          {profile.hasPassword && (
            <label className="block text-sm">
              Current password
              <input
                className="input mt-1 w-full"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
          )}
          <label className="block text-sm">
            New password
            <input
              className="input mt-1 w-full"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="block text-sm">
            Confirm new password
            <input
              className="input mt-1 w-full"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void savePassword()}
          >
            {profile.hasPassword ? 'Update password' : 'Set password'}
          </button>
        </section>

        <section className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5">
          <h2 className="text-sm font-semibold text-[var(--text)]">Note templates</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Create personal templates and request admin approval to share them with everyone.
          </p>
          <Link
            href="/templates"
            className="btn-ghost mt-4 inline-flex no-underline hover:no-underline"
          >
            Manage templates
          </Link>
        </section>

        {profile.isAdmin && (
          <p className="mt-6 text-center text-sm text-[var(--muted)]">
            <Link href="/settings" className="text-[var(--accent-soft)]">
              Open admin settings
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
