import JSZip from 'jszip';
import path from 'path';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { titleToPath } from './checkboxes';
import { pathStem } from './notePaths';
import { rebuildNoteGraph, snapshotRevision } from './notesGraph';
import { saveVaultImage } from './vaultMedia';
import { frontmatterJsonString, parseFrontmatter } from './frontmatter';
import logger from '../utils/logger';

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_TOTAL = 80 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED = 8 * 1024 * 1024;
const MAX_NOTES = 500;
const MAX_IMAGES = 200;

const SKIP_NAME_RE = /(^|\/)(__MACOSX|\.git|\.obsidian|\.trash|node_modules)(\/|$)/i;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export type ZipImportResult = {
  created: number;
  updated: number;
  skipped: number;
  images: number;
  errors: Array<{ path: string; message: string }>;
};

function normalizeZipPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function isSkippable(zipPath: string): boolean {
  if (!zipPath || zipPath.endsWith('/')) return true;
  if (SKIP_NAME_RE.test(zipPath)) return true;
  const base = path.posix.basename(zipPath);
  if (base.startsWith('.') || base === 'Thumbs.db') return true;
  return false;
}

function stripRootFolder(paths: string[]): string {
  const tops = new Set(
    paths
      .map((p) => p.split('/')[0])
      .filter(Boolean)
  );
  if (tops.size === 1) {
    const only = [...tops][0];
    // If every path is under a single top folder and that folder isn't a lone file, strip it
    const allNested = paths.every((p) => p === only || p.startsWith(`${only}/`));
    if (allNested && paths.some((p) => p.includes('/'))) return only;
  }
  return '';
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function noteTitleFromRelPath(relPath: string): string {
  const stem = pathStem(relPath.endsWith('.md') || relPath.endsWith('.markdown') ? relPath : `${relPath}.md`);
  return stem;
}

function rewriteRelativeImages(
  markdown: string,
  noteDir: string,
  urlByRelPath: Map<string, string>
): string {
  return markdown.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (full, alt: string, target: string) => {
      const t = String(target).trim().replace(/^<|>$/g, '');
      if (/^(https?:|data:|\/)/i.test(t)) return full;
      const cleaned = t.split(/[?#]/)[0];
      const abs = path.posix.normalize(path.posix.join(noteDir || '.', cleaned)).replace(/^(\.\.\/)+/, '');
      const url =
        urlByRelPath.get(abs) ||
        urlByRelPath.get(cleaned) ||
        urlByRelPath.get(path.posix.basename(cleaned));
      if (!url) return full;
      return `![${alt}](${url})`;
    }
  );
}

export async function importVaultZip(params: {
  vaultId: number;
  pmUserId: number;
  zipBase64: string;
  overwrite?: boolean;
}): Promise<ZipImportResult> {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(params.zipBase64.replace(/\s/g, ''), 'base64');
  } catch {
    throw Object.assign(new Error('Invalid ZIP data'), { status: 400 });
  }
  if (!buffer.length) {
    throw Object.assign(new Error('Empty ZIP'), { status: 400 });
  }
  if (buffer.length > MAX_ZIP_BYTES) {
    throw Object.assign(new Error('ZIP too large (max 20 MB)'), { status: 400 });
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw Object.assign(new Error('Could not read ZIP archive'), { status: 400 });
  }

  let uncompressedTotal = 0;
  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const data = (file as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data;
    const size = data?.uncompressedSize;
    if (typeof size === 'number' && Number.isFinite(size)) {
      if (size > MAX_ENTRY_UNCOMPRESSED) {
        throw Object.assign(new Error('ZIP entry too large when uncompressed'), { status: 400 });
      }
      uncompressedTotal += size;
      if (uncompressedTotal > MAX_UNCOMPRESSED_TOTAL) {
        throw Object.assign(new Error('ZIP uncompressed size exceeds limit'), { status: 400 });
      }
    }
  }

  const fileEntries: Array<{ zipKey: string; rel: string }> = [];
  for (const [key, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const norm = normalizeZipPath(key);
    if (isSkippable(norm)) continue;
    fileEntries.push({ zipKey: key, rel: norm });
  }

  const rootPrefix = stripRootFolder(fileEntries.map((e) => e.rel));
  const relativize = (rel: string) => {
    if (!rootPrefix) return rel;
    if (rel === rootPrefix) return '';
    if (rel.startsWith(`${rootPrefix}/`)) return rel.slice(rootPrefix.length + 1);
    return rel;
  };

  const mdEntries = fileEntries
    .map((e) => ({ ...e, rel: relativize(e.rel) }))
    .filter((e) => e.rel && /\.(md|markdown)$/i.test(e.rel));

  const imageEntries = fileEntries
    .map((e) => ({ ...e, rel: relativize(e.rel) }))
    .filter((e) => e.rel && IMAGE_EXT.has(path.posix.extname(e.rel).toLowerCase()));

  if (mdEntries.length > MAX_NOTES) {
    throw Object.assign(new Error(`Too many notes in ZIP (max ${MAX_NOTES})`), { status: 400 });
  }
  if (imageEntries.length > MAX_IMAGES) {
    throw Object.assign(new Error(`Too many images in ZIP (max ${MAX_IMAGES})`), { status: 400 });
  }

  const result: ZipImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    images: 0,
    errors: [],
  };

  const urlByRelPath = new Map<string, string>();

  for (const img of imageEntries) {
    try {
      const bytes = await zip.files[img.zipKey].async('nodebuffer');
      if (bytes.length > MAX_ENTRY_UNCOMPRESSED) {
        throw new Error('Image entry too large');
      }
      const ext = path.posix.extname(img.rel).toLowerCase();
      const saved = await saveVaultImage({
        vaultId: params.vaultId,
        pmUserId: params.pmUserId,
        mimeType: mimeFromExt(ext),
        dataBase64: bytes.toString('base64'),
        fileName: path.posix.basename(img.rel),
      });
      urlByRelPath.set(img.rel, saved.url);
      urlByRelPath.set(path.posix.basename(img.rel), saved.url);
      result.images += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Image import failed';
      result.errors.push({ path: img.rel, message });
      logger.warn('ZIP image import failed', { path: img.rel, message });
    }
  }

  for (const md of mdEntries) {
    try {
      let body = await zip.files[md.zipKey].async('string');
      if (Buffer.byteLength(body, 'utf8') > MAX_ENTRY_UNCOMPRESSED) {
        throw new Error('Note entry too large');
      }
      // Strip UTF-8 BOM
      if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

      const title = noteTitleFromRelPath(md.rel);
      let notePath = titleToPath(title);
      if (!notePath.endsWith('.md')) notePath = `${notePath}.md`;

      const noteDir = path.posix.dirname(md.rel);
      body = rewriteRelativeImages(body, noteDir === '.' ? '' : noteDir, urlByRelPath);
      const fmJson = frontmatterJsonString(parseFrontmatter(body).data);

      const [existing] = await pool.execute<RowDataPacket[]>(
        'SELECT Id, Path, Title FROM Notes WHERE VaultId = ? AND Path = ? AND DeletedAt IS NULL',
        [params.vaultId, notePath]
      );

      if (existing.length) {
        if (!params.overwrite) {
          result.skipped += 1;
          continue;
        }
        const noteId = Number(existing[0].Id);
        await pool.execute(
          `UPDATE Notes SET Title = ?, BodyMarkdown = ?, FrontmatterJson = ? WHERE Id = ?`,
          [title, body, fmJson, noteId]
        );
        await snapshotRevision(noteId, params.pmUserId, {
          title,
          path: notePath,
          bodyMarkdown: body,
          frontmatterJson: fmJson,
          visibility: null,
        });
        await rebuildNoteGraph(noteId, params.vaultId);
        result.updated += 1;
        continue;
      }

      const [insert] = await pool.execute<ResultSetHeader>(
        `INSERT INTO Notes (VaultId, Path, Title, BodyMarkdown, Visibility, AliasesJson, FrontmatterJson)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        [params.vaultId, notePath, title, body, JSON.stringify([]), fmJson]
      );
      const noteId = insert.insertId;
      await snapshotRevision(noteId, params.pmUserId, {
        title,
        path: notePath,
        bodyMarkdown: body,
        frontmatterJson: fmJson,
        visibility: null,
      });
      await rebuildNoteGraph(noteId, params.vaultId);
      result.created += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Note import failed';
      result.errors.push({ path: md.rel, message });
      logger.warn('ZIP note import failed', { path: md.rel, message });
    }
  }

  return result;
}
