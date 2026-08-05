'use client';

import { useEffect, useState } from 'react';
import { useIsLgUp } from '@/lib/useMediaQuery';
import {
  clearDeferredInstallPrompt,
  dismissInstallPrompt,
  getDeferredInstallPrompt,
  isIosSafari,
  isStandaloneDisplay,
  subscribePwaInstall,
  wasInstallDismissed,
} from '@/lib/pwaInstall';

type Variant = 'banner' | 'menu';

interface InstallAppPromptProps {
  /** `banner` for home vaults list; `menu` for vault switcher. */
  variant?: Variant;
  className?: string;
}

/**
 * Mobile-only “Install app” prompt for vault menus.
 * Uses the deferred install prompt when available; on iOS Safari shows Add to Home Screen tips.
 */
export default function InstallAppPrompt({ variant = 'banner', className = '' }: InstallAppPromptProps) {
  const isLgUp = useIsLgUp();
  const [mounted, setMounted] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => setMounted(true), []);
  useEffect(() => subscribePwaInstall(() => setTick((n) => n + 1)), []);

  if (!mounted || isLgUp) return null;
  if (isStandaloneDisplay()) return null;
  if (wasInstallDismissed()) return null;

  // Re-read after tick so deferred prompt / dismiss updates UI
  void tick;
  const deferred = getDeferredInstallPrompt();
  const ios = isIosSafari();

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* ignore */
    } finally {
      clearDeferredInstallPrompt();
      setTick((n) => n + 1);
    }
  };

  const dismiss = () => {
    dismissInstallPrompt();
    setTick((n) => n + 1);
  };

  const hint = ios
    ? 'Tap Share, then Add to Home Screen for the app experience.'
    : deferred
      ? 'Add Synapse to your home screen for quick access.'
      : 'Use your browser menu to Install app or Add to Home Screen.';

  if (variant === 'menu') {
    return (
      <div
        className={`border-t border-[var(--border)] px-3 py-2 ${className}`}
        role="region"
        aria-label="Install app"
      >
        <p className="text-xs font-medium text-[var(--text)]">Install Synapse</p>
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--muted)]">{hint}</p>
        <div className="mt-2 flex items-center gap-2">
          {deferred ? (
            <button type="button" className="btn-primary py-1 text-xs" onClick={() => void install()}>
              Install
            </button>
          ) : null}
          <button type="button" className="btn-ghost py-1 text-xs" onClick={dismiss}>
            Not now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--panel)]/90 px-4 py-3 shadow-lg shadow-black/20 ${className}`}
      role="region"
      aria-label="Install app"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight text-[var(--text)]">Install Synapse</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {ios
              ? 'On iPhone/iPad: tap Share in Safari, then Add to Home Screen.'
              : deferred
                ? 'Install the app on this device for a full-screen vault experience.'
                : 'Use your browser menu to Install app or Add to Home Screen for a full-screen vault experience.'}
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost shrink-0 px-2 py-1 text-xs"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
        >
          ✕
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {deferred ? (
          <button type="button" className="btn-primary py-1.5 text-sm" onClick={() => void install()}>
            Install app
          </button>
        ) : null}
        <button type="button" className="btn-ghost py-1.5 text-sm" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}
