/**
 * Parse effort / unscheduled metadata from checkbox text or YAML todos.
 * Keep in sync with lib/taskEstimate.ts
 */

export type TaskEstimateMeta = {
  estimatedHours?: number;
  unscheduledWork?: boolean;
};

const HOURS_RE = /^(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours)?$/i;
const UNSCHEDULED_RE = /^(?:unscheduled|u)$/i;

function parseHoursToken(token: string): number | null {
  const m = String(token || '').trim().match(HOURS_RE);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function mergeMeta(into: TaskEstimateMeta, piece: TaskEstimateMeta): TaskEstimateMeta {
  const out = { ...into };
  if (piece.estimatedHours != null) out.estimatedHours = piece.estimatedHours;
  if (piece.unscheduledWork === true) out.unscheduledWork = true;
  return out;
}

/** Parse tokens inside a trailing `(…)` group (comma / · / ; separated). */
export function parseEstimateFromParenGroup(raw: string): TaskEstimateMeta {
  let meta: TaskEstimateMeta = {};
  const parts = String(raw || '')
    .split(/[,·;|/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    if (UNSCHEDULED_RE.test(part)) {
      meta = mergeMeta(meta, { unscheduledWork: true });
      continue;
    }
    const hours = parseHoursToken(part);
    if (hours != null) meta = mergeMeta(meta, { estimatedHours: hours });
  }
  return meta;
}

/**
 * Strip a trailing `(meta)` group from checkbox text.
 * Does not strip earlier parentheticals in the middle of the label.
 */
export function stripTrailingEstimateMeta(text: string): {
  text: string;
  meta: TaskEstimateMeta;
} {
  const input = String(text || '');
  const m = input.match(/^(.*?)(\s*)\(([^)]*)\)\s*$/);
  if (!m) return { text: input.trim(), meta: {} };
  const inner = m[3].trim();
  if (!inner) return { text: input.trim(), meta: {} };
  const meta = parseEstimateFromParenGroup(inner);
  if (meta.estimatedHours == null && meta.unscheduledWork !== true) {
    return { text: input.trim(), meta: {} };
  }
  return { text: m[1].trim(), meta };
}

function readNumberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!(key in obj) || obj[key] == null || obj[key] === '') continue;
    const n = Number(String(obj[key]).replace(',', '.').replace(/h$/i, ''));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function readUnscheduledField(obj: Record<string, unknown>): boolean | undefined {
  for (const key of ['unscheduled', 'unscheduledWork']) {
    if (!(key in obj)) continue;
    const v = obj[key];
    if (v === true || v === 1 || v === '1') return true;
    if (typeof v === 'string' && /^(true|yes|y|unscheduled)$/i.test(v.trim())) return true;
    if (v === false || v === 0 || v === '0') return false;
  }
  return undefined;
}

/** Read estimate fields from a YAML todo object. */
export function parseEstimateFromFrontmatterTodo(obj: Record<string, unknown>): TaskEstimateMeta {
  const meta: TaskEstimateMeta = {};
  const hours = readNumberField(obj, ['hours', 'estimatedHours', 'estimate']);
  if (hours != null) meta.estimatedHours = hours;
  const unscheduled = readUnscheduledField(obj);
  if (unscheduled === true) meta.unscheduledWork = true;
  return meta;
}

export function hasEstimateMeta(meta: TaskEstimateMeta | undefined): boolean {
  if (!meta) return false;
  return meta.estimatedHours != null || meta.unscheduledWork === true;
}
