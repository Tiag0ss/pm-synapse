export const CHECKBOX_MARKER_RE = /<!--\s*synapse:cb:([a-zA-Z0-9_-]+)\s*-->/;

/** GFM-style box mark: open, done, or partial (In Progress / stub). */
export type CheckboxMark = ' ' | 'x' | '-';

export interface ParsedCheckbox {
  /** 0-based index among checkbox lines in the document */
  index: number;
  checked: boolean;
  /** True when markdown uses `[-]` (partial / in progress). */
  partial: boolean;
  /** Raw mark character inside `[…]`. */
  mark: CheckboxMark;
  text: string;
  markerId: string | null;
  lineIndex: number;
  rawLine: string;
  /** Leading whitespace width (tabs count as 2) for nest → PM subtask hierarchy */
  indent: number;
}

const LINE_RE = /^(\s*)[-*+]\s+\[([ xX\-])\]\s+(.*)$/;

function newMarkerId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function leadingIndentWidth(leadingWs: string): number {
  return String(leadingWs || '').replace(/\t/g, '  ').length;
}

export function normalizeCheckboxMark(raw: string): CheckboxMark {
  const c = String(raw || '').trim().toLowerCase();
  if (c === 'x') return 'x';
  if (c === '-') return '-';
  return ' ';
}

export function markFromChecked(checked: boolean): CheckboxMark {
  return checked ? 'x' : ' ';
}

/** True when the whole label is wrapped in GFM strikethrough `~~…~~`. */
export function isStruckMarkdownText(text: string): boolean {
  const t = String(text || '').trim();
  return t.length >= 4 && t.startsWith('~~') && t.endsWith('~~');
}

/** Wrap or unwrap a checkbox/todo label for Planner Cancelled → strike. */
export function withStruckMarkdownText(text: string, struck: boolean): string {
  const t = String(text || '').trim();
  if (struck) {
    if (!t) return t;
    if (isStruckMarkdownText(t)) return t;
    return `~~${t}~~`;
  }
  if (isStruckMarkdownText(t)) return t.slice(2, -2).trim();
  return t;
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
    const mark = normalizeCheckboxMark(m[2]);
    out.push({
      index,
      checked: mark === 'x',
      partial: mark === '-',
      mark,
      text,
      markerId: markerMatch?.[1] || null,
      lineIndex,
      rawLine,
      indent: leadingIndentWidth(m[1]),
    });
    index += 1;
  }
  return out;
}

/** Ensure the checkbox at index has a stable <!--synapse:cb:…--> marker; returns new markdown + id. */
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

export function setCheckboxMarkByMarker(
  markdown: string,
  markerId: string,
  mark: CheckboxMark
): string | null {
  return setCheckboxLineByMarker(markdown, markerId, { mark });
}

/** Update mark and/or label text for a checkbox line (keeps `<!--synapse:cb:…-->`). */
export function setCheckboxLineByMarker(
  markdown: string,
  markerId: string,
  opts: { mark?: CheckboxMark; text?: string }
): string | null {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  const needle = `<!--synapse:cb:${markerId}-->`;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(needle)) continue;
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    const rest = m[3];
    const mark = opts.mark ?? normalizeCheckboxMark(m[2]);
    const text =
      opts.text != null
        ? String(opts.text).trim()
        : rest.replace(CHECKBOX_MARKER_RE, '').trim();
    lines[i] = `${m[1]}- [${mark}] ${text} <!--synapse:cb:${markerId}-->`;
    return lines.join('\n');
  }
  return null;
}

export function setCheckboxCheckedByMarker(
  markdown: string,
  markerId: string,
  checked: boolean
): string | null {
  return setCheckboxMarkByMarker(markdown, markerId, markFromChecked(checked));
}

export function setCheckboxMarkByIndex(
  markdown: string,
  checkboxIndex: number,
  mark: CheckboxMark
): string | null {
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m) continue;
    seen += 1;
    if (seen !== checkboxIndex) continue;
    lines[i] = `${m[1]}- [${mark}] ${m[3]}`;
    return lines.join('\n');
  }
  return null;
}

export function setCheckboxCheckedByIndex(
  markdown: string,
  checkboxIndex: number,
  checked: boolean
): string | null {
  return setCheckboxMarkByIndex(markdown, checkboxIndex, markFromChecked(checked));
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
