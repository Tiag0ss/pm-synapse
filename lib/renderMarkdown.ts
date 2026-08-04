import { marked } from 'marked';
import { sanitizeSynapseHtml } from '@/lib/sanitizeSynapseHtml';
import { resolveNoteId, type NoteResolveEntry } from '@/lib/notePaths';
import { parseFrontmatter, renderFrontmatterHtml } from '@/lib/frontmatter';
import { enhanceCodeCopyHtml } from '@/lib/codeCopy';
import { postprocessMarkdownHtml, preprocessMarkdownExtras } from '@/lib/markdownEnhance';

export type NoteIndexEntry = NoteResolveEntry;

export { resolveNoteId } from '@/lib/notePaths';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'user', 'api', 'note', 'task', 'project',
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Protect fenced/inline code so wiki/tag transforms skip them. */
function mapProtected(md: string, transform: (chunk: string) => string): string {
  const slots: string[] = [];
  const stash = (raw: string) => {
    slots.push(raw);
    return `\u0000MD${slots.length - 1}\u0000`;
  };
  let out = md.replace(/```[\s\S]*?```/g, stash).replace(/`[^`\n]+`/g, stash);
  out = transform(out);
  return out.replace(/\u0000MD(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}

function mentionTermsForNotes(
  notes: NoteIndexEntry[]
): Array<{ id: number; term: string; title: string }> {
  const leafCount = new Map<string, number>();
  for (const n of notes) {
    const leaf = String(n.title)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop()
      ?.toLowerCase();
    if (leaf) leafCount.set(leaf, (leafCount.get(leaf) || 0) + 1);
  }

  const terms: Array<{ id: number; term: string; title: string }> = [];
  for (const n of notes) {
    const candidates = [n.title];
    const leaf = String(n.title)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop();
    if (
      leaf &&
      leaf.length >= 3 &&
      leaf.toLowerCase() !== n.title.toLowerCase() &&
      leafCount.get(leaf.toLowerCase()) === 1
    ) {
      candidates.push(leaf);
    }
    for (const term of candidates) {
      const t = term.trim();
      if (t.length < 3 || STOP.has(t.toLowerCase()) || t.includes('/')) continue;
      terms.push({ id: n.id, term: t, title: n.title });
    }
  }
  return terms.sort((a, b) => b.term.length - a.term.length);
}

function linkifyUnlinkedMentions(chunk: string, notes: NoteIndexEntry[]): string {
  if (!notes.length) return chunk;
  const slots: string[] = [];
  const stash = (raw: string) => {
    slots.push(raw);
    return `\u0000MN${slots.length - 1}\u0000`;
  };
  let work = chunk
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, stash)
    .replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, stash)
    .replace(/<[^>]+>/g, stash);

  const terms = mentionTermsForNotes(notes);
  for (const { id, term, title } of terms) {
    const re = new RegExp(`(?<![\\w/#.\\u0000])(${escapeRegExp(term)})(?![\\w/.\\u0000])`, 'gi');
    work = work.replace(re, (match) => {
      const linked = `<a class="synapse-mention" href="#note-${id}" data-note-id="${id}" data-note-title="${escapeAttr(title)}" title="Unlinked mention of ${escapeAttr(title)}">${escapeHtml(match)}</a>`;
      return stash(linked);
    });
  }

  return work.replace(/\u0000MN(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}

/** Turn [[wikilinks]] and #tags into HTML-friendly Markdown. */
export function preprocessSynapseMarkdown(md: string, notes: NoteIndexEntry[] = []): string {
  return mapProtected(md || '', (chunk) => {
    // Protect existing HTML (TOC, callouts, math, …) so # inside href="#…" is not treated as a tag
    const htmlSlots: string[] = [];
    const stashHtml = (raw: string) => {
      htmlSlots.push(raw);
      return `\u0000HT${htmlSlots.length - 1}\u0000`;
    };
    let next = chunk.replace(/<[a-zA-Z/!][^>]*>/g, stashHtml);

    // Tags — only in plain text now
    next = next.replace(/(^|[^#\w/])#([a-zA-Z][\w/-]*)/g, (_m, lead: string, tag: string) => {
      return `${lead}<span class="synapse-tag">#${escapeHtml(tag)}</span>`;
    });

    // Keep checkbox markers as spans so the UI can attach Planner links
    next = next.replace(
      /<!--\s*synapse:cb:([a-zA-Z0-9_-]+)\s*-->/g,
      '<span class="synapse-cb-marker" data-marker-id="$1" hidden></span>'
    );

    next = next.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
      const t = String(target).trim();
      const label = String(alias ?? t).trim();
      const id = resolveNoteId(t, notes);
      const cls = id != null ? 'synapse-wikilink' : 'synapse-wikilink is-missing';
      const href = id != null ? `#note-${id}` : `#wiki-${encodeURIComponent(t)}`;
      return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeAttr(t)}">${escapeHtml(label)}</a>`;
    });

    next = linkifyUnlinkedMentions(next, notes);
    return next.replace(/\u0000HT(\d+)\u0000/g, (_, i) => htmlSlots[Number(i)] ?? '');
  });
}

export function renderSynapseMarkdown(md: string, notes: NoteIndexEntry[] = []): string {
  try {
    const fm = parseFrontmatter(md);
    const props = fm.hasFrontmatter ? renderFrontmatterHtml(fm.data) : '';
    const withExtras = preprocessMarkdownExtras(fm.body);
    const prepared = preprocessSynapseMarkdown(withExtras, notes);
    const html = marked.parse(prepared, { async: false, gfm: true }) as string;
    return sanitizeSynapseHtml(props + enhanceCodeCopyHtml(postprocessMarkdownHtml(html)));
  } catch {
    return '<p class="synapse-md-error">Preview error</p>';
  }
}

/** Inline markdown for sidebar task labels (bold, italic, code, links). */
export function renderInlineMarkdown(md: string, notes: NoteIndexEntry[] = []): string {
  try {
    const fm = parseFrontmatter(md || '');
    const prepared = preprocessSynapseMarkdown(fm.body, notes);
    return sanitizeSynapseHtml(marked.parseInline(prepared, { async: false, gfm: true }) as string);
  } catch {
    return escapeHtml(md || '');
  }
}
