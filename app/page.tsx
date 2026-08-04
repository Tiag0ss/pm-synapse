'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AppUserMenu from '@/components/AppUserMenu';

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

function roleLabel(role?: string) {
  if (!role || role === 'owner') return null;
  if (role === 'edit') return 'Can edit';
  if (role === 'read') return 'Read only';
  return role;
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
  const [createBusy, setCreateBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [vaultQuery, setVaultQuery] = useState('');

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

  const filteredVaults = useMemo(() => {
    const q = vaultQuery.trim().toLowerCase();
    if (!q) return vaults;
    return vaults.filter((v) => {
      const name = v.Name.toLowerCase();
      const slug = (v.slug || '').toLowerCase();
      const desc = (v.Description || '').toLowerCase();
      return name.includes(q) || slug.includes(q) || desc.includes(q);
    });
  }, [vaults, vaultQuery]);

  const createVault = async () => {
    if (!name.trim()) return;
    setCreateBusy(true);
    setError('');
    try {
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
      setCreateOpen(false);
      await load();
    } finally {
      setCreateBusy(false);
    }
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
      <main className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-pulse rounded-full border-2 border-[var(--accent)]/40 border-t-[var(--accent)]" />
          <p className="text-sm text-[var(--muted)]">Loading workspace…</p>
        </div>
      </main>
    );
  }

  const siteName = providers?.siteName || 'PM Synapse';

  if (!me) {
    return (
      <main className="relative flex min-h-screen flex-col lg:flex-row">
        <section className="relative flex flex-1 flex-col justify-center overflow-hidden px-8 py-14 lg:px-16 lg:py-20">
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute -left-20 top-10 h-[28rem] w-[28rem] rounded-full bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] blur-3xl" />
            <div className="absolute bottom-0 right-0 h-72 w-72 rounded-full bg-sky-900/20 blur-3xl" />
          </div>
          <div className="relative max-w-lg">
            <p className="text-sm font-semibold tracking-[0.22em] text-[var(--accent-soft)] uppercase">
              {siteName}
            </p>
            <h1
              className="mt-5 text-4xl leading-tight tracking-tight text-[var(--text)] sm:text-5xl"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              Knowledge that stays connected
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-[var(--muted)]">
              Markdown vaults with wikilinks, tasks, and optional Planner sync — built for teams that
              think in notes.
            </p>
            <Link
              href="/w"
              className="mt-8 inline-flex text-sm text-[var(--accent-soft)] no-underline hover:underline"
            >
              Browse public wikis
            </Link>
          </div>
        </section>

        <section className="relative flex w-full items-center justify-center border-t border-[var(--border)] bg-[var(--panel)]/40 px-6 py-12 backdrop-blur-sm lg:w-[26rem] lg:border-t-0 lg:border-l xl:w-[28rem]">
          <div className="w-full max-w-sm">
            <h2 className="text-xl font-semibold tracking-tight text-[var(--text)]">
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {mode === 'login'
                ? 'Continue to your vaults.'
                : 'Start with a Synapse account.'}
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
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-[var(--border)]/80 bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-[var(--text)]">
              {siteName}
            </p>
            <p className="truncate text-[11px] text-[var(--muted)]">Knowledge vaults</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/w"
              className="hidden text-xs text-[var(--muted)] no-underline hover:text-[var(--accent-soft)] hover:no-underline sm:inline"
            >
              Wikis
            </Link>
            <AppUserMenu user={me} />
          </div>
        </div>
      </header>

      <div className="relative overflow-hidden border-b border-[var(--border)]">
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute -left-24 top-0 h-64 w-64 rounded-full bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] blur-3xl" />
          <div className="absolute right-0 top-0 h-48 w-80 rounded-full bg-sky-950/30 blur-3xl" />
        </div>
        <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-end sm:justify-between sm:py-12">
          <div className="max-w-xl">
            <h1
              className="text-3xl tracking-tight text-[var(--text)] sm:text-4xl"
              style={{ fontFamily: 'var(--font-serif)' }}
            >
              Your vaults
            </h1>
            <p className="mt-2 text-[15px] leading-relaxed text-[var(--muted)]">
              Open a vault to write, link notes, and push tasks to Planner.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary shrink-0 self-start sm:self-auto"
            onClick={() => {
              setCreateOpen((o) => !o);
              setError('');
            }}
          >
            {createOpen ? 'Cancel' : 'New vault'}
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-6 py-8">
        {error && (
          <p className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        {createOpen && (
          <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/80 p-5 shadow-lg shadow-black/20">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--text)]">Create vault</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              A vault is a collection of Markdown notes. Wiki visibility can be changed later.
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <input
                autoFocus
                className="input min-w-[12rem] flex-1"
                placeholder="Vault name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createVault();
                }}
              />
              <select
                className="input w-full sm:w-auto"
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
              <button
                type="button"
                onClick={() => void createVault()}
                className="btn-primary"
                disabled={createBusy || !name.trim()}
              >
                {createBusy ? 'Creating…' : 'Create'}
              </button>
            </div>
          </section>
        )}

        {vaults.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)]/40 px-6 py-16 text-center">
            <p className="text-xl text-[var(--text)]" style={{ fontFamily: 'var(--font-serif)' }}>
              No vaults yet
            </p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--muted)]">
              Create your first vault to start taking notes with wikilinks, tasks, and templates.
            </p>
            {!createOpen && (
              <button
                type="button"
                className="btn-primary mt-6"
                onClick={() => setCreateOpen(true)}
              >
                New vault
              </button>
            )}
          </div>
        ) : (
          <section>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
                {vaultQuery.trim()
                  ? `${filteredVaults.length} of ${vaults.length} ${vaults.length === 1 ? 'vault' : 'vaults'}`
                  : `${vaults.length} ${vaults.length === 1 ? 'vault' : 'vaults'}`}
              </h2>
              <input
                type="search"
                className="input w-full sm:max-w-xs"
                placeholder="Search vaults…"
                value={vaultQuery}
                onChange={(e) => setVaultQuery(e.target.value)}
                aria-label="Search vaults"
              />
            </div>
            {filteredVaults.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/30 px-6 py-12 text-center">
                <p className="text-sm text-[var(--muted)]">No vaults match “{vaultQuery.trim()}”.</p>
                <button
                  type="button"
                  className="mt-3 text-sm text-[var(--accent-soft)] hover:underline"
                  onClick={() => setVaultQuery('')}
                >
                  Clear search
                </button>
              </div>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {filteredVaults.map((v) => {
                  const shared = roleLabel(v.AccessRole);
                  return (
                    <li key={v.Id}>
                      <Link
                        href={`/vaults/${v.Id}`}
                        className="group flex h-full flex-col rounded-2xl border border-[var(--border)] bg-[var(--panel)]/60 p-5 no-underline transition duration-200 hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] hover:bg-[var(--surface-2)]/70 hover:no-underline hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_20%,transparent)]"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="text-[17px] font-semibold tracking-tight text-[var(--text)] transition group-hover:text-[var(--accent-soft)]">
                            {v.Name}
                          </h3>
                          <span
                            className="mt-0.5 shrink-0 text-[var(--muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--accent-soft)]"
                            aria-hidden
                          >
                            →
                          </span>
                        </div>
                        {v.Description ? (
                          <p className="mt-2 line-clamp-2 text-sm leading-snug text-[var(--muted)]">
                            {v.Description}
                          </p>
                        ) : (
                          <p className="mt-2 font-mono text-[11px] text-[var(--muted)]">/{v.slug}</p>
                        )}
                        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted)]">
                            /{v.slug}
                          </span>
                          {v.PmProjectId ? (
                            <span className="rounded border border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-soft)]">
                              Planner #{v.PmProjectId}
                            </span>
                          ) : null}
                          {shared ? (
                            <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                              {shared}
                            </span>
                          ) : (
                            <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                              Owner
                            </span>
                          )}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
