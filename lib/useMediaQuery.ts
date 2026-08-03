'use client';

import { useEffect, useState } from 'react';

/**
 * SSR-safe media query. Defaults to `false` until mounted so mobile-first chrome
 * does not flash desktop layout, then updates from matchMedia.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind `lg` breakpoint (1024px). */
export function useIsLgUp(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
