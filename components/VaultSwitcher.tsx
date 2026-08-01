'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const LAST_VAULT_COOKIE = 'synapse_last_vault';
const LAST_VAULT_KEY = 'synapse_last_vault_id';

export function rememberLastVault(vaultId: string | number): void {
  const id = String(vaultId);
  try {
    localStorage.setItem(LAST_VAULT_KEY, id);
  } catch {
    /* ignore */
  }
  document.cookie = `${LAST_VAULT_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function readLastVaultId(): string | null {
  try {
    const fromLs = localStorage.getItem(LAST_VAULT_KEY);
    if (fromLs && /^\d+$/.test(fromLs)) return fromLs;
  } catch {
    /* ignore */
  }
  return null;
}

interface VaultRow {
  Id: number;
  Name: string;
  slug?: string;
  AccessRole?: string;
}

interface VaultSwitcherProps {
  currentVaultId: string;
  currentVaultName: string;
  onOpenOptions?: () => void;
}

export default function VaultSwitcher({
  currentVaultId,
  currentVaultName,
  onOpenOptions,
}: VaultSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [vaults, setVaults] = useState<VaultRow[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const res = await fetch('/api/vaults', { credentials: 'include' });
      const data = await res.json();
      if (res.ok) setVaults(data.data || []);
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const switchTo = (id: number) => {
    rememberLastVault(id);
    setOpen(false);
    router.push(`/vaults/${id}`);
  };

  return (
    <div ref={rootRef} className="relative shrink-0 border-t border-[var(--border)] bg-[var(--panel)]/90 p-2">
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-2 right-2 z-30 mb-1 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/50"
        >
          <ul className="max-h-56 overflow-auto py-1">
            {vaults.map((v) => {
              const active = String(v.Id) === String(currentVaultId);
              return (
                <li key={v.Id}>
                  <button
                    type="button"
                    role="menuitem"
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-[var(--surface-2)] ${
                      active ? 'text-[var(--text)]' : 'text-[var(--muted)]'
                    }`}
                    onClick={() => switchTo(v.Id)}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{v.Name}</span>
                    {active && (
                      <span className="text-[var(--accent-soft)]" aria-label="Current vault">
                        ✓
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-[var(--border)] py-1">
            <Link
              href="/"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[var(--muted)] no-underline transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] hover:no-underline"
              onClick={() => setOpen(false)}
            >
              <span aria-hidden>📚</span>
              <span>Manage vaults…</span>
            </Link>
          </div>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 px-2.5 py-2 text-left transition hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)]/80"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title="Switch vault"
        >
          <span className="text-[10px] text-[var(--muted)]" aria-hidden>
            ⇅
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
            {currentVaultName || `Vault #${currentVaultId}`}
          </span>
        </button>
        {onOpenOptions && (
          <button
            type="button"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)]/60 text-[var(--muted)] transition hover:border-[var(--accent)]/40 hover:bg-[var(--surface-2)]/80 hover:text-[var(--text)]"
            title="Vault options"
            aria-label="Vault options"
            onClick={() => {
              setOpen(false);
              onOpenOptions();
            }}
          >
            <span className="text-base leading-none" aria-hidden>
              ⚙
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
