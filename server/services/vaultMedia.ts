import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import logger from '../utils/logger';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB for non-images

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const DOC_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'application/zip',
  'application/x-zip-compressed',
]);

const ALLOWED_MIME = new Set([...IMAGE_MIME, ...DOC_MIME]);

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
};

const ACTIVE_SVG_MIME = new Set(['image/svg+xml', 'image/svg']);

export function isImageMime(mimeType: string): boolean {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  return IMAGE_MIME.has(mime);
}

export function isAllowedMediaMime(mimeType: string): boolean {
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
  return ALLOWED_MIME.has(mime);
}

/** Headers that keep media from executing as script/document on this origin. */
export function applySafeMediaHeaders(
  res: { setHeader: (name: string, value: string) => void },
  opts: { mimeType: string; originalName?: string | null; cacheControl: string }
): boolean {
  const mime = (opts.mimeType || '').toLowerCase().split(';')[0].trim();
  if (ACTIVE_SVG_MIME.has(mime) || (mime.endsWith('+xml') && mime.includes('svg'))) {
    return false;
  }
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', opts.cacheControl);
  const rawName = (opts.originalName || (isImageMime(mime) ? 'image' : 'file')).replace(
    /["\r\n\\]/g,
    ''
  );
  const safeName = rawName.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180) || 'file';
  const disposition = isImageMime(mime) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  return true;
}

function uploadsRoot(): string {
  return process.env.SYNAPSE_UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');
}

function vaultDir(vaultId: number): string {
  return path.join(uploadsRoot(), String(vaultId));
}

export function mediaPublicUrl(vaultId: number, mediaId: number): string {
  return `/api/vaults/${vaultId}/media/${mediaId}`;
}

export type VaultMediaRow = {
  id: number;
  vaultId: number;
  noteId: number | null;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string | null;
};

function mapMediaRow(row: RowDataPacket, vaultId: number): VaultMediaRow {
  const id = Number(row.Id);
  return {
    id,
    vaultId,
    noteId: row.NoteId != null ? Number(row.NoteId) : null,
    originalName: row.OriginalName ? String(row.OriginalName) : null,
    mimeType: String(row.MimeType),
    sizeBytes: Number(row.SizeBytes || 0),
    url: mediaPublicUrl(vaultId, id),
    createdAt: row.CreatedAt ? String(row.CreatedAt) : null,
  };
}

export async function saveVaultMedia(params: {
  vaultId: number;
  pmUserId: number;
  mimeType: string;
  dataBase64: string;
  fileName?: string | null;
  noteId?: number | null;
}): Promise<{
  id: number;
  url: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  noteId: number | null;
}> {
  const mime = (params.mimeType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIME.has(mime)) {
    throw Object.assign(
      new Error(
        'Unsupported file type (images: png/jpeg/gif/webp; files: pdf, office, txt, md, zip)'
      ),
      { status: 400 }
    );
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(params.dataBase64.replace(/\s/g, ''), 'base64');
  } catch {
    throw Object.assign(new Error('Invalid file data'), { status: 400 });
  }
  if (!buffer.length) {
    throw Object.assign(new Error('Empty file'), { status: 400 });
  }

  const maxBytes = isImageMime(mime) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (buffer.length > maxBytes) {
    const label = isImageMime(mime) ? '5 MB' : '15 MB';
    throw Object.assign(new Error(`File too large (max ${label})`), { status: 400 });
  }

  const noteId =
    params.noteId != null && Number.isFinite(Number(params.noteId)) && Number(params.noteId) > 0
      ? Number(params.noteId)
      : null;
  if (noteId != null) {
    const [notes] = await pool.execute<RowDataPacket[]>(
      'SELECT Id FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
      [noteId, params.vaultId]
    );
    if (!notes.length) {
      throw Object.assign(new Error('Note not found in this vault'), { status: 400 });
    }
  }

  const ext = MIME_EXT[mime] || 'bin';
  const storageName = `${randomUUID()}.${ext}`;
  const dir = vaultDir(params.vaultId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, storageName);
  await fs.writeFile(filePath, buffer);

  const originalName = (params.fileName || (isImageMime(mime) ? `image.${ext}` : `file.${ext}`)).slice(
    0,
    512
  );
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO VaultMedia (VaultId, NoteId, StorageName, OriginalName, MimeType, SizeBytes, CreatedByPmUserId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [params.vaultId, noteId, storageName, originalName, mime, buffer.length, params.pmUserId]
    );
    const id = result.insertId;
    return {
      id,
      url: mediaPublicUrl(params.vaultId, id),
      mimeType: mime,
      sizeBytes: buffer.length,
      originalName,
      noteId,
    };
  } catch (error) {
    await fs.unlink(filePath).catch(() => undefined);
    logger.error('Failed to record vault media', { error, vaultId: params.vaultId });
    throw error;
  }
}

/** @deprecated Prefer saveVaultMedia — kept for call sites that only upload images. */
export async function saveVaultImage(params: {
  vaultId: number;
  pmUserId: number;
  mimeType: string;
  dataBase64: string;
  fileName?: string | null;
  noteId?: number | null;
}): Promise<{ id: number; url: string; mimeType: string; sizeBytes: number }> {
  const saved = await saveVaultMedia(params);
  return {
    id: saved.id,
    url: saved.url,
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
  };
}

export async function readVaultMedia(
  vaultId: number,
  mediaId: number
): Promise<{ buffer: Buffer; mimeType: string; originalName: string | null } | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT StorageName, MimeType, OriginalName FROM VaultMedia WHERE Id = ? AND VaultId = ?',
    [mediaId, vaultId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const filePath = path.join(vaultDir(vaultId), String(row.StorageName));
  try {
    const buffer = await fs.readFile(filePath);
    return {
      buffer,
      mimeType: String(row.MimeType),
      originalName: row.OriginalName ? String(row.OriginalName) : null,
    };
  } catch (error) {
    logger.warn('Vault media file missing on disk', { vaultId, mediaId, error });
    return null;
  }
}

/** Media IDs referenced as markdown images or links in a note body. */
export function extractVaultMediaIdsFromMarkdown(body: string, vaultId: number): number[] {
  const ids = new Set<number>();
  const re = new RegExp(
    `!?\\[[^\\]]*\\]\\(/api/vaults/${vaultId}/media/(\\d+)\\)`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(body || ''))) {
    const id = Number(m[1]);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

export async function listNoteAttachments(
  vaultId: number,
  noteId: number
): Promise<VaultMediaRow[]> {
  const [noteRows] = await pool.execute<RowDataPacket[]>(
    'SELECT BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
    [noteId, vaultId]
  );
  if (!noteRows.length) return [];

  const bodyIds = extractVaultMediaIdsFromMarkdown(String(noteRows[0].BodyMarkdown || ''), vaultId);
  const [owned] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, VaultId, NoteId, OriginalName, MimeType, SizeBytes, CreatedAt
     FROM VaultMedia WHERE VaultId = ? AND NoteId = ?
     ORDER BY Id DESC`,
    [vaultId, noteId]
  );

  const byId = new Map<number, VaultMediaRow>();
  for (const row of owned) {
    byId.set(Number(row.Id), mapMediaRow(row, vaultId));
  }

  if (bodyIds.length) {
    const placeholders = bodyIds.map(() => '?').join(',');
    const [extra] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, VaultId, NoteId, OriginalName, MimeType, SizeBytes, CreatedAt
       FROM VaultMedia WHERE VaultId = ? AND Id IN (${placeholders})`,
      [vaultId, ...bodyIds]
    );
    for (const row of extra) {
      byId.set(Number(row.Id), mapMediaRow(row, vaultId));
    }
  }

  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export async function deleteVaultMedia(
  vaultId: number,
  mediaId: number
): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT StorageName FROM VaultMedia WHERE Id = ? AND VaultId = ?',
    [mediaId, vaultId]
  );
  if (!rows.length) return false;
  const storageName = String(rows[0].StorageName);
  await pool.execute('DELETE FROM VaultMedia WHERE Id = ? AND VaultId = ?', [mediaId, vaultId]);
  const filePath = path.join(vaultDir(vaultId), storageName);
  await fs.unlink(filePath).catch(() => undefined);
  return true;
}
