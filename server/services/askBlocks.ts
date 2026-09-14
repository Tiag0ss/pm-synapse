/** Ask blocks: :::ask Question … ::: — keep in sync with lib/askBlocks.ts */

export const ASK_MARKER_RE = /<!--\s*synapse:ask:([a-zA-Z0-9_-]+)\s*-->/;
const ASK_OPEN = /^:::ask([+-])?\s*(.*)$/;
const ASK_CLOSE = /^:::\s*$/;

export type AskBlock = {
  markerId: string | null;
  question: string;
  bodyMarkdown: string;
  openLineIndex: number;
  closeLineIndex: number;
};

function newAskMarkerId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isMdFenceLine(line: string): boolean {
  return /^```/.test(line);
}

function findAskClose(lines: string[], from: number): number {
  let depth = 1;
  let inFence = false;
  for (let j = from; j < lines.length; j += 1) {
    if (isMdFenceLine(lines[j])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (ASK_OPEN.test(lines[j])) depth += 1;
    else if (ASK_CLOSE.test(lines[j])) {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

export function parseAskBlocks(md: string): AskBlock[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out: AskBlock[] = [];
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
    const m = lines[i].match(ASK_OPEN);
    if (!m) {
      i += 1;
      continue;
    }
    const close = findAskClose(lines, i + 1);
    if (close < 0) {
      i += 1;
      continue;
    }
    const rest = String(m[2] || '');
    const markerMatch = rest.match(ASK_MARKER_RE);
    const question = rest.replace(ASK_MARKER_RE, '').trim();
    out.push({
      markerId: markerMatch?.[1] || null,
      question,
      bodyMarkdown: lines.slice(i + 1, close).join('\n').trim(),
      openLineIndex: i,
      closeLineIndex: close,
    });
    i = close + 1;
  }
  return out;
}

/** Ensure every :::ask block has a stable <!--synapse:ask:…--> marker on the open line. */
export function ensureAskMarkers(md: string): string {
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
    const m = lines[i].match(ASK_OPEN);
    if (!m) {
      i += 1;
      continue;
    }
    const close = findAskClose(lines, i + 1);
    if (close < 0) {
      i += 1;
      continue;
    }
    const flag = m[1] || '';
    const rest = String(m[2] || '');
    if (!ASK_MARKER_RE.test(rest)) {
      const markerId = newAskMarkerId();
      const question = rest.replace(ASK_MARKER_RE, '').trim();
      lines[i] = `:::ask${flag} ${question} <!--synapse:ask:${markerId}-->`.trimEnd();
      changed = true;
    }
    i = close + 1;
  }
  return changed ? lines.join('\n') : md || '';
}

export function listAskMarkerIds(md: string): string[] {
  return parseAskBlocks(md)
    .map((b) => b.markerId)
    .filter((id): id is string => Boolean(id));
}

export function noteHasAskMarker(md: string, askId: string): boolean {
  const needle = String(askId || '').trim();
  if (!needle) return false;
  return listAskMarkerIds(md).includes(needle);
}
