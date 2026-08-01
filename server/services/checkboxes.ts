/**
 * Server-side copy of checkbox helpers (keep in sync with lib/checkboxes.ts).
 * Duplicated so Express does not depend on Next path aliases.
 */

export const CHECKBOX_MARKER_RE = /<!--\s*synapse:cb:([a-zA-Z0-9_-]+)\s*-->/;

export interface ParsedCheckbox {
  index: number;
  checked: boolean;
  text: string;
  markerId: string | null;
  lineIndex: number;
  rawLine: string;
}

const LINE_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;

function newMarkerId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function parseCheckboxes(markdown: string): ParsedCheckbox[] {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out: ParsedCheckbox[] = [];
  let index = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const rawLine = lines[lineIndex];
    const m = rawLine.match(LINE_RE);
    if (!m) continue;
    const rest = m[3];
    const markerMatch = rest.match(CHECKBOX_MARKER_RE);
    const text = rest.replace(CHECKBOX_MARKER_RE, '').trim();
    out.push({
      index,
      checked: m[2].toLowerCase() === 'x',
      text,
      markerId: markerMatch?.[1] || null,
      lineIndex,
      rawLine,
    });
    index += 1;
  }
  return out;
}

export function ensureCheckboxMarker(
  markdown: string,
  checkboxIndex: number
): { markdown: string; markerId: string } | null {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    seen += 1;
    if (seen !== checkboxIndex) continue;
    const existing = m[3].match(CHECKBOX_MARKER_RE);
    if (existing) {
      return { markdown: lines.join('\n'), markerId: existing[1] };
    }
    const markerId = newMarkerId();
    const text = m[3].replace(CHECKBOX_MARKER_RE, '').trimEnd();
    lines[i] = `${m[1]}- [${m[2]}] ${text} <!--synapse:cb:${markerId}-->`;
    return { markdown: lines.join('\n'), markerId };
  }
  return null;
}

export function setCheckboxCheckedByMarker(
  markdown: string,
  markerId: string,
  checked: boolean
): string | null {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const mark = `<!--synapse:cb:${markerId}-->`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(mark)) continue;
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const box = checked ? 'x' : ' ';
    lines[i] = `${m[1]}- [${box}] ${m[3]}`;
    return lines.join('\n');
  }
  return null;
}

export function setCheckboxCheckedByIndex(
  markdown: string,
  checkboxIndex: number,
  checked: boolean
): string | null {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    seen += 1;
    if (seen !== checkboxIndex) continue;
    const box = checked ? 'x' : ' ';
    lines[i] = `${m[1]}- [${box}] ${m[3]}`;
    return lines.join('\n');
  }
  return null;
}

export function titleToPath(title: string): string {
  const stem =
    title
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) =>
        seg
          .trim()
          .replace(/[^\w\- ]+/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean)
      .join('/') || 'note';
  return stem.toLowerCase().endsWith('.md') ? stem : `${stem}.md`;
}
