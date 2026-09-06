'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  collectBoardEmbedMounts,
  type BoardEmbedMount,
} from '@/components/BoardEmbedPortals';

/**
 * Two-phase board-embed mounting for markdown preview hosts that own `innerHTML`.
 * Avoids flushSync and nested createRoot unmount races:
 * 1) clear portal mounts when content changes
 * 2) after mounts are empty, write HTML and collect new placeholders
 */
export function useBoardEmbedPreview(
  containerRef: RefObject<HTMLElement | null>,
  options: {
    /** Preview HTML string */
    html: string;
    /** When false, clears mounts and skips writing */
    enabled: boolean;
    /** Extra signal to force a rewrite (e.g. planner link payload) */
    rewriteToken?: string | number;
    /** Run after `innerHTML` is set (mermaid, planner buttons, …) */
    afterWrite?: (root: HTMLElement) => void;
  }
): BoardEmbedMount[] {
  const { html, enabled, rewriteToken = '', afterWrite } = options;
  const [embedMounts, setEmbedMounts] = useState<BoardEmbedMount[]>([]);
  const pendingKeyRef = useRef<string | null>(null);
  const afterWriteRef = useRef(afterWrite);
  afterWriteRef.current = afterWrite;

  const contentKey = enabled ? `${rewriteToken}\n${html}` : '';

  // Phase 1 — content changed: drop portals before touching the DOM.
  useLayoutEffect(() => {
    if (!enabled) {
      pendingKeyRef.current = null;
      setEmbedMounts([]);
      return;
    }
    pendingKeyRef.current = contentKey;
    setEmbedMounts([]);
  }, [contentKey, enabled]);

  // Phase 2 — portals gone: write HTML and attach new mounts.
  useLayoutEffect(() => {
    if (!enabled) return;
    if (embedMounts.length > 0) return;
    if (pendingKeyRef.current !== contentKey) return;

    const root = containerRef.current;
    if (!root) return;

    pendingKeyRef.current = null;
    root.innerHTML = html || '';
    afterWriteRef.current?.(root);
    setEmbedMounts(collectBoardEmbedMounts(root));
  }, [contentKey, enabled, embedMounts, html, containerRef]);

  return embedMounts;
}
