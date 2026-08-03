'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import UserMenu, { type UserMenuUser } from '@/components/UserMenu';

type Props = {
  /** Skip fetch when the parent already loaded the session. */
  user?: UserMenuUser | null;
  dense?: boolean;
  /** Public pages: show Sign in when there is no session. */
  showSignInWhenGuest?: boolean;
  className?: string;
};

/**
 * Session-aware avatar menu for app chrome. Drop into any page header.
 */
export default function AppUserMenu({
  user: userProp,
  dense = false,
  showSignInWhenGuest = false,
  className = '',
}: Props) {
  const [user, setUser] = useState<UserMenuUser | null>(userProp ?? null);
  const [ready, setReady] = useState(userProp != null);

  useEffect(() => {
    if (userProp != null) {
      setUser(userProp);
      setReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) {
            setUser(null);
            setReady(true);
          }
          return;
        }
        const json = await res.json();
        const d = json.data;
        if (!cancelled && d) {
          setUser({
            userId: Number(d.userId),
            username: String(d.username || ''),
            email: String(d.email || ''),
            isAdmin: Boolean(d.isAdmin),
          });
        }
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userProp]);

  if (!ready) {
    return (
      <div
        className={`h-9 w-24 animate-pulse rounded-full bg-[var(--surface-2)] ${className}`}
        aria-hidden
      />
    );
  }

  if (user) {
    return (
      <div className={className}>
        <UserMenu user={user} dense={dense} />
      </div>
    );
  }

  if (showSignInWhenGuest) {
    return (
      <Link
        href="/"
        className={`btn-ghost py-1.5 text-xs no-underline hover:no-underline ${className}`}
        title="Sign in to Synapse"
      >
        Sign in
      </Link>
    );
  }

  return null;
}
