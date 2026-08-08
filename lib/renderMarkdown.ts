import { marked } from 'marked';
import { sanitizeSynapseHtml } from '@/lib/sanitizeSynapseHtml';
import {
  resolveCrossVaultWikilink,
  resolveNoteId,
  type LinkableVaultNotes,
  type NoteResolveEntry,
} from '@/lib/notePaths';
import { parseFrontmatter, renderFrontmatterHtml } from '@/lib/frontmatter';
import { enhanceCodeCopyHtml } from '@/lib/codeCopy';
import { postprocessMarkdownHtml, preprocessMarkdownExtras } from '@/lib/markdownEnhance';

export type NoteIndexEntry = NoteResolveEntry;

export type { LinkableVaultNotes };
export { resolveNoteId, resolveCrossVaultWikilink, parseCrossVaultWikilinkTarget } from '@/lib/notePaths';

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

/**
 * CommonMark needs a space after ATX hashes. Content like `#Received Requirements` or
 * `##Technical Design` would otherwise become #tags / plain text — insert the space when
 * the line has more than one token so marked can render real headings.
 * Lone `#tag` lines are left unchanged.
 *
 * Important: the char after the hash run must not be `#`, otherwise `#### Title` backtracks
 * to `###` + `# Title` and previews show a literal `#` in the heading.
 */
function normalizeAtxHeadingSpaces(chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => {
      const m = line.match(/^(#{1,6})([^\s#])(.*)$/);
      if (!m) return line;
      const [, hashes, first, rest] = m;
      if (!/\s/.test(`${first}${rest}`)) return line;
      return `${hashes} ${first}${rest}`;
    })
    .join('\n');
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
  notes: NoteIndexEntry[],
  excludeId?: number | null
): Array<{ id: number; term: string; title: string }> {
  const leafCount = new Map<string, number>();
  for (const n of notes) {
    if (excludeId != null && n.id === excludeId) continue;
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
    if (excludeId != null && n.id === excludeId) continue;
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

function linkifyUnlinkedMentions(
  chunk: string,
  notes: NoteIndexEntry[],
  excludeNoteId?: number | null
): string {
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

  const terms = mentionTermsForNotes(notes, excludeNoteId);
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
export function preprocessSynapseMarkdown(
  md: string,
  notes: NoteIndexEntry[] = [],
  linkableVaults: LinkableVaultNotes[] = [],
  excludeNoteId?: number | null
): string {
  return mapProtected(md || '', (chunk) => {
    // Protect existing HTML (TOC, callouts, math, …) so # inside href="#…" is not treated as a tag
    const htmlSlots: string[] = [];
    const stashHtml = (raw: string) => {
      htmlSlots.push(raw);
      return `\u0000HT${htmlSlots.length - 1}\u0000`;
    };
    // Do NOT turn <!--synapse:cb:--> into spans here — that injects HTML before marked and
    // historically broke task-list parsing/CSS. Promote markers in postprocess instead.
    let next = normalizeAtxHeadingSpaces(chunk.replace(/<[a-zA-Z/!][^>]*>/g, stashHtml));

    // Tags — only in plain text (heading lines already normalized to `# Title`)
    next = next.replace(/(^|[^#\w/])#([a-zA-Z][\w/-]*)/g, (_m, lead: string, tag: string) => {
      return `${lead}<span class="synapse-tag">#${escapeHtml(tag)}</span>`;
    });

    next = next.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
      const t = String(target).trim();
      const aliasLabel = alias != null ? String(alias).trim() : '';

      if (t.startsWith('@')) {
        const r = resolveCrossVaultWikilink(t, linkableVaults, aliasLabel || undefined);
        if (r.status === 'locked') {
          return (
            `<span class="synapse-wikilink is-locked" title="You don't have access to this note" aria-label="${escapeAttr(r.label)} (no access)">` +
            `${escapeHtml(r.label)}` +
            `<span class="synapse-wikilink-lock" aria-hidden="true">no access</span>` +
            `</span>`
          );
        }
        if (r.status === 'missing') {
          const href = `#wiki-${encodeURIComponent(`@${r.vaultSlug}/${r.label}`)}`;
          return `<a class="synapse-wikilink is-missing" href="${href}" data-vault-id="${r.vaultId}" data-vault-slug="${escapeAttr(r.vaultSlug)}" data-note-id="" data-note-title="${escapeAttr(r.label)}">${escapeHtml(r.label)}</a>`;
        }
        const href = `#note-${r.noteId}`;
        return `<a class="synapse-wikilink" href="${href}" data-note-id="${r.noteId}" data-vault-id="${r.vaultId}" data-vault-slug="${escapeAttr(r.vaultSlug)}" data-note-title="${escapeAttr(r.label)}">${escapeHtml(r.label)}</a>`;
      }

      const label = aliasLabel || t;
      const id = resolveNoteId(t, notes);
      const cls = id != null ? 'synapse-wikilink' : 'synapse-wikilink is-missing';
      const href = id != null ? `#note-${id}` : `#wiki-${encodeURIComponent(t)}`;
      return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeAttr(t)}">${escapeHtml(label)}</a>`;
    });

    next = linkifyUnlinkedMentions(next, notes, excludeNoteId);
    return next.replace(/\u0000HT(\d+)\u0000/g, (_, i) => htmlSlots[Number(i)] ?? '');
  });
}

export function renderSynapseMarkdown(
  md: string,
  notes: NoteIndexEntry[] = [],
  linkableVaults: LinkableVaultNotes[] = [],
  excludeNoteId?: number | null
): string {
  try {
    const fm = parseFrontmatter(md);
    const props = fm.hasFrontmatter ? renderFrontmatterHtml(fm.data, notes, linkableVaults) : '';
    const withExtras = preprocessMarkdownExtras(fm.body);
    const prepared = preprocessSynapseMarkdown(withExtras, notes, linkableVaults, excludeNoteId);
    const html = marked.parse(prepared, { async: false, gfm: true, breaks: true }) as string;
    return sanitizeSynapseHtml(props + enhanceCodeCopyHtml(postprocessMarkdownHtml(html)));
  } catch {
    return '<p class="synapse-md-error">Preview error</p>';
  }
}

/** Inline markdown for sidebar task labels (bold, italic, code, links). */
export function renderInlineMarkdown(
  md: string,
  notes: NoteIndexEntry[] = [],
  linkableVaults: LinkableVaultNotes[] = []
): string {
  try {
    const fm = parseFrontmatter(md || '');
    const prepared = preprocessSynapseMarkdown(fm.body, notes, linkableVaults);
    return sanitizeSynapseHtml(marked.parseInline(prepared, { async: false, gfm: true }) as string);
  } catch {
    return escapeHtml(md || '');
  }
}
