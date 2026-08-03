import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import carbone from 'carbone';
import {
  frontmatterTags,
  parseFrontmatter,
  parseFrontmatterTodos,
} from './frontmatter';
import { readExportTemplateFile } from './exportTemplates';
import { prepareDocxForExport, finalizeDocxExport } from './docxExportPrep';
import logger from '../utils/logger';

export type NoteExportSource = {
  title: string;
  path: string;
  bodyMarkdown: string;
  vaultName: string;
  authorUsername?: string | null;
  authorEmail?: string | null;
};

/** Core keys always set by Synapse — frontmatter must not overwrite these on the root. */
const RESERVED_ROOT_KEYS = new Set([
  'title',
  'path',
  'body',
  'bodyMarkdown',
  'paragraphs',
  'vaultName',
  'exportedAt',
  'author',
  'authorEmail',
  'tags',
  'todos',
  'fm',
]);

/** Light Markdown → plain text (fallback / non-styled consumers). */
export function markdownToPlainBody(markdown: string): string {
  let s = String(markdown || '');
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^#{1,6}\s+(.+?)\s*$/gm, '\n$1\n');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^[\s]*[-*+]\s+/gm, '• ');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function markdownToParagraphs(markdown: string): string[] {
  const plain = markdownToPlainBody(markdown);
  if (!plain) return [];
  return plain
    .split(/\n/)
    .map((line) => line.trimEnd())
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''));
}

function safeScalar(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Label-like keys that receive visual indent when `indent` / `level` is set. */
const INDENTABLE_LABEL_KEYS = new Set([
  'task',
  'name',
  'title',
  'label',
  'content',
  'description',
  'summary',
  'contributor',
  'text',
  'value',
]);

function indentPad(depth: number): string {
  // Em spaces — Word table cells often collapse normal spaces / tabs / even nbsp runs.
  return '\u2003'.repeat(Math.max(0, depth) * 2);
}

/** Normalize any YAML list so Carbone table loops get plain objects. */
function normalizeRows(raw: unknown): Array<Record<string, string | number | boolean | null>> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    if (item == null) {
      return { index: index + 1, indent: 0, indentPrefix: '' };
    }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      return { value: item, index: index + 1, indent: 0, indentPrefix: '' };
    }
    if (typeof item !== 'object' || Array.isArray(item)) {
      return { value: safeScalar(item), index: index + 1, indent: 0, indentPrefix: '' };
    }
    const out: Record<string, string | number | boolean | null> = { index: index + 1 };
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      out[k] = safeScalar(v);
    }
    const depthRaw = out.indent ?? out.level;
    const depth =
      typeof depthRaw === 'number' && Number.isFinite(depthRaw)
        ? Math.max(0, Math.min(12, Math.floor(depthRaw)))
        : 0;
    const pad = indentPad(depth);
    out.indent = depth;
    out.indentPrefix = pad;
    // Apply indent directly on label fields so templates that only use {d.list[i].Task}
    // still show nesting (Word often ignores a separate leading-space marker).
    if (pad) {
      for (const key of Object.keys(out)) {
        if (!INDENTABLE_LABEL_KEYS.has(key.toLowerCase())) continue;
        if (typeof out[key] !== 'string' || !out[key]) continue;
        const text = out[key] as string;
        if (text.startsWith(pad) || text.startsWith('\u00A0') || text.startsWith('\u2003')) continue;
        out[key] = pad + text;
      }
    }
    return out;
  });
}

/**
 * Keep at least one row so Carbone does not delete a table loop when the list is empty.
 * Placeholder keys are derived from the first real row when available.
 */
function ensureNonEmptyRows(
  rows: Array<Record<string, string | number | boolean | null>>
): Array<Record<string, string | number | boolean | null>> {
  if (rows.length) return rows;
  return [{ index: 1 }];
}

/**
 * Build Carbone `d` from note + frontmatter only — no domain-specific field names.
 * - Scalars: `{d.fm.<key>}` and flattened `{d.<key>}` when not reserved
 * - Arrays: normalized for `{d.<key>[i].<field>}`
 */
export function buildCarboneData(source: NoteExportSource): Record<string, unknown> {
  const parsed = parseFrontmatter(source.bodyMarkdown);
  const fmRaw = { ...(parsed.data || {}) } as Record<string, unknown>;
  const tags = frontmatterTags(parsed.data);
  const todos = parseFrontmatterTodos(source.bodyMarkdown).map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    checked: t.checked,
    hours: t.estimate?.estimatedHours ?? null,
    unscheduled: t.estimate?.unscheduledWork === true,
  }));

  const fm: Record<string, unknown> = {};
  const flat: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fmRaw)) {
    if (key === 'tag') continue;

    if (Array.isArray(value)) {
      const rows = ensureNonEmptyRows(normalizeRows(value));
      fm[key] = rows;
      if (!RESERVED_ROOT_KEYS.has(key)) {
        flat[key] = rows;
      }
      continue;
    }

    if (value != null && typeof value === 'object') {
      // Nested object: expose under fm only (use {d.fm.key.sub})
      fm[key] = value;
      continue;
    }

    const scalar = safeScalar(value);
    fm[key] = scalar;
    if (!RESERVED_ROOT_KEYS.has(key)) {
      flat[key] = scalar;
    }
  }

  return {
    title: source.title,
    path: source.path,
    body: markdownToPlainBody(parsed.body),
    bodyMarkdown: parsed.body,
    paragraphs: markdownToParagraphs(parsed.body),
    vaultName: source.vaultName,
    exportedAt: new Date().toISOString(),
    author: source.authorUsername || '',
    authorEmail: source.authorEmail || '',
    tags,
    todos,
    fm,
    ...flat,
  };
}

function renderFromPath(templatePath: string, data: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    carbone.render(templatePath, data, {}, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      if (Buffer.isBuffer(result)) {
        resolve(result);
        return;
      }
      if (typeof result === 'string') {
        resolve(Buffer.from(result, 'binary'));
        return;
      }
      reject(new Error('Carbone returned an empty document'));
    });
  });
}

export async function renderNoteDocx(params: {
  exportTemplateId: number;
  source: NoteExportSource;
}): Promise<{ buffer: Buffer; fileName: string; templateLabel: string }> {
  const file = await readExportTemplateFile(params.exportTemplateId);
  if (!file) {
    throw Object.assign(new Error('Export template not found'), { status: 404 });
  }

  const data = buildCarboneData(params.source);
  const bodyMarkdown = parseFrontmatter(params.source.bodyMarkdown).body;
  const tmpPath = path.join(os.tmpdir(), `synapse-carbone-${randomUUID()}.docx`);

  try {
    const prepared = await prepareDocxForExport(file.buffer, bodyMarkdown);
    await fs.writeFile(tmpPath, prepared);
    const rendered = await renderFromPath(tmpPath, data);
    const buffer = await finalizeDocxExport(rendered);
    const leaf =
      (params.source.title || 'note').replace(/[/\\?%*:|"<>]/g, '-').trim().slice(0, 80) ||
      'note';
    return {
      buffer,
      fileName: `${leaf}.docx`,
      templateLabel: file.meta.label,
    };
  } catch (error) {
    logger.error('Carbone render failed', {
      error,
      templateId: params.exportTemplateId,
    });
    throw Object.assign(
      new Error(error instanceof Error ? error.message : 'Failed to fill Word template'),
      { status: 500 }
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
