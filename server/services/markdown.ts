import { marked } from 'marked';
import { resolveNoteId, type NoteResolveEntry } from './notePaths';
import {
  frontmatterTags,
  parseFrontmatter,
  renderFrontmatterHtml,
} from './frontmatter';
import { postprocessMarkdownHtml, preprocessMarkdownExtras } from './markdownEnhance';
import { sanitizeSynapseHtml } from './sanitizeSynapseHtml';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'user', 'api', 'note', 'task', 'project',
]);

/**
 * CommonMark needs a space after ATX hashes. `#Received Requirements` / `##Technical Design`
 * would otherwise become tags or plain text — insert the space when the line has multiple tokens.
 * Lone `#tag` lines are left unchanged. Keep in sync with lib/renderMarkdown.ts.
 */
function normalizeAtxHeadingSpaces(chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => {
      const m = line.match(/^(#{1,6})(\S)(.*)$/);
      if (!m) return line;
      const [, hashes, first, rest] = m;
      if (!/\s/.test(`${first}${rest}`)) return line;
      return `${hashes} ${first}${rest}`;
    })
    .join('\n');
}

export function extractWikiLinks(markdown: string): string[] {
  const links: string[] = [];
  const body = parseFrontmatter(markdown).body;
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    links.push(m[1].trim());
  }
  return links;
}

export function extractTags(markdown: string): string[] {
  const tags = new Set<string>();
  const fm = parseFrontmatter(markdown);
  for (const t of frontmatterTags(fm.data)) tags.add(t);
  const body = normalizeAtxHeadingSpaces(fm.body);
  const re = /(^|\s)#([a-zA-Z][\w/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    // Skip matches that are ATX heading openers (`# Title` at line start)
    const idx = m.index;
    const lineStart = body.lastIndexOf('\n', idx - 1) + 1;
    if (/^#{1,6}\s/.test(body.slice(lineStart)) && idx === lineStart) continue;
    tags.add(m[2].toLowerCase());
  }
  return [...tags];
}

export function findMentions(
  markdown: string,
  dictionary: Array<{ id: number; title: string; aliases: string[] }>,
  selfId: number
): number[] {
  const text = parseFrontmatter(markdown)
    .body.replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[[^\]]+\]\]/g, ' ');

  const leafCount = new Map<string, number>();
  for (const d of dictionary) {
    if (d.id === selfId) continue;
    const leaf = String(d.title)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop()
      ?.toLowerCase();
    if (leaf) leafCount.set(leaf, (leafCount.get(leaf) || 0) + 1);
  }

  const terms = dictionary
    .filter((d) => d.id !== selfId)
    .flatMap((d) => {
      const titles = [d.title, ...d.aliases].map((t) => t.trim()).filter(Boolean);
      const leaf = String(d.title)
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop();
      if (
        leaf &&
        leaf.length >= 3 &&
        !titles.some((t) => t.toLowerCase() === leaf.toLowerCase()) &&
        leafCount.get(leaf.toLowerCase()) === 1
      ) {
        titles.push(leaf);
      }
      return titles
        .filter((t) => t.length >= 3 && !STOP.has(t.toLowerCase()) && !t.includes('/'))
        .map((t) => ({ id: d.id, term: t }));
    })
    .sort((a, b) => b.term.length - a.term.length);

  const found = new Set<number>();
  const lower = text.toLowerCase();
  for (const { id, term } of terms) {
    if (found.has(id)) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx < 0) continue;
    const before = idx === 0 ? ' ' : lower[idx - 1];
    const after = lower[idx + term.length] || ' ';
    if (/\w/.test(before) || /\w/.test(after)) continue;
    found.add(id);
  }
  return [...found];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type MarkdownNoteRef = NoteResolveEntry;

/** Build mention search terms for rendering (unique leaf names included). */
export function mentionTermsForNotes(
  notes: MarkdownNoteRef[],
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

/** Turn unlinked title mentions into visually distinct links (after [[wikilinks]]). */
export function linkifyUnlinkedMentions(chunk: string, notes: MarkdownNoteRef[]): string {
  if (!notes.length) return chunk;
  const slots: string[] = [];
  const stash = (raw: string) => {
    slots.push(raw);
    return `\u0000MN${slots.length - 1}\u0000`;
  };
  // Protect existing markup (wikilinks, tags, HTML)
  let work = chunk
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, stash)
    .replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, stash)
    .replace(/<[^>]+>/g, stash);

  const terms = mentionTermsForNotes(notes);
  for (const { id, term, title } of terms) {
    const re = new RegExp(`(?<![\\w/#.\\u0000])(${escapeRegExp(term)})(?![\\w/.\\u0000])`, 'gi');
    work = work.replace(re, (match) => {
      const linked = `<a class="synapse-mention" href="#note-${id}" data-note-id="${id}" data-note-title="${escapeHtml(title)}" title="Unlinked mention of ${escapeHtml(title)}">${escapeHtml(match)}</a>`;
      return stash(linked);
    });
  }

  return work.replace(/\u0000MN(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'vault'
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

/** Convert [[wikilinks]] and #tags before marked so public/PM HTML shows them. */
export function preprocessSynapseMarkdown(md: string, notes: MarkdownNoteRef[] = []): string {
  return mapProtected(md || '', (chunk) => {
    const htmlSlots: string[] = [];
    const stashHtml = (raw: string) => {
      htmlSlots.push(raw);
      return `\u0000HT${htmlSlots.length - 1}\u0000`;
    };
    let next = normalizeAtxHeadingSpaces(chunk.replace(/<[a-zA-Z/!][^>]*>/g, stashHtml));

    next = next.replace(/(^|[^#\w/])#([a-zA-Z][\w/-]*)/g, (_m, lead: string, tag: string) => {
      return `${lead}<span class="synapse-tag">#${escapeHtml(tag)}</span>`;
    });
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
      return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
    });

    next = linkifyUnlinkedMentions(next, notes);
    return next.replace(/\u0000HT(\d+)\u0000/g, (_, i) => htmlSlots[Number(i)] ?? '');
  });
}

export function markdownToSafeHtml(md: string, notes: MarkdownNoteRef[] = []): string {
  const fm = parseFrontmatter(md);
  const props = fm.hasFrontmatter ? renderFrontmatterHtml(fm.data) : '';
  const withExtras = preprocessMarkdownExtras(fm.body);
  const html = marked.parse(preprocessSynapseMarkdown(withExtras, notes), {
    async: false,
    gfm: true,
  }) as string;
  return sanitizeSynapseHtml(props + enhanceCodeCopyHtml(postprocessMarkdownHtml(html)));
}

/** Keep in sync with lib/codeCopy.ts enhanceCodeCopyHtml */
function enhanceCodeCopyHtml(html: string): string {
  const slots: string[] = [];
  let out = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, (block) => {
    if (/\bsynapse-mermaid-source\b|\blanguage-mermaid\b/i.test(block)) {
      slots.push(block);
      return `\u0000PRE${slots.length - 1}\u0000`;
    }
    const wrapped =
      `<div class="synapse-code-block">` +
      `<div class="synapse-code-toolbar"><button type="button" class="synapse-copy-code" aria-label="Copy code" title="Copy">Copy</button></div>` +
      `${block}` +
      `</div>`;
    slots.push(wrapped);
    return `\u0000PRE${slots.length - 1}\u0000`;
  });
  out = out.replace(/<code\b([^>]*)>/gi, (_m, attrs: string) => {
    if (/\bsynapse-inline-copy\b/.test(attrs)) return `<code${attrs}>`;
    let next = attrs;
    if (!/\btitle=/i.test(next)) next += ` title="Click to copy"`;
    if (/\bclass="/i.test(next)) {
      return `<code${next.replace(/\bclass="/i, 'class="synapse-inline-copy ')}>`;
    }
    return `<code class="synapse-inline-copy"${next}>`;
  });
  return out.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}
