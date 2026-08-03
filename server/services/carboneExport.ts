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
import logger from '../utils/logger';

export type NoteExportSource = {
  title: string;
  path: string;
  bodyMarkdown: string;
  vaultName: string;
  authorUsername?: string | null;
  authorEmail?: string | null;
};

/** Light Markdown → plain text for Word body slot. */
export function markdownToPlainBody(markdown: string): string {
  let s = String(markdown || '');
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^[\s]*[-*+]\s+/gm, '• ');
  s = s.replace(/^[\s]*\d+\.\s+/gm, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
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

/**
 * Build Carbone `d` object: core fields + frontmatter under `fm` and flattened
 * (non-colliding) keys on the root for convenient `{d.client}` markers.
 */
export function buildCarboneData(source: NoteExportSource): Record<string, unknown> {
  const parsed = parseFrontmatter(source.bodyMarkdown);
  const fm = { ...parsed.data };
  const tags = frontmatterTags(parsed.data);
  const todos = parseFrontmatterTodos(source.bodyMarkdown).map((t) => ({
    id: t.id,
    content: t.content,
    status: t.status,
    checked: t.checked,
    hours: t.estimate?.estimatedHours ?? null,
    unscheduled: t.estimate?.unscheduledWork === true,
  }));

  const reserved = new Set([
    'title',
    'path',
    'body',
    'bodyMarkdown',
    'vaultName',
    'exportedAt',
    'author',
    'authorEmail',
    'tags',
    'todos',
    'fm',
  ]);

  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (reserved.has(key)) continue;
    if (key === 'tag') continue;
    flat[key] = Array.isArray(value)
      ? value.map((v) => (typeof v === 'object' ? v : safeScalar(v)))
      : safeScalar(value);
  }

  return {
    title: source.title,
    path: source.path,
    body: markdownToPlainBody(parsed.body),
    bodyMarkdown: parsed.body,
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
  const tmpPath = path.join(os.tmpdir(), `synapse-carbone-${randomUUID()}.docx`);
  await fs.writeFile(tmpPath, file.buffer);
  try {
    const buffer = await renderFromPath(tmpPath, data);
    const leaf =
      (params.source.title || 'note').replace(/[/\\?%*:|"<>]/g, '-').trim().slice(0, 80) ||
      'note';
    return {
      buffer,
      fileName: `${leaf}.docx`,
      templateLabel: file.meta.label,
    };
  } catch (error) {
    logger.error('Carbone render failed', { error, templateId: params.exportTemplateId });
    throw Object.assign(
      new Error(error instanceof Error ? error.message : 'Failed to fill Word template'),
      { status: 500 }
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => undefined);
  }
}
