'use client';

import { useEffect, useState } from 'react';

export type ToastTone = 'info' | 'success' | 'error';

export type ToastPayload = {
  id: number;
  message: string;
  tone: ToastTone;
};

function inferTone(message: string): ToastTone {
  const m = message.toLowerCase();
  if (
    m.includes('fail') ||
    m.includes('error') ||
    m.includes('could not') ||
    m.includes('required') ||
    m.includes('invalid') ||
    m.includes('denied') ||
    m.includes('missing') ||
    m.includes('reconnect') ||
    m.includes('not found')
  ) {
    return 'error';
  }
  if (
    m.includes('created') ||
    m.includes('saved') ||
    m.includes('already linked') ||
    m.includes('linked') ||
    m.includes('restored') ||
    m.includes('updated') ||
    m.includes('imported')
  ) {
    return 'success';
  }
  return 'info';
}

type Props = {
  message: string | null;
  /** Bumps when the same message is shown again. */
  nonce?: number;
  tone?: ToastTone | null;
  durationMs?: number;
};

/**
 * Floating corner toast. Pass the latest status string; auto-dismisses.
 */
export default function AppToast({
  message,
  nonce = 0,
  tone = null,
  durationMs = 4500,
}: Props) {
  const [toast, setToast] = useState<ToastPayload | null>(null);

  useEffect(() => {
    const text = String(message || '').trim();
    if (!text) return;
    // Skip ephemeral save chrome that already lives in the header pill
    if (text === 'Saving…' || text === 'Autosaving…' || text === 'Autosaved' || text === 'Saved') {
      return;
    }
    if (text === 'Unsaved changes') return;

    const id = Date.now();
    setToast({ id, message: text, tone: tone || inferTone(text) });
    const t = window.setTimeout(() => {
      setToast((cur) => (cur?.id === id ? null : cur));
    }, durationMs);
    return () => window.clearTimeout(t);
  }, [message, nonce, tone, durationMs]);

  if (!toast) return null;

  const border =
    toast.tone === 'error'
      ? 'border-red-500/40 bg-red-950/90 text-red-100'
      : toast.tone === 'success'
        ? 'border-teal-500/35 bg-[color-mix(in_srgb,var(--panel)_92%,#0f766e)] text-[var(--text)]'
        : 'border-[var(--border)] bg-[var(--panel)]/95 text-[var(--text)]';

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-[80] flex max-w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)]"
      aria-live="polite"
    >
      <div
        className={`pointer-events-auto rounded-xl border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur-md ${border}`}
        role={toast.tone === 'error' ? 'alert' : 'status'}
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 leading-snug">{toast.message}</p>
          <button
            type="button"
            className="shrink-0 rounded px-1 text-[var(--muted)] hover:text-[var(--text)]"
            aria-label="Dismiss"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

export { inferTone };
