import matter from 'gray-matter';

export type FrontmatterData = Record<string, unknown>;

export type ParsedFrontmatter = {
  /** True when a leading --- YAML block was present */
  hasFrontmatter: boolean;
  /** Parsed YAML object (empty if none / invalid) */
  data: FrontmatterData;
  /** Markdown body without the frontmatter block */
  body: string;
  /** Raw YAML between fences, or null */
  raw: string | null;
};

/**
 * Split YAML frontmatter from Markdown.
 * Keeps body usable for preview while exposing metadata.
 */
export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const input = String(markdown || '').replace(/^\uFEFF/, '');
  if (!input.startsWith('---')) {
    return { hasFrontmatter: false, data: {}, body: input, raw: null };
  }

  try {
    const parsed = matter(input);
    const raw =
      typeof parsed.matter === 'string' && parsed.matter.trim()
        ? parsed.matter.replace(/^\n+|\n+$/g, '')
        : null;
    return {
      hasFrontmatter: raw != null || Object.keys(parsed.data || {}).length > 0,
      data: (parsed.data || {}) as FrontmatterData,
      body: String(parsed.content || '').replace(/^\n+/, ''),
      raw,
    };
  } catch {
    // Malformed YAML: strip fences so preview isn't broken by --- HR rules
    const end = input.match(/\n---\s*(?:\n|$)/);
    if (!end || end.index == null) {
      return { hasFrontmatter: false, data: {}, body: input, raw: null };
    }
    const raw = input.slice(3, end.index).replace(/^\n+|\n+$/g, '');
    const body = input.slice(end.index + end[0].length);
    return { hasFrontmatter: true, data: {}, body, raw };
  }
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Compact properties card for Markdown preview / public wiki. */
export function renderFrontmatterHtml(data: FrontmatterData): string {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';

  const rows = entries
    .map(([key, value]) => {
      const isTags = key.toLowerCase() === 'tags' && Array.isArray(value);
      if (isTags) {
        const chips = (value as unknown[])
          .map((t) => `<span class="synapse-fm-tag">${escapeHtml(String(t))}</span>`)
          .join('');
        return `<div class="synapse-fm-row"><span class="synapse-fm-key">${escapeHtml(key)}</span><span class="synapse-fm-val">${chips}</span></div>`;
      }
      return `<div class="synapse-fm-row"><span class="synapse-fm-key">${escapeHtml(key)}</span><span class="synapse-fm-val">${escapeHtml(formatValue(value))}</span></div>`;
    })
    .join('');

  return `<aside class="synapse-frontmatter" aria-label="Note properties"><div class="synapse-fm-title">Properties</div>${rows}</aside>`;
}

/** Tags declared in frontmatter (`tags: [a, b]` or `tags: a`). */
export function frontmatterTags(data: FrontmatterData): string[] {
  const raw = data.tags ?? data.tag;
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  }
  return String(raw)
    .split(/[, ]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}
