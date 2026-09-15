/** Decision blocks: :::decision Title … ::: — keep in sync with server/services/decisionBlocks.ts */

export const DECISION_MARKER_RE = /<!--\s*synapse:decision:([a-zA-Z0-9_-]+)\s*-->/;
const DECISION_OPEN = /^:::decision([+-])?\s*(.*)$/;
const DECISION_CLOSE = /^:::\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

export type DecisionBlock = {
  markerId: string | null;
  title: string;
  bodyMarkdown: string;
  options: string[];
  openLineIndex: number;
  closeLineIndex: number;
};

/** Plain text for decision option labels (strip mention/wikilink HTML if already injected). */
export function stripDecisionPlainText(raw: string): string {
  return String(raw || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function newDecisionMarkerId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isMdFenceLine(line: string): boolean {
  return /^```/.test(line);
}

/** List-item lines only (`-`, `*`, `+`, or `1.` / `1)`). */
export function parseDecisionOptions(bodyMarkdown: string): string[] {
  const out: string[] = [];
  for (const line of String(bodyMarkdown || '').split('\n')) {
    const m = line.match(LIST_ITEM_RE);
    if (!m) continue;
    const text = stripDecisionPlainText(m[1] || '');
    if (text) out.push(text);
  }
  return out;
}

function findDecisionClose(lines: string[], from: number): number {
  let depth = 1;
  let inFence = false;
  for (let j = from; j < lines.length; j += 1) {
    if (isMdFenceLine(lines[j])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (DECISION_OPEN.test(lines[j])) depth += 1;
    else if (DECISION_CLOSE.test(lines[j])) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/** Replace each complete :::decision … ::: block (for protecting from wikilink/mention transforms). */
export function mapOverDecisionBlocks(md: string, replace: (block: string) => string): string {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    if (isMdFenceLine(lines[i])) {
      inFence = !inFence;
      out.push(lines[i]);
      i += 1;
      continue;
    }
    if (inFence) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    if (!DECISION_OPEN.test(lines[i])) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const close = findDecisionClose(lines, i + 1);
    if (close < 0) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    out.push(replace(lines.slice(i, close + 1).join('\n')));
    i = close + 1;
  }
  return out.join('\n');
}

export function parseDecisionBlocks(md: string): DecisionBlock[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out: DecisionBlock[] = [];
  let i = 0;
  let inFence = false;
  while (i < lines.length) {
    if (isMdFenceLine(lines[i])) {
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence) {
      i += 1;
      continue;
    }
    const m = lines[i].match(DECISION_OPEN);
    if (!m) {
      i += 1;
      continue;
    }
    const close = findDecisionClose(lines, i + 1);
    if (close < 0) {
      i += 1;
      continue;
    }
    const rest = String(m[2] || '');
    const markerMatch = rest.match(DECISION_MARKER_RE);
    const title = rest.replace(DECISION_MARKER_RE, '').trim();
    const bodyMarkdown = lines.slice(i + 1, close).join('\n').trim();
    out.push({
      markerId: markerMatch?.[1] || null,
      title,
      bodyMarkdown,
      options: parseDecisionOptions(bodyMarkdown),
      openLineIndex: i,
      closeLineIndex: close,
    });
    i = close + 1;
  }
  return out;
}

/** Ensure every :::decision block has a stable <!--synapse:decision:…--> marker on the open line. */
export function ensureDecisionMarkers(md: string): string {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let inFence = false;
  let changed = false;
  while (i < lines.length) {
    if (isMdFenceLine(lines[i])) {
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence) {
      i += 1;
      continue;
    }
    const m = lines[i].match(DECISION_OPEN);
    if (!m) {
      i += 1;
      continue;
    }
    const close = findDecisionClose(lines, i + 1);
    if (close < 0) {
      i += 1;
      continue;
    }
    const flag = m[1] || '';
    const rest = String(m[2] || '');
    if (!DECISION_MARKER_RE.test(rest)) {
      const markerId = newDecisionMarkerId();
      const title = rest.replace(DECISION_MARKER_RE, '').trim();
      lines[i] = `:::decision${flag} ${title} <!--synapse:decision:${markerId}-->`.trimEnd();
      changed = true;
    }
    i = close + 1;
  }
  return changed ? lines.join('\n') : md || '';
}

export function listDecisionMarkerIds(md: string): string[] {
  return parseDecisionBlocks(md)
    .map((b) => b.markerId)
    .filter((id): id is string => Boolean(id));
}

export function noteHasDecisionMarker(md: string, decisionId: string): boolean {
  const needle = String(decisionId || '').trim();
  if (!needle) return false;
  return listDecisionMarkerIds(md).includes(needle);
}

export function getDecisionBlockByMarker(
  md: string,
  decisionId: string
): DecisionBlock | null {
  const needle = String(decisionId || '').trim();
  if (!needle) return null;
  return parseDecisionBlocks(md).find((b) => b.markerId === needle) || null;
}
