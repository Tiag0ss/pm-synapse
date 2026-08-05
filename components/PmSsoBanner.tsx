'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type PmIntegration = {
  enabled: boolean;
  ssoToken: boolean;
  personalApiKey: { configured: boolean; prefix?: string | null };
};

/**
 * Shown when PM integration is on but the signed-in user has neither a valid SSO
 * token nor a personal pt_… API key — Planner actions will fail until they reconnect.
 */
export default function PmSsoBanner({ className = '' }: { className?: string }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const json = await res.json();
        const pm = json.data?.pmIntegration as PmIntegration | undefined;
        if (!pm?.enabled) return;
        if (pm.ssoToken || pm.personalApiKey?.configured) return;
        if (!cancelled) setShow(true);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className={`border-b border-amber-500/35 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-50 ${className}`}
      role="status"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 leading-snug">
          Project Management credentials missing — reconnect SSO or add a personal API token in
          Profile to create and sync Planner tasks.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <a
            href="/api/auth/sso/start"
            className="font-medium text-[var(--accent-soft)] no-underline hover:underline"
          >
            Reconnect SSO
          </a>
          <Link href="/profile" className="font-medium text-[var(--accent-soft)] no-underline hover:underline">
            Open Profile
          </Link>
        </div>
      </div>
    </div>
  );
}
