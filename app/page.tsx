'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Me {
  userId: number;
  username: string;
  email: string;
  isAdmin: boolean;
}

interface Vault {
  Id: number;
  Name: string;
  slug: string;
  Description?: string;
  PmProjectId?: number | null;
  AccessRole?: 'owner' | 'edit' | 'read';
}

interface Providers {
  siteName: string;
  allowPublicRegistration: boolean;
  allowSsoLogin: boolean;
  ssoConfigured: boolean;
  passwordResetAvailable: boolean;
  hasUsers: boolean;
}

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [name, setName] = useState('');
  const [defaultVisibility, setDefaultVisibility] = useState('private');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const provRes = await fetch('/api/auth/providers', { credentials: 'include' });
      if (provRes.ok) {
        const provJson = await provRes.json();
        setProviders(provJson.data);
      }
      const meRes = await fetch('/api/auth/me', { credentials: 'include' });
      if (!meRes.ok) {
        setMe(null);
        setLoading(false);
        return;
      }
      const meJson = await meRes.json();
      setMe(meJson.data);
      const vRes = await fetch('/api/vaults', { credentials: 'include' });
      const vJson = await vRes.json();
      setVaults(vJson.data || []);
    } catch {
      setError('Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createVault = async () => {
    if (!name.trim()) return;
    const res = await fetch('/api/vaults', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, defaultVisibility }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message || 'Failed to create vault');
      return;
    }
    setName('');
    setDefaultVisibility('private');
    await load();
  };

  const submitLogin = async () => {
    setAuthBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Login failed');
        return;
      }
      window.location.href = '/';
    } catch {
      setError('Login failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const submitRegister = async () => {
    setAuthBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: regUsername,
          email: regEmail,
          password: regPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Registration failed');
        return;
      }
      window.location.href = '/';
    } catch {
      setError('Registration failed');
    } finally {
      setAuthBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[var(--muted)]">
        Loading workspace…
      </main>
    );
  }

  const siteName = providers?.siteName || 'PM Synapse';

  if (!me) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center px-6 py-10">
        <div className="absolute inset-0 overflow-hidden" aria-hidden>
          <div className="absolute -left-24 top-20 h-72 w-72 rounded-full bg-teal-500/10 blur-3xl" />
          <div className="absolute -right-16 bottom-16 h-80 w-80 rounded-full bg-sky-500/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)]/80 p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-soft)]">
            Knowledge vaults
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">{siteName}</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--muted)]">
            Markdown notes with wikilinks, backlinks, and optional Project Management integration.
          </p>

          {error && (
            <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          {mode === 'login' ? (
            <form
              className="mt-6 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitLogin();
              }}
            >
              <input
                className="input w-full"
                placeholder="Username or email"
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
              />
              <input
                className="input w-full"
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="submit" className="btn-primary w-full" disabled={authBusy}>
                {authBusy ? 'Signing in…' : 'Sign in'}
              </button>
              {providers?.passwordResetAvailable && (
                <Link
                  href="/forgot-password"
                  className="block text-center text-sm text-[var(--accent-soft)] no-underline hover:underline"
                >
                  Forgot password?
                </Link>
              )}
            </form>
          ) : (
            <form
              className="mt-6 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitRegister();
              }}
            >
              <input
                className="input w-full"
                placeholder="Username"
                autoComplete="username"
                value={regUsername}
                onChange={(e) => setRegUsername(e.target.value)}
              />
              <input
                className="input w-full"
                type="email"
                placeholder="Email"
                autoComplete="email"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
              />
              <input
                className="input w-full"
                type="password"
                placeholder="Password"
                autoComplete="new-password"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
              />
              <button type="submit" className="btn-primary w-full" disabled={authBusy}>
                {authBusy ? 'Creating…' : 'Create account'}
              </button>
            </form>
          )}

          {providers?.allowPublicRegistration && (
            <button
              type="button"
              className="mt-4 w-full text-sm text-[var(--muted)] hover:text-[var(--text)]"
              onClick={() => {
                setError('');
                setMode(mode === 'login' ? 'register' : 'login');
              }}
            >
              {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
            </button>
          )}

          {providers?.allowSsoLogin && (
            <>
              <div className="my-5 flex items-center gap-3 text-xs text-[var(--muted)]">
                <div className="h-px flex-1 bg-[var(--border)]" />
                or
                <div className="h-px flex-1 bg-[var(--border)]" />
              </div>
              <a
                href="/api/auth/sso/start"
                className="btn-ghost inline-flex w-full justify-center no-underline hover:no-underline"
              >
                Sign in with Project Management
              </a>
              <p className="mt-2 text-center text-[11px] text-[var(--muted)]">
                Same email as in Project Management links your accounts.
              </p>
            </>
          )}

          <Link
            href="/w"
            className="mt-6 block text-center text-sm text-[var(--accent-soft)] no-underline hover:underline"
          >
            Browse public wikis →
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-soft)]">
            {siteName}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your vaults</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Signed in as <span className="text-[var(--text)]">{me.username}</span> · {me.email}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {me.isAdmin && (
            <Link href="/settings" className="btn-ghost no-underline hover:no-underline">
              Settings
            </Link>
          )}
          <Link href="/w" className="btn-ghost no-underline hover:no-underline">
            Public wikis
          </Link>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
              window.location.href = '/';
            }}
          >
            Log out
          </button>
        </div>
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5 shadow-lg shadow-black/20 backdrop-blur">
        <h2 className="text-sm font-semibold tracking-tight">Create vault</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">A vault is a collection of Markdown notes.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            className="input min-w-[12rem] flex-1"
            placeholder="Vault name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createVault();
            }}
          />
          <select
            className="input w-auto"
            value={defaultVisibility}
            onChange={(e) => setDefaultVisibility(e.target.value)}
            title="Wiki audience when public pages are enabled; also default for notes"
            aria-label="Default wiki visibility"
          >
            <option value="private">Wiki: Private (Share only)</option>
            <option value="authenticated">Wiki: Authenticated</option>
            <option value="unlisted">Wiki: Unlisted</option>
            <option value="public">Wiki: Public</option>
          </select>
          <button type="button" onClick={() => void createVault()} className="btn-primary">
            Create
          </button>
        </div>
      </section>

      <section className="space-y-2">
        {vaults.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted)]">
            No vaults yet — create your first one above.
          </p>
        )}
        {vaults.map((v) => (
          <Link
            key={v.Id}
            href={`/vaults/${v.Id}`}
            className="group flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)]/50 px-4 py-3.5 no-underline transition hover:border-[var(--accent)]/50 hover:bg-[var(--surface-2)]/80 hover:no-underline"
          >
            <div className="min-w-0">
              <div className="font-medium text-[var(--text)] group-hover:text-[var(--accent-soft)]">
                {v.Name}
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-[var(--muted)]">
                /{v.slug}
                {v.PmProjectId ? ` · PM project #${v.PmProjectId}` : ''}
                {v.AccessRole && v.AccessRole !== 'owner'
                  ? ` · shared (${v.AccessRole})`
                  : ''}
              </div>
            </div>
            <span className="text-[var(--muted)] transition group-hover:text-[var(--accent-soft)]">→</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
