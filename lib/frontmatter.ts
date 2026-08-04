import matter from 'gray-matter';
import { resolveNoteId, type NoteResolveEntry } from './notePaths';
import {
  parseEstimateFromFrontmatterTodo,
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

function renderNoteLinkHtml(raw: unknown, notes: NoteResolveEntry[]): string {
  const target = normalizeFrontmatterTodoNoteTarget(raw);
  if (!target) return '';
  const id = resolveNoteId(target, notes);
  const cls = id != null ? 'synapse-wikilink' : 'synapse-wikilink is-missing';
  const href = id != null ? `#note-${id}` : `#wiki-${encodeURIComponent(target)}`;
  return `<a class="${cls}" href="${href}" data-note-id="${id ?? ''}" data-note-title="${escapeAttr(target)}">${escapeHtml(target)}</a>`;
}

function renderObjectHtml(obj: Record<string, unknown>, notes: NoteResolveEntry[]): string {
  const rows = objectKeyOrder(obj)
    .map((key) => {
      const value = obj[key];
      if (value === undefined || value === null || value === '') return '';
      const rendered =
        key === 'note'
          ? renderNoteLinkHtml(value, notes)
          : renderValueHtml(value, notes);
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
function renderValueHtml(value: unknown, notes: NoteResolveEntry[]): string {
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
          return `<div class="synapse-fm-item">${renderObjectHtml(item, notes)}</div>`;
        }
        if (Array.isArray(item)) {
          return `<div class="synapse-fm-item">${renderValueHtml(item, notes)}</div>`;
        }
        return `<div class="synapse-fm-item">${escapeHtml(String(item))}</div>`;
      })
      .join('');
    return `<div class="synapse-fm-list">${items}</div>`;
  }

  if (isPlainObject(value)) return renderObjectHtml(value, notes);

  try {
    return `<pre class="synapse-fm-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  } catch {
    return escapeHtml(String(value));
  }
}

/** Compact properties card for Markdown preview / public wiki. */
export function renderFrontmatterHtml(
  data: FrontmatterData,
  notes: NoteResolveEntry[] = []
): string {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';

  const rows = entries
    .map(([key, value]) => {
      return (
        `<div class="synapse-fm-row">` +
        `<span class="synapse-fm-key">${escapeHtml(key)}</span>` +
        `<span class="synapse-fm-val">${renderValueHtml(value, notes)}</span>` +
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
    return {
      id,
      content,
      status,
      checked: todoCheckedFromStatus(raw.status),
      arrayIndex,
      noteTarget,
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
    };
  }
  return {
    id: null,
    content: `todo-${arrayIndex + 1}`,
    status: 'pending',
    checked: false,
    arrayIndex,
    noteTarget: null,
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

  const normalized = replacements
    .map((r) => ({
      from: String(r.from || '').trim(),
      to: String(r.to || '').trim(),
    }))
    .filter((r) => r.from && r.to && r.from.toLowerCase() !== r.to.toLowerCase());
  if (!normalized.length) return null;

  let changed = false;
  const nextData = rewriteTodosInData(parsed.data, (item) => {
    if (!isPlainObject(item) || item.note == null) return item;
    const raw = item.note;
    const target = normalizeFrontmatterTodoNoteTarget(raw);
    if (!target) return item;
    for (const { from, to } of normalized) {
      if (target.toLowerCase() !== from.toLowerCase()) continue;
      changed = true;
      const rawStr = typeof raw === 'string' ? raw.trim() : '';
      const wiki = rawStr.match(/^\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]$/);
      if (wiki) {
        const alias = wiki[2];
        return {
          ...item,
          note: alias != null && String(alias).trim() ? `[[${to}|${alias}]]` : `[[${to}]]`,
        };
      }
      return { ...item, note: to };
    }
    return item;
  });
  if (!changed) return null;
  return stringifyWithFrontmatter(nextData, parsed.body);
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
