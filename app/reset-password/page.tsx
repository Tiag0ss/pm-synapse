'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

function ResetForm() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setMessage('');
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Reset failed');
        return;
      }
      setMessage(data.message || 'Password updated');
    } catch {
      setError('Reset failed');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <p className="mt-4 text-sm text-red-300">Missing reset token. Use the link from your email.</p>
    );
  }

  return (
    <>
      {error && (
        <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      {message ? (
        <p className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm">
          {message}{' '}
          <Link href="/" className="text-[var(--accent-soft)]">
            Sign in
          </Link>
        </p>
      ) : (
        <form
          className="mt-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            className="input w-full"
            type="password"
            required
            placeholder="New password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="input w-full"
            type="password"
            required
            placeholder="Confirm password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Update password'}
          </button>
        </form>
      )}
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6">
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)]/80 p-8 shadow-2xl backdrop-blur-xl">
        <h1 className="text-2xl font-semibold tracking-tight">Reset password</h1>
        <Suspense fallback={<p className="mt-4 text-sm text-[var(--muted)]">Loading…</p>}>
          <ResetForm />
        </Suspense>
        <Link href="/" className="mt-6 block text-center text-sm text-[var(--accent-soft)]">
          ← Back to sign in
        </Link>
      </div>
    </main>
  );
}
