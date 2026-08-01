'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Me {
  pmUserId: number;
  username: string;
  email: string;
}

interface Vault {
  Id: number;
  Name: string;
  slug: string;
  Description?: string;
  PmProjectId?: number | null;
  AccessRole?: 'owner' | 'edit' | 'read';
}

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
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
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.message || 'Failed to create vault');
      return;
    }
    setName('');
    await load();
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-[var(--muted)]">
        Loading workspace…
      </main>
    );
  }

  if (!me) {
    return (
      <main className="relative flex min-h-screen flex-col items-center justify-center px-6">
        <div className="absolute inset-0 overflow-hidden" aria-hidden>
          <div className="absolute -left-24 top-20 h-72 w-72 rounded-full bg-teal-500/10 blur-3xl" />
          <div className="absolute -right-16 bottom-16 h-80 w-80 rounded-full bg-sky-500/10 blur-3xl" />
        </div>
        <div className="relative w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)]/80 p-10 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent-soft)]">
            Knowledge vaults
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">PM Synapse</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--muted)]">
            Markdown notes with wikilinks, backlinks, and optional push into Project Management —
            signed in with your existing PM account.
          </p>
          <a
            href="/api/auth/sso/start"
            className="btn-primary mt-8 inline-flex no-underline hover:no-underline"
          >
            Sign in with Project Management
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-soft)]">
            PM Synapse
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your vaults</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Signed in as <span className="text-[var(--text)]">{me.username}</span> · {me.email}
          </p>
        </div>
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
      </header>

      {error && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <section className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--panel)]/70 p-5 shadow-lg shadow-black/20 backdrop-blur">
        <h2 className="text-sm font-semibold tracking-tight">Create vault</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">A vault is a collection of Markdown notes.</p>
        <div className="mt-4 flex gap-2">
          <input
            className="input flex-1"
            placeholder="Vault name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createVault();
            }}
          />
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
