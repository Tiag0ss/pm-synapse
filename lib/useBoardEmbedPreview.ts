'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  collectBoardEmbedMounts,
  type BoardEmbedMount,
} from '@/components/BoardEmbedPortals';
import { collectAskBlockMounts, type AskBlockMount } from '@/components/AskBlockPortals';
import {
  collectDecisionBlockMounts,
  type DecisionBlockMount,
} from '@/components/DecisionBlockPortals';

/**
 * Two-phase board-embed + ask/decision-block mounting for markdown preview hosts that own `innerHTML`.
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
): {
  embedMounts: BoardEmbedMount[];
  askMounts: AskBlockMount[];
  decisionMounts: DecisionBlockMount[];
} {
  const { html, enabled, rewriteToken = '', afterWrite } = options;
  const [embedMounts, setEmbedMounts] = useState<BoardEmbedMount[]>([]);
  const [askMounts, setAskMounts] = useState<AskBlockMount[]>([]);
  const [decisionMounts, setDecisionMounts] = useState<DecisionBlockMount[]>([]);
  const pendingKeyRef = useRef<string | null>(null);
  const afterWriteRef = useRef(afterWrite);
  afterWriteRef.current = afterWrite;

  const contentKey = enabled ? `${rewriteToken}\n${html}` : '';

  // Phase 1 — content changed: drop portals before touching the DOM.
  useLayoutEffect(() => {
    if (!enabled) {
      pendingKeyRef.current = null;
      setEmbedMounts([]);
      setAskMounts([]);
      setDecisionMounts([]);
      return;
    }
    pendingKeyRef.current = contentKey;
    setEmbedMounts([]);
    setAskMounts([]);
    setDecisionMounts([]);
  }, [contentKey, enabled]);

  // Phase 2 — portals gone: write HTML and attach new mounts.
  useLayoutEffect(() => {
    if (!enabled) return;
    if (embedMounts.length > 0 || askMounts.length > 0 || decisionMounts.length > 0) return;
    if (pendingKeyRef.current !== contentKey) return;

    const root = containerRef.current;
    if (!root) return;

    pendingKeyRef.current = null;
    root.innerHTML = html || '';
    afterWriteRef.current?.(root);
    setEmbedMounts(collectBoardEmbedMounts(root));
    setAskMounts(collectAskBlockMounts(root));
    setDecisionMounts(collectDecisionBlockMounts(root));
  }, [contentKey, enabled, embedMounts, askMounts, decisionMounts, html, containerRef]);

  return { embedMounts, askMounts, decisionMounts };
}
