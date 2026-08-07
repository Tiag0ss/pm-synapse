import matter from 'gray-matter';
import {
  resolveCrossVaultWikilink,
  resolveNoteId,
  type LinkableVaultNotes,
  type NoteResolveEntry,
} from './notePaths';
import { parseCheckboxes } from './checkboxes';
import {
  normalizeEstimateCategory,
  parseEstimateFromFrontmatterTodo,
  stripTrailingEstimateMeta,
  UNCATEGORIZED_ESTIMATE_TASK,
  type TaskEstimateMeta,
} from './taskEstimate';

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
 * Quote bare `@vault/path` and `[[…]]` values in the YAML block so js-yaml
 * does not treat `@` / `[` as special and abort the whole frontmatter parse.
 */
export function quoteFragileYamlLinkValues(markdown: string): string {
  const input = String(markdown || '');
  if (!input.startsWith('---')) return input;
  const end = input.match(/\n---\s*(?:\n|$)/);
  if (!end || end.index == null) return input;
  const yaml = input.slice(3, end.index);
  const rest = input.slice(end.index);
  const fixed = yaml.replace(
    /^([ \t]*(?:-\s+|[a-zA-Z_][\w-]*\s*:\s*))(@\S+|\[\[.*?\]\])\s*$/gm,
    (_full, lead: string, value: string) => {
      const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${lead}"${escaped}"`;
    }
  );
  return `---${fixed}${rest}`;
}

/**
 * Split YAML frontmatter from Markdown.
 * Keeps body usable for preview while exposing metadata.
 */
export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const input = String(markdown || '').replace(/^\uFEFF/, '');
  if (!input.startsWith('---')) {
    return { hasFrontmatter: false, data: {}, body: input, raw: null };
  }

  const sanitized = quoteFragileYamlLinkValues(input);

  try {
    const parsed = matter(sanitized);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value);
}

/**
 * Normalize a todo `note:` value to a wikilink target.
 * Accepts plain title/path, `[[target]]` / `[[target|alias]]` (prefer quoted in YAML),
 * or the nested arrays YAML produces for unquoted `[[…]]`.
 */
export function normalizeFrontmatterTodoNoteTarget(raw: unknown): string | null {
  if (raw == null) return null;

  const flattenYaml = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.flatMap(flattenYaml);
    if (v == null) return [];
    return [String(v)];
  };

  let s: string;
  if (Array.isArray(raw)) {
    const parts = flattenYaml(raw)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return null;
    s = parts.length === 1 ? parts[0] : parts.join('/');
  } else {
    s = String(raw).trim();
  }
  if (!s) return null;

  const wiki = s.match(/^\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]$/);
  if (wiki) return wiki[1].trim() || null;

  // Unquoted `[[target|alias]]` often becomes the single string "target|alias"
  const pipe = s.indexOf('|');
  if (pipe >= 0 && !s.includes('[') && !s.includes(']')) {
    s = s.slice(0, pipe).trim();
  }
  return s || null;
}

/** Prefer common plan/todo fields first when showing object rows. */
function objectKeyOrder(obj: Record<string, unknown>): string[] {
  const keys = Object.keys(obj);
  const preferred = [
    'id',
    'status',
    'title',
    'name',
    'content',
    'summary',
    'description',
    'note',
  ];
  return [...preferred.filter((k) => keys.includes(k)), ...keys.filter((k) => !preferred.includes(k))];
}

function renderNoteLinkHtml(
  raw: unknown,
  notes: NoteResolveEntry[],
  linkableVaults: LinkableVaultNotes[] = []
): string {
  const target = normalizeFrontmatterTodoNoteTarget(raw);
  if (!target) return '';

  if (target.startsWith('@')) {
    const r = resolveCrossVaultWikilink(target, linkableVaults);
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
    return `<a class="synapse-wikilink" href="#note-${r.noteId}" data-note-id="${r.noteId}" data-vault-id="${r.vaultId}" data-vault-slug="${escapeAttr(r.vaultSlug)}" data-note-title="${escapeAttr(r.label)}">${escapeHtml(r.label)}</a>`;
  }

  const id = resolveNoteId(target, notes);
  const cls = id != null ? 'synapse-wikilink' : 'synapse-wikilink is-missing';
  const href = id != null ? `#note-${id}` : `#wiki-${encodeURIComponent(target)}`;
  return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeAttr(target)}">${escapeHtml(target)}</a>`;
}

/** Render `related:` list (or single value) as wikilink chips. */
function renderRelatedHtml(
  value: unknown,
  notes: NoteResolveEntry[],
  linkableVaults: LinkableVaultNotes[]
): string {
  const items = Array.isArray(value) ? value : [value];
  const links = items
    .map((item) => renderNoteLinkHtml(item, notes, linkableVaults))
    .filter(Boolean);
  if (!links.length) return `<span class="synapse-fm-empty">[]</span>`;
  return `<div class="synapse-fm-list synapse-fm-related">${links
    .map((html) => `<div class="synapse-fm-item">${html}</div>`)
    .join('')}</div>`;
}

/**
 * Parse top-level YAML `related:` into normalized wikilink targets.
 * Accepts a string or list; deduplicates case-insensitively.
 */
export function parseFrontmatterRelatedNotes(
  markdownOrData: string | FrontmatterData
): string[] {
  const data =
    typeof markdownOrData === 'string'
      ? parseFrontmatter(markdownOrData).data
      : markdownOrData || {};
  const raw = data.related;
  if (raw == null || raw === '') return [];

  const items = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const target = normalizeFrontmatterTodoNoteTarget(item);
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

function renderObjectHtml(
  obj: Record<string, unknown>,
  notes: NoteResolveEntry[],
  linkableVaults: LinkableVaultNotes[] = []
): string {
  const rows = objectKeyOrder(obj)
    .map((key) => {
      const value = obj[key];
      if (value === undefined || value === null || value === '') return '';
      const rendered =
        key === 'note'
          ? renderNoteLinkHtml(value, notes, linkableVaults)
          : renderValueHtml(value, notes, linkableVaults);
      if (!rendered) return '';
      return (
        `<div class="synapse-fm-kv">` +
        `<span class="synapse-fm-k">${escapeHtml(key)}</span>` +
        `<span class="synapse-fm-v">${rendered}</span>` +
        `</div>`
      );
    })
    .filter(Boolean)
    .join('');
  return `<div class="synapse-fm-object">${rows || '<span class="synapse-fm-empty">{}</span>'}</div>`;
}

/** HTML for a frontmatter value (scalars, lists, nested objects). */
function renderValueHtml(
  value: unknown,
  notes: NoteResolveEntry[],
  linkableVaults: LinkableVaultNotes[] = []
): string {
  if (value == null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return `<code class="synapse-fm-scalar">${escapeHtml(String(value))}</code>`;
  }
  if (typeof value === 'string') return escapeHtml(value);

  if (Array.isArray(value)) {
    if (!value.length) return `<span class="synapse-fm-empty">[]</span>`;
    if (value.every(isScalar)) {
      return value
        .map((item) => `<span class="synapse-fm-tag">${escapeHtml(String(item))}</span>`)
        .join('');
    }
    // Use divs (not <ul>) so preview list CSS cannot collapse nested key/value layout
    const items = value
      .map((item) => {
        if (isPlainObject(item)) {
          return `<div class="synapse-fm-item">${renderObjectHtml(item, notes, linkableVaults)}</div>`;
        }
        if (Array.isArray(item)) {
          return `<div class="synapse-fm-item">${renderValueHtml(item, notes, linkableVaults)}</div>`;
        }
        return `<div class="synapse-fm-item">${escapeHtml(String(item))}</div>`;
      })
      .join('');
    return `<div class="synapse-fm-list">${items}</div>`;
  }

  if (isPlainObject(value)) return renderObjectHtml(value, notes, linkableVaults);

  try {
    return `<pre class="synapse-fm-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  } catch {
    return escapeHtml(String(value));
  }
}

/** Compact properties card for Markdown preview / public wiki. */
export function renderFrontmatterHtml(
  data: FrontmatterData,
  notes: NoteResolveEntry[] = [],
  linkableVaults: LinkableVaultNotes[] = []
): string {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';

  const rows = entries
    .map(([key, value]) => {
      const rendered =
        key === 'related'
          ? renderRelatedHtml(value, notes, linkableVaults)
          : renderValueHtml(value, notes, linkableVaults);
      return (
        `<div class="synapse-fm-row">` +
        `<span class="synapse-fm-key">${escapeHtml(key)}</span>` +
        `<span class="synapse-fm-val">${rendered}</span>` +
        `</div>`
      );
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

/** Prefix for YAML todo markers stored in NoteCheckboxTasks / PM synapseMarkerId. */
export const FRONTMATTER_TODO_MARKER_PREFIX = 'fm:';

export type FrontmatterTodo = {
  id: string;
  content: string;
  status: string;
  checked: boolean;
  /** Index within the todos array */
  arrayIndex: number;
  /** Linked note title/path from YAML `note:` (normalized). */
  noteTarget: string | null;
  /** Optional planning category (`category:`). */
  category: string | null;
  estimate?: TaskEstimateMeta;
};

const DONE_STATUSES = new Set([
  'completed',
  'done',
  'true',
  'x',
  'yes',
  'closed',
  'cancelled',
  'canceled',
  'complete',
  'finished',
]);

function newTodoId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function frontmatterTodoMarkerId(todoId: string): string {
  return `${FRONTMATTER_TODO_MARKER_PREFIX}${todoId}`;
}

export function isFrontmatterTodoMarker(markerId: string | null | undefined): boolean {
  return Boolean(markerId && String(markerId).startsWith(FRONTMATTER_TODO_MARKER_PREFIX));
}

export function frontmatterTodoIdFromMarker(markerId: string): string | null {
  if (!isFrontmatterTodoMarker(markerId)) return null;
  return String(markerId).slice(FRONTMATTER_TODO_MARKER_PREFIX.length) || null;
}

function todoCheckedFromStatus(status: unknown): boolean {
  if (typeof status === 'boolean') return status;
  return DONE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function todoContentFromObj(obj: Record<string, unknown>, fallbackId: string): string {
  for (const key of ['content', 'title', 'summary', 'description', 'name']) {
    const v = obj[key];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return fallbackId;
}

function normalizeTodoCategory(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const s = String(raw).trim();
    return s || null;
  }
  return null;
}

function normalizeTodoEntry(
  raw: unknown,
  arrayIndex: number
): Omit<FrontmatterTodo, 'id'> & { id: string | null } {
  if (isPlainObject(raw)) {
    const idRaw = raw.id != null ? String(raw.id).trim() : '';
    const id = idRaw || null;
    const status = raw.status != null ? String(raw.status) : 'pending';
    const content = todoContentFromObj(raw, id || `todo-${arrayIndex + 1}`);
    const estimate = parseEstimateFromFrontmatterTodo(raw);
    const noteTarget = normalizeFrontmatterTodoNoteTarget(raw.note);
    const category =
      normalizeTodoCategory(raw.category) ||
      normalizeTodoCategory(raw.categoria) ||
      normalizeTodoCategory(raw.cat);
    return {
      id,
      content,
      status,
      checked: todoCheckedFromStatus(raw.status),
      arrayIndex,
      noteTarget,
      category,
      estimate:
        estimate.estimatedHours != null || estimate.unscheduledWork === true
          ? estimate
          : undefined,
    };
  }
  if (typeof raw === 'string' && raw.trim()) {
    return {
      id: null,
      content: raw.trim(),
      status: 'pending',
      checked: false,
      arrayIndex,
      noteTarget: null,
      category: null,
    };
  }
  return {
    id: null,
    content: `todo-${arrayIndex + 1}`,
    status: 'pending',
    checked: false,
    arrayIndex,
    noteTarget: null,
    category: null,
  };
}

/** Parse `todos:` list from YAML frontmatter into Planner-ready entries. */
export function parseFrontmatterTodos(markdown: string): FrontmatterTodo[] {
  const { data } = parseFrontmatter(markdown);
  const raw = data.todos;
  if (!Array.isArray(raw) || !raw.length) return [];
  const out: FrontmatterTodo[] = [];
  for (let i = 0; i < raw.length; i++) {
    const n = normalizeTodoEntry(raw[i], i);
    if (!n.content.trim()) continue;
    out.push({
      id: n.id || '',
      content: n.content,
      status: n.status,
      checked: n.checked,
      arrayIndex: i,
      noteTarget: n.noteTarget,
      category: n.category,
      estimate: n.estimate,
    });
  }
  return out;
}

/**
 * Rewrite frontmatter todo `note:` targets when a linked note is renamed.
 * Returns null when nothing changed.
 */
export function rewriteFrontmatterTodoNoteTargets(
  markdown: string,
  replacements: Array<{ from: string; to: string }>
): string | null {
  if (!replacements.length) return null;
  const parsed = parseFrontmatter(markdown);
  if (!parsed.hasFrontmatter || !Array.isArray(parsed.data.todos)) return null;

  const normalized = normalizeReplacements(replacements);
  if (!normalized.length) return null;

  let changed = false;
  const nextData = rewriteTodosInData(parsed.data, (item) => {
    if (!isPlainObject(item) || item.note == null) return item;
    const next = rewriteRawNoteTarget(item.note, normalized);
    if (!next.changed) return item;
    changed = true;
    return { ...item, note: next.value };
  });
  if (!changed) return null;
  return stringifyWithFrontmatter(nextData, parsed.body);
}

/**
 * Rewrite top-level `related:` targets when a linked note is renamed.
 * Returns null when nothing changed.
 */
export function rewriteFrontmatterRelatedTargets(
  markdown: string,
  replacements: Array<{ from: string; to: string }>
): string | null {
  if (!replacements.length) return null;
  const parsed = parseFrontmatter(markdown);
  if (!parsed.hasFrontmatter || parsed.data.related == null) return null;

  const normalized = normalizeReplacements(replacements);
  if (!normalized.length) return null;

  let changed = false;
  const raw = parsed.data.related;
  let nextRelated: unknown = raw;

  if (Array.isArray(raw)) {
    nextRelated = raw.map((item) => {
      const next = rewriteRawNoteTarget(item, normalized);
      if (next.changed) changed = true;
      return next.value;
    });
  } else {
    const next = rewriteRawNoteTarget(raw, normalized);
    if (next.changed) {
      changed = true;
      nextRelated = next.value;
    }
  }

  if (!changed) return null;
  return stringifyWithFrontmatter({ ...parsed.data, related: nextRelated }, parsed.body);
}

function normalizeReplacements(
  replacements: Array<{ from: string; to: string }>
): Array<{ from: string; to: string }> {
  return replacements
    .map((r) => ({
      from: String(r.from || '').trim(),
      to: String(r.to || '').trim(),
    }))
    .filter((r) => r.from && r.to && r.from.toLowerCase() !== r.to.toLowerCase());
}

function rewriteRawNoteTarget(
  raw: unknown,
  replacements: Array<{ from: string; to: string }>
): { value: unknown; changed: boolean } {
  const target = normalizeFrontmatterTodoNoteTarget(raw);
  if (!target) return { value: raw, changed: false };
  for (const { from, to } of replacements) {
    if (target.toLowerCase() !== from.toLowerCase()) continue;
    const rawStr = typeof raw === 'string' ? raw.trim() : '';
    const wiki = rawStr.match(/^\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]$/);
    if (wiki) {
      const alias = wiki[2];
      return {
        value: alias != null && String(alias).trim() ? `[[${to}|${alias}]]` : `[[${to}]]`,
        changed: true,
      };
    }
    return { value: to, changed: true };
  }
  return { value: raw, changed: false };
}

function rewriteTodosInData(
  data: FrontmatterData,
  mapItem: (item: unknown, index: number) => unknown
): FrontmatterData {
  const raw = data.todos;
  if (!Array.isArray(raw)) return data;
  return { ...data, todos: raw.map((item, i) => mapItem(item, i)) };
}

function stringifyWithFrontmatter(data: FrontmatterData, body: string): string {
  return matter.stringify(body || '', data).replace(/^\uFEFF/, '');
}

/** Ensure every frontmatter todo has a stable `id`; rewrites markdown when needed. */
export function ensureFrontmatterTodoIds(markdown: string): {
  markdown: string;
  changed: boolean;
  todos: FrontmatterTodo[];
} {
  const parsed = parseFrontmatter(markdown);
  if (!parsed.hasFrontmatter || !Array.isArray(parsed.data.todos)) {
    return { markdown, changed: false, todos: [] };
  }

  let changed = false;
  const nextData = rewriteTodosInData(parsed.data, (item, i) => {
    if (isPlainObject(item)) {
      const idRaw = item.id != null ? String(item.id).trim() : '';
      if (idRaw) return item;
      changed = true;
      return { ...item, id: newTodoId() };
    }
    if (typeof item === 'string' && item.trim()) {
      changed = true;
      return { id: newTodoId(), content: item.trim(), status: 'pending' };
    }
    if (item == null) return item;
    changed = true;
    return { id: newTodoId(), content: `todo-${i + 1}`, status: 'pending' };
  });

  const markdownOut = changed ? stringifyWithFrontmatter(nextData, parsed.body) : markdown;
  return {
    markdown: markdownOut,
    changed,
    todos: parseFrontmatterTodos(markdownOut),
  };
}

export type ApplyFrontmatterTodoInput = {
  id?: string | null;
  content: string;
  status?: string | null;
  hours?: number | null;
  category?: string | null;
  unscheduled?: boolean | null;
  note?: string | null;
};

/**
 * Replace YAML `todos:` with the given list (stable ids generated when missing).
 * Preserves other frontmatter keys and the markdown body. Leaves `estimate:` untouched.
 */
export function applyFrontmatterTodosList(
  markdown: string,
  todos: ApplyFrontmatterTodoInput[]
): string {
  const parsed = parseFrontmatter(markdown);
  const nextTodos = todos
    .map((t) => {
      const content = String(t.content || '').trim();
      if (!content) return null;
      const row: Record<string, unknown> = {
        id: String(t.id || '').trim() || newTodoId(),
        content,
        status: String(t.status || '').trim() || 'pending',
      };
      if (t.hours != null && Number.isFinite(Number(t.hours))) {
        row.hours = Number(t.hours);
      }
      const category = t.category != null ? String(t.category).trim() : '';
      if (category) row.category = category;
      if (t.unscheduled === true) row.unscheduled = true;
      const note = t.note != null ? String(t.note).trim() : '';
      if (note) row.note = note;
      return row;
    })
    .filter((row): row is Record<string, unknown> => row != null);

  const nextData: FrontmatterData = { ...parsed.data, todos: nextTodos };
  return stringifyWithFrontmatter(nextData, parsed.body);
}

/**
 * Set a frontmatter todo status by id (`completed` / `pending`).
 * Returns null if the todo id is not found.
 */
export function setFrontmatterTodoStatus(
  markdown: string,
  todoId: string,
  checked: boolean
): string | null {
  return setFrontmatterTodoStatusLabel(
    markdown,
    todoId,
    checked ? 'completed' : 'pending'
  );
}

/**
 * Set a frontmatter todo `status` to an arbitrary label (e.g. Planner status Name).
 * Returns null if the todo id is not found.
 */
export function setFrontmatterTodoStatusLabel(
  markdown: string,
  todoId: string,
  statusLabel: string
): string | null {
  const parsed = parseFrontmatter(markdown);
  if (!parsed.hasFrontmatter || !Array.isArray(parsed.data.todos)) return null;

  const status = String(statusLabel || '').trim() || 'pending';
  let found = false;
  const nextData = rewriteTodosInData(parsed.data, (item) => {
    if (!isPlainObject(item)) return item;
    if (String(item.id || '').trim() !== todoId) return item;
    found = true;
    return { ...item, status };
  });
  if (!found) return null;
  return stringifyWithFrontmatter(nextData, parsed.body);
}

const TOTAL_HOURS_KEYS = new Set(['totalhours', 'total_hours', 'total']);
const ESTIMATE_SECTION_KEYS = new Set(['estimate', 'estimates', 'categories', 'categorias']);

function isTotalHoursKey(key: string): boolean {
  return TOTAL_HOURS_KEYS.has(key.toLowerCase());
}

function isEstimateSectionKey(key: string): boolean {
  return ESTIMATE_SECTION_KEYS.has(key.toLowerCase());
}

export type CategoryEstimateTotals = {
  /** Category name → hours (FM `category:` / checkbox paren + hours; missing → Other) */
  categories: Record<string, number>;
  totalHours: number;
};

function addHoursToCategory(
  categories: Record<string, number>,
  category: string | null | undefined,
  hours: number
) {
  const key = normalizeEstimateCategory(category);
  categories[key] = (categories[key] || 0) + hours;
}

function orderCategoryEstimates(categories: Record<string, number>): Record<string, number> {
  const keys = Object.keys(categories).sort((a, b) => {
    const aOther = a.toLowerCase() === UNCATEGORIZED_ESTIMATE_TASK.toLowerCase();
    const bOther = b.toLowerCase() === UNCATEGORIZED_ESTIMATE_TASK.toLowerCase();
    if (aOther && !bOther) return 1;
    if (!aOther && bOther) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
  const ordered: Record<string, number> = {};
  for (const key of keys) {
    ordered[key] = roundHours(categories[key]);
  }
  return ordered;
}

/**
 * Sum checkbox `(Nh[, Category])` + frontmatter todo `hours` / `category`
 * into category buckets (uncategorized → Other).
 */
export function computeFrontmatterCategoryEstimates(markdown: string): CategoryEstimateTotals {
  const categories: Record<string, number> = {};
  let totalHours = 0;

  for (const box of parseCheckboxes(markdown)) {
    const { meta } = stripTrailingEstimateMeta(box.text);
    const hours = meta.estimatedHours;
    if (hours == null || !Number.isFinite(hours)) continue;
    totalHours += hours;
    addHoursToCategory(categories, meta.category, hours);
  }

  for (const t of parseFrontmatterTodos(markdown)) {
    const hours = t.estimate?.estimatedHours;
    if (hours == null || !Number.isFinite(hours)) continue;
    totalHours += hours;
    addHoursToCategory(categories, t.category, hours);
  }

  return {
    categories: orderCategoryEstimates(categories),
    totalHours: roundHours(totalHours),
  };
}

function roundHours(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build YAML `estimate:` list entries (categories + trailing Total):
 *   estimate:
 *     - Task: Design
 *       hours: 5
 *       indent: 1
 *     - Task: Other
 *       hours: 2
 *       indent: 1
 *     - Task: Total
 *       hours: 7
 *       indent: 0
 */
export function buildEstimateTaskList(
  categories: Record<string, number>,
  totalHours: number
): Array<{ Task: string; hours: number; indent: number }> {
  const list = Object.entries(categories).map(([Task, hours]) => ({
    Task,
    hours: roundHours(hours),
    indent: 1,
  }));
  list.push({ Task: 'Total', hours: roundHours(totalHours), indent: 0 });
  return list;
}

/**
 * Recalculate `estimate:` from checkbox + frontmatter todo hours/category as a
 * list of `{ Task, hours, indent }` ending with `Task: Total` (indent 0).
 * Missing category → Other. Removes legacy top-level `totalHours` / `categories`.
 */
export function recalculateFrontmatterEstimations(markdown: string): {
  markdown: string;
  changed: boolean;
  categories: Record<string, number>;
  totalHours: number;
} {
  const parsed = parseFrontmatter(markdown);
  const { categories, totalHours } = computeFrontmatterCategoryEstimates(markdown);

  if (!Object.keys(categories).length && totalHours === 0) {
    return { markdown, changed: false, categories, totalHours };
  }

  // Rebuild data so `estimate` is the trailing key (Total is last list item).
  const nextData: FrontmatterData = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (isEstimateSectionKey(key) || isTotalHoursKey(key)) continue;
    nextData[key] = value;
  }
  nextData.estimate = buildEstimateTaskList(categories, totalHours);

  const markdownOut = stringifyWithFrontmatter(nextData, parsed.body);
  const changed = markdownOut !== markdown;
  return { markdown: markdownOut, changed, categories, totalHours };
}
