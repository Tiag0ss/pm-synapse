import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { resolveNoteId, type NoteResolveEntry } from './notePaths';
import {
  frontmatterTags,
  parseFrontmatter,
  renderFrontmatterHtml,
} from './frontmatter';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'user', 'api', 'note', 'task', 'project',
]);

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
  const re = /(^|\s)#([a-zA-Z][\w/-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fm.body))) {
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

  const terms = dictionary
    .filter((d) => d.id !== selfId)
    .flatMap((d) =>
      [d.title, ...d.aliases]
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !STOP.has(t.toLowerCase()) && !t.includes('/'))
        .map((t) => ({ id: d.id, term: t }))
    )
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

export type MarkdownNoteRef = NoteResolveEntry;

/** Convert [[wikilinks]] and #tags before marked so public/PM HTML shows them. */
export function preprocessSynapseMarkdown(md: string, notes: MarkdownNoteRef[] = []): string {
  return mapProtected(md || '', (chunk) => {
    let next = chunk.replace(/(^|[^#\w/])#([a-zA-Z][\w/-]*)/g, (_m, lead: string, tag: string) => {
      return `${lead}<span class="synapse-tag">#${escapeHtml(tag)}</span>`;
    });
    next = next.replace(/<!--\s*synapse:cb:[a-zA-Z0-9_-]+\s*-->/g, '');
    next = next.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
      const t = String(target).trim();
      const label = String(alias ?? t).trim();
      const id = resolveNoteId(t, notes);
      const cls = id != null ? 'synapse-wikilink' : 'synapse-wikilink is-missing';
      const href = id != null ? `#note-${id}` : `#wiki-${encodeURIComponent(t)}`;
      return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeHtml(t)}">${escapeHtml(label)}</a>`;
    });
    return next;
  });
}

export function markdownToSafeHtml(md: string, notes: MarkdownNoteRef[] = []): string {
  const fm = parseFrontmatter(md);
  const props = fm.hasFrontmatter ? renderFrontmatterHtml(fm.data) : '';
  const html = marked.parse(preprocessSynapseMarkdown(fm.body, notes), { async: false, gfm: true }) as string;
  return sanitizeHtml(props + html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'img',
      'h1',
      'h2',
      'span',
      'aside',
      'input',
    ],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel', 'class', 'data-note-title', 'data-note-id'],
      span: ['class'],
      aside: ['class', 'aria-label'],
      div: ['class'],
      img: ['src', 'alt', 'title', 'class'],
      input: ['type', 'checked', 'disabled'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowProtocolRelative: true,
    allowedSchemesAppliedToAttributes: ['href', 'src'],
  });
}
