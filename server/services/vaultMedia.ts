import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import logger from '../utils/logger';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function uploadsRoot(): string {
  return process.env.SYNAPSE_UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');
}

function vaultDir(vaultId: number): string {
  return path.join(uploadsRoot(), String(vaultId));
}

export function mediaPublicUrl(vaultId: number, mediaId: number): string {
  return `/api/vaults/${vaultId}/media/${mediaId}`;
}

export async function saveVaultImage(params: {
  vaultId: number;
  pmUserId: number;
  mimeType: string;
  dataBase64: string;
  fileName?: string | null;
}): Promise<{ id: number; url: string; mimeType: string; sizeBytes: number }> {
  const mime = (params.mimeType || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_MIME.has(mime)) {
    throw Object.assign(new Error('Only image uploads are allowed (png, jpeg, gif, webp, svg)'), {
      status: 400,
    });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(params.dataBase64.replace(/\s/g, ''), 'base64');
  } catch {
    throw Object.assign(new Error('Invalid image data'), { status: 400 });
  }
  if (!buffer.length) {
    throw Object.assign(new Error('Empty image'), { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('Image too large (max 5 MB)'), { status: 400 });
  }

  const ext = MIME_EXT[mime] || 'bin';
  const storageName = `${randomUUID()}.${ext}`;
  const dir = vaultDir(params.vaultId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, storageName);
  await fs.writeFile(filePath, buffer);

  const originalName = (params.fileName || `image.${ext}`).slice(0, 512);
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO VaultMedia (VaultId, StorageName, OriginalName, MimeType, SizeBytes, CreatedByPmUserId)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [params.vaultId, storageName, originalName, mime, buffer.length, params.pmUserId]
    );
    const id = result.insertId;
    return {
      id,
      url: mediaPublicUrl(params.vaultId, id),
      mimeType: mime,
      sizeBytes: buffer.length,
    };
  } catch (error) {
    await fs.unlink(filePath).catch(() => undefined);
    logger.error('Failed to record vault media', { error, vaultId: params.vaultId });
    throw error;
  }
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
