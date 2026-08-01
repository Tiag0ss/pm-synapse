import JSZip from 'jszip';
import { pool, RowDataPacket } from '../config/database';
import { readVaultMedia } from './vaultMedia';
import logger from '../utils/logger';

const MEDIA_URL_RE = /!\[([^\]]*)\]\(\/api\/vaults\/(\d+)\/media\/(\d+)\)/g;

export type ZipExportResult = {
  buffer: Buffer;
  noteCount: number;
  imageCount: number;
  fileName: string;
};

function safeZipName(name: string): string {
  return name.replace(/[<>:"|?*\\]/g, '_').replace(/^\/+/, '');
}

/**
 * Export vault notes as Markdown paths + media files.
 * Rewrites `/api/vaults/:id/media/:mediaId` image URLs to `media/<id>-<name>` relative paths.
 */
export async function exportVaultZip(vaultId: number, vaultName: string): Promise<ZipExportResult> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Path, Title, BodyMarkdown
     FROM Notes
     WHERE VaultId = ? AND DeletedAt IS NULL
     ORDER BY Path ASC`,
    [vaultId]
  );

  const [mediaRows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, OriginalName, MimeType FROM VaultMedia WHERE VaultId = ? ORDER BY Id ASC`,
    [vaultId]
  );

  const mediaRelById = new Map<number, string>();
  for (const m of mediaRows) {
    const id = Number(m.Id);
    const original = m.OriginalName ? String(m.OriginalName) : `image-${id}`;
    const base = safeZipName(original).replace(/\s+/g, '_');
    mediaRelById.set(id, `media/${id}-${base}`);
  }

  const zip = new JSZip();
  let imageCount = 0;

  for (const [mediaId, relPath] of mediaRelById) {
    const file = await readVaultMedia(vaultId, mediaId);
    if (!file) continue;
    zip.file(relPath, file.buffer);
    imageCount += 1;
  }

  for (const note of notes) {
    const pathName = safeZipName(String(note.Path || `${note.Title}.md`));
    let body = String(note.BodyMarkdown || '');
    body = body.replace(MEDIA_URL_RE, (_full, alt: string, vId: string, mId: string) => {
      if (Number(vId) !== vaultId) return `![${alt}](/api/vaults/${vId}/media/${mId})`;
      const rel = mediaRelById.get(Number(mId));
      if (!rel) return `![${alt}](/api/vaults/${vId}/media/${mId})`;
      return `![${alt}](${rel})`;
    });
    zip.file(pathName.endsWith('.md') || pathName.endsWith('.markdown') ? pathName : `${pathName}.md`, body);
  }

  const buffer = Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
  const slug = safeZipName(vaultName || `vault-${vaultId}`)
    .replace(/\s+/g, '-')
    .slice(0, 80);
  logger.info('Vault ZIP export ready', { vaultId, notes: notes.length, images: imageCount, bytes: buffer.length });

  return {
    buffer,
    noteCount: notes.length,
    imageCount,
    fileName: `${slug || `vault-${vaultId}`}.zip`,
  };
}
