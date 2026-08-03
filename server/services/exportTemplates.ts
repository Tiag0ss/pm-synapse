import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import logger from '../utils/logger';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ExportTemplateRow = {
  id: number;
  label: string;
  description: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

function uploadsRoot(): string {
  return process.env.SYNAPSE_UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads');
}

function exportTemplatesDir(): string {
  return path.join(uploadsRoot(), '_export-templates');
}

function isDocxBuffer(buf: Buffer): boolean {
  // DOCX is a ZIP (PK\x03\x04) — reject empty / non-zip uploads
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

function mapRow(r: RowDataPacket): ExportTemplateRow {
  return {
    id: Number(r.Id),
    label: String(r.Label),
    description: r.Description != null ? String(r.Description) : null,
    originalName: String(r.OriginalName),
    mimeType: String(r.MimeType || DOCX_MIME),
    sizeBytes: Number(r.SizeBytes || 0),
    uploadedByUserId: r.UploadedByUserId != null ? Number(r.UploadedByUserId) : null,
    createdAt: String(r.CreatedAt),
    updatedAt: String(r.UpdatedAt),
  };
}

export async function listExportTemplates(): Promise<ExportTemplateRow[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Label, Description, OriginalName, MimeType, SizeBytes, UploadedByUserId, CreatedAt, UpdatedAt
     FROM ExportTemplates
     ORDER BY Label ASC, Id ASC`
  );
  return rows.map(mapRow);
}

export async function getExportTemplate(id: number): Promise<ExportTemplateRow | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Label, Description, OriginalName, MimeType, SizeBytes, UploadedByUserId, CreatedAt, UpdatedAt
     FROM ExportTemplates WHERE Id = ?`,
    [id]
  );
  if (!rows[0]) return null;
  return mapRow(rows[0]);
}

export async function readExportTemplateFile(id: number): Promise<{
  meta: ExportTemplateRow;
  buffer: Buffer;
} | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Label, Description, OriginalName, StorageName, MimeType, SizeBytes, UploadedByUserId, CreatedAt, UpdatedAt
     FROM ExportTemplates WHERE Id = ?`,
    [id]
  );
  if (!rows[0]) return null;
  const meta = mapRow(rows[0]);
  const filePath = path.join(exportTemplatesDir(), String(rows[0].StorageName));
  try {
    const buffer = await fs.readFile(filePath);
    return { meta, buffer };
  } catch (error) {
    logger.error('Export template file missing', { id, filePath, error });
    return null;
  }
}

export async function saveExportTemplate(params: {
  label: string;
  description?: string | null;
  dataBase64: string;
  fileName?: string | null;
  uploadedByUserId: number;
}): Promise<ExportTemplateRow> {
  const label = params.label.trim();
  if (label.length < 1 || label.length > 255) {
    throw Object.assign(new Error('Label is required (max 255 characters)'), { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(String(params.dataBase64 || '').replace(/\s/g, ''), 'base64');
  } catch {
    throw Object.assign(new Error('Invalid template file data'), { status: 400 });
  }
  if (!buffer.length) {
    throw Object.assign(new Error('Empty template file'), { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('Template too large (max 10 MB)'), { status: 400 });
  }
  if (!isDocxBuffer(buffer)) {
    throw Object.assign(new Error('Only .docx Word templates are supported'), { status: 400 });
  }

  const originalName = (params.fileName || 'template.docx').slice(0, 512);
  if (!/\.docx$/i.test(originalName) && !originalName.toLowerCase().endsWith('.docx')) {
    // allow missing extension if ZIP magic matched; normalize name
  }
  const storageName = `${randomUUID()}.docx`;
  const dir = exportTemplatesDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, storageName);
  await fs.writeFile(filePath, buffer);

  const description =
    params.description != null && String(params.description).trim()
      ? String(params.description).trim().slice(0, 512)
      : null;

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO ExportTemplates
        (Label, Description, OriginalName, StorageName, MimeType, SizeBytes, UploadedByUserId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        label,
        description,
        originalName.toLowerCase().endsWith('.docx') ? originalName : `${originalName}.docx`,
        storageName,
        DOCX_MIME,
        buffer.length,
        params.uploadedByUserId,
      ]
    );
    const created = await getExportTemplate(result.insertId);
    if (!created) throw new Error('Failed to load created export template');
    return created;
  } catch (error) {
    await fs.unlink(filePath).catch(() => undefined);
    logger.error('Failed to record export template', { error });
    throw error;
  }
}

export async function updateExportTemplateMeta(
  id: number,
  patch: { label?: string; description?: string | null }
): Promise<ExportTemplateRow | null> {
  const existing = await getExportTemplate(id);
  if (!existing) return null;

  const label =
    patch.label != null ? patch.label.trim() : existing.label;
  if (label.length < 1 || label.length > 255) {
    throw Object.assign(new Error('Label is required (max 255 characters)'), { status: 400 });
  }
  const description =
    patch.description !== undefined
      ? patch.description != null && String(patch.description).trim()
        ? String(patch.description).trim().slice(0, 512)
        : null
      : existing.description;

  await pool.execute(
    'UPDATE ExportTemplates SET Label = ?, Description = ? WHERE Id = ?',
    [label, description, id]
  );
  return getExportTemplate(id);
}

export async function deleteExportTemplate(id: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT StorageName FROM ExportTemplates WHERE Id = ?',
    [id]
  );
  if (!rows[0]) return false;
  const storageName = String(rows[0].StorageName);
  await pool.execute('DELETE FROM ExportTemplates WHERE Id = ?', [id]);
  const filePath = path.join(exportTemplatesDir(), storageName);
  await fs.unlink(filePath).catch(() => undefined);
  return true;
}
