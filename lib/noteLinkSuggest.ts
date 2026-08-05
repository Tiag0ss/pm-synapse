/**
 * Detect `@` vault / `/` note autocomplete contexts inside wikilinks and
 * frontmatter `related:` / `note:` values.
 */
import { pathStem } from './notePaths';

export type LinkSuggestMode = 'vaults' | 'notes';

export type LinkSuggestContext = {
  mode: LinkSuggestMode;
  /** Inclusive start of the span replaced on accept */
  replaceStart: number;
  /** Exclusive end (caret) */
  replaceEnd: number;
  query: string;
  /** Set when suggesting notes under `@slug/` */
  vaultSlug: string | null;
  /** True when the caret is in a YAML frontmatter value */
  inFrontmatter: boolean;
};

export type LinkSuggestItem = {
  id: string;
  label: string;
  detail?: string;
  /** Text inserted for replaceStart…replaceEnd */
  insert: string;
  /** After vault pick, immediately open notes for this slug */
  followWithNotes?: string;
};

function isInFrontmatter(value: string, caret: number): boolean {
  if (!value.startsWith('---')) return false;
  const end = value.indexOf('\n---', 3);
  if (end < 0) return caret > 3;
  return caret > 3 && caret <= end;
}

function isUnderRelatedList(value: string, lineStart: number): boolean {
  const lines = value.slice(0, lineStart).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (/^\s*related\s*:/i.test(l)) return true;
    if (/^\s*-\s+/.test(l)) continue;
    if (/^[a-zA-Z_][\w-]*\s*:/.test(l.trim()) || /^\s+[a-zA-Z_][\w-]*\s*:/.test(l)) {
      return false;
    }
  }
  return false;
}

function findOpenWikilinkSpan(
  value: string,
  caret: number
): { start: number; inner: string } | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf('[[');
  if (open < 0) return null;
  const afterOpen = before.slice(open + 2);
  if (afterOpen.includes(']]') || afterOpen.includes('\n')) return null;
  return { start: open + 2, inner: afterOpen };
}

function findFrontmatterLinkSpan(
  value: string,
  caret: number
): { start: number; inner: string } | null {
  if (!isInFrontmatter(value, caret)) return null;
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
  const line = value.slice(lineStart, caret);

  let m = line.match(/^(\s*related\s*:\s*)(.*)$/i);
  if (m) return { start: lineStart + m[1].length, inner: m[2] };

  m = line.match(/^(\s*note\s*:\s*)(.*)$/i);
  if (m) return { start: lineStart + m[1].length, inner: m[2] };

  m = line.match(/^(\s*-\s+)(.*)$/);
  if (m && isUnderRelatedList(value, lineStart)) {
    return { start: lineStart + m[1].length, inner: m[2] };
  }
  return null;
}

/** Strip leading quotes / optional [[ from a YAML or inline value. */
function stripValueDecorators(inner: string): { text: string; offset: number } {
  let text = inner;
  let offset = 0;
  const leadWiki = text.match(/^\[\[/);
  if (leadWiki) {
    text = text.slice(2);
    offset += 2;
  }
  const leadQuote = text.match(/^["']/);
  if (leadQuote) {
    text = text.slice(1);
    offset += 1;
  }
  return { text, offset };
}

function contextFromInner(
  absoluteStart: number,
  inner: string,
  caret: number,
  inFrontmatter: boolean
): LinkSuggestContext | null {
  const { text, offset } = stripValueDecorators(inner);
  const base = absoluteStart + offset;
  const atIdx = text.lastIndexOf('@');
  if (atIdx >= 0) {
    const afterAt = text.slice(atIdx + 1);
    const slash = afterAt.indexOf('/');
    if (slash < 0) {
      return {
        mode: 'vaults',
        replaceStart: base + atIdx,
        replaceEnd: caret,
        query: afterAt,
        vaultSlug: null,
        inFrontmatter,
      };
    }
    const slug = afterAt.slice(0, slash);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) return null;
    return {
      mode: 'notes',
      replaceStart: base + atIdx + 1 + slash + 1,
      replaceEnd: caret,
      query: afterAt.slice(slash + 1),
      vaultSlug: slug,
      inFrontmatter,
    };
  }

  const slashIdx = text.lastIndexOf('/');
  if (slashIdx >= 0) {
    const beforeSlash = text.slice(0, slashIdx).trim();
    // Lone `/` trigger (no folder prefix) — replace the slash with the note title.
    if (!beforeSlash) {
      return {
        mode: 'notes',
        replaceStart: base + slashIdx,
        replaceEnd: caret,
        query: text.slice(slashIdx + 1),
        vaultSlug: null,
        inFrontmatter,
      };
    }
    return {
      mode: 'notes',
      replaceStart: base + slashIdx + 1,
      replaceEnd: caret,
      query: text.slice(slashIdx + 1),
      vaultSlug: null,
      inFrontmatter,
    };
  }

  return null;
}

export function detectLinkSuggestContext(
  value: string,
  caret: number
): LinkSuggestContext | null {
  if (caret < 0 || caret > value.length) return null;
  const wiki = findOpenWikilinkSpan(value, caret);
  if (wiki) {
    const ctx = contextFromInner(wiki.start, wiki.inner, caret, false);
    if (ctx) return ctx;
  }
  const fm = findFrontmatterLinkSpan(value, caret);
  if (fm) return contextFromInner(fm.start, fm.inner, caret, true);
  return null;
}

export function noteSuggestLabel(title: string, path?: string): string {
  const stem = pathStem(path || '');
  if (stem && stem.toLowerCase() !== title.replace(/\\/g, '/').toLowerCase()) {
    return `${title} · ${stem}`;
  }
  return title;
}

/** Prefer title for insertion (resolves via resolveNoteId). */
export function noteSuggestInsert(title: string, path?: string): string {
  const t = String(title || '').trim();
  if (t) return t;
  return pathStem(path || '') || 'note';
}

/** Approximate caret pixel position inside a textarea (for popup placement). */
export function caretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number
): { top: number; left: number; lineHeight: number } {
  const div = document.createElement('div');
  const style = window.getComputedStyle(textarea);
  const props = [
    'direction',
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontSizeAdjust',
    'lineHeight',
    'fontFamily',
    'textAlign',
    'textTransform',
    'textIndent',
    'textDecoration',
    'letterSpacing',
    'wordSpacing',
    'tabSize',
    'MozTabSize',
    'whiteSpace',
    'wordBreak',
    'wordWrap',
  ] as const;
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  for (const prop of props) {
    div.style.setProperty(prop, style.getPropertyValue(prop));
  }
  div.style.overflow = 'hidden';
  div.style.width = `${textarea.clientWidth}px`;
  div.textContent = textarea.value.slice(0, position);
  const span = document.createElement('span');
  span.textContent = textarea.value.slice(position) || '.';
  div.appendChild(span);
  document.body.appendChild(div);
  const top = span.offsetTop - textarea.scrollTop;
  const left = span.offsetLeft - textarea.scrollLeft;
  const lineHeight = parseFloat(style.lineHeight) || 20;
  document.body.removeChild(div);
  return { top, left, lineHeight };
}
