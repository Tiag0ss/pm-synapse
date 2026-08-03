'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import UserAvatar from '@/components/UserAvatar';

export type UserMenuUser = {
  userId: number;
  username: string;
  email: string;
  isAdmin: boolean;
};

interface UserMenuProps {
  user: UserMenuUser;
  /** Compact header on dense layouts */
  dense?: boolean;
}

export default function UserMenu({ user, dense = false }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    window.location.href = '/';
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={`flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)]/80 py-1 pl-1 pr-2.5 transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] ${
          dense ? 'max-w-[11rem]' : 'max-w-[14rem]'
        }`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <UserAvatar userId={user.userId} name={user.username} size="sm" />
        <span className="min-w-0 text-left">
          <span className="block truncate text-xs font-semibold text-[var(--text)]">
            {user.username}
          </span>
          <span className="block truncate text-[10px] text-[var(--muted)]">Signed in</span>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/50"
        >
          <div className="border-b border-[var(--border)] px-3 py-2.5">
            <p className="truncate text-sm font-medium text-[var(--text)]">{user.username}</p>
            <p className="truncate text-[11px] text-[var(--muted)]">{user.email}</p>
          </div>
          <div className="p-1.5">
            <Link
              role="menuitem"
              href="/profile"
              className="block rounded-lg px-2.5 py-2 text-sm text-[var(--text)] no-underline hover:bg-[var(--surface-2)] hover:no-underline"
              onClick={() => setOpen(false)}
            >
              My profile
            </Link>
            <Link
              role="menuitem"
              href="/templates"
              className="block rounded-lg px-2.5 py-2 text-sm text-[var(--text)] no-underline hover:bg-[var(--surface-2)] hover:no-underline"
              onClick={() => setOpen(false)}
            >
              Note templates
            </Link>
            {user.isAdmin && (
              <Link
                role="menuitem"
                href="/settings"
                className="block rounded-lg px-2.5 py-2 text-sm text-[var(--text)] no-underline hover:bg-[var(--surface-2)] hover:no-underline"
                onClick={() => setOpen(false)}
              >
                Admin settings
              </Link>
            )}
            <Link
              role="menuitem"
              href="/w"
              className="block rounded-lg px-2.5 py-2 text-sm text-[var(--text)] no-underline hover:bg-[var(--surface-2)] hover:no-underline"
              onClick={() => setOpen(false)}
            >
              Public wikis
            </Link>
          </div>
          <div className="border-t border-[var(--border)] p-1.5">
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-red-300 hover:bg-red-500/10"
              onClick={() => void logout()}
            >
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
