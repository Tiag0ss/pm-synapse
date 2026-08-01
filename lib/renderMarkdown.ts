import { marked } from 'marked';
import { resolveNoteId, type NoteResolveEntry } from '@/lib/notePaths';
import { parseFrontmatter, renderFrontmatterHtml } from '@/lib/frontmatter';

export type NoteIndexEntry = NoteResolveEntry;

export { resolveNoteId } from '@/lib/notePaths';

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

/** Turn [[wikilinks]] and #tags into HTML-friendly Markdown. */
export function preprocessSynapseMarkdown(md: string, notes: NoteIndexEntry[] = []): string {
  return mapProtected(md || '', (chunk) => {
    // Tags first — never touch hrefs we inject for wikilinks below
    let next = chunk.replace(/(^|[^#\w/])#([a-zA-Z][\w/-]*)/g, (_m, lead: string, tag: string) => {
      return `${lead}<span class="synapse-tag">#${escapeHtml(tag)}</span>`;
    });

    // Hide Synapse task markers in preview
    next = next.replace(/<!--\s*synapse:cb:[a-zA-Z0-9_-]+\s*-->/g, '');

    next = next.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
      const t = String(target).trim();
      const label = String(alias ?? t).trim();
      const id = resolveNoteId(t, notes);
      const cls = id != null ? 'synapse-wikilink' : 'synapse-wikilink is-missing';
      const href = id != null ? `#note-${id}` : `#wiki-${encodeURIComponent(t)}`;
      return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeAttr(t)}">${escapeHtml(label)}</a>`;
    });

    return next;
  });
}

export function renderSynapseMarkdown(md: string, notes: NoteIndexEntry[] = []): string {
  try {
    const fm = parseFrontmatter(md);
    const props = fm.hasFrontmatter ? renderFrontmatterHtml(fm.data) : '';
    const prepared = preprocessSynapseMarkdown(fm.body, notes);
    const html = marked.parse(prepared, { async: false, gfm: true }) as string;
    return props + html;
  } catch {
    return '<p class="synapse-md-error">Preview error</p>';
  }
}

/** Inline markdown for sidebar task labels (bold, italic, code, links). */
export function renderInlineMarkdown(md: string, notes: NoteIndexEntry[] = []): string {
  try {
    const fm = parseFrontmatter(md || '');
    const prepared = preprocessSynapseMarkdown(fm.body, notes);
    return marked.parseInline(prepared, { async: false, gfm: true }) as string;
  } catch {
    return escapeHtml(md || '');
  }
}
