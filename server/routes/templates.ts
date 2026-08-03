import { Router, Response } from 'express';
import { z } from 'zod';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { authenticateSession, AuthRequest, requireAdmin } from '../middleware/auth';
import logger from '../utils/logger';

const router = Router();
router.use(authenticateSession);

export type TemplateKind = 'system' | 'global' | 'user';
export type ShareStatus = 'private' | 'pending' | 'published';

export type NoteTemplateRow = {
  id: number;
  slug: string | null;
  label: string;
  description: string | null;
  bodyMarkdown: string;
  kind: TemplateKind;
  ownerUserId: number | null;
  shareStatus: ShareStatus;
  sortOrder: number;
  updatedAt?: string;
  ownerUsername?: string | null;
};

function mapRow(r: RowDataPacket): NoteTemplateRow {
  return {
    id: Number(r.Id),
    slug: r.Slug != null ? String(r.Slug) : null,
    label: String(r.Label),
    description: r.Description != null ? String(r.Description) : null,
    bodyMarkdown: String(r.BodyMarkdown || ''),
    kind: String(r.Kind) as TemplateKind,
    ownerUserId: r.OwnerUserId != null ? Number(r.OwnerUserId) : null,
    shareStatus: String(r.ShareStatus) as ShareStatus,
    sortOrder: Number(r.SortOrder || 0),
    updatedAt: r.UpdatedAt != null ? String(r.UpdatedAt) : undefined,
    ownerUsername: r.OwnerUsername != null ? String(r.OwnerUsername) : null,
  };
}

function canView(row: NoteTemplateRow, userId: number): boolean {
  if (row.kind === 'system' || row.kind === 'global') return true;
  if (row.kind === 'user' && row.shareStatus === 'published') return true;
  if (row.kind === 'user' && row.ownerUserId === userId) return true;
  return false;
}

async function loadById(id: number): Promise<NoteTemplateRow | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT t.*, u.Username AS OwnerUsername
     FROM NoteTemplates t
     LEFT JOIN Users u ON u.Id = t.OwnerUserId
     WHERE t.Id = ?`,
    [id]
  );
  if (!rows.length) return null;
  return mapRow(rows[0]);
}

async function isAdminUser(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT IsAdmin FROM Users WHERE Id = ? AND IsActive = 1',
    [userId]
  );
  return Number(rows[0]?.IsAdmin) === 1;
}

/** Catalog visible to the current user. */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const q = String(req.query.q || '').trim().toLowerCase();
    const mineOnly = String(req.query.mine || '') === '1';

    let sql = `
      SELECT t.*, u.Username AS OwnerUsername
      FROM NoteTemplates t
      LEFT JOIN Users u ON u.Id = t.OwnerUserId
      WHERE (
        t.Kind IN ('system', 'global')
        OR (t.Kind = 'user' AND t.ShareStatus = 'published')
        OR (t.Kind = 'user' AND t.OwnerUserId = ?)
      )
    `;
    const params: Array<string | number> = [userId];

    if (mineOnly) {
      sql += ` AND t.Kind = 'user' AND t.OwnerUserId = ?`;
      params.push(userId);
    }

    if (q) {
      sql += ` AND (LOWER(t.Label) LIKE ? OR LOWER(IFNULL(t.Description, '')) LIKE ? OR LOWER(IFNULL(t.Slug, '')) LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    sql += ` ORDER BY
      CASE t.Kind WHEN 'system' THEN 0 WHEN 'global' THEN 1 ELSE 2 END,
      t.SortOrder ASC,
      t.Label ASC`;

    const [rows] = await pool.execute<RowDataPacket[]>(sql, params);
    res.json({ success: true, data: rows.map(mapRow) });
  } catch (error) {
    logger.error('GET /api/templates failed', { error });
    res.status(500).json({ success: false, message: 'Failed to list templates' });
  }
});

/** Admin: pending share requests (must be before /:id). */
router.get('/pending', requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT t.*, u.Username AS OwnerUsername
       FROM NoteTemplates t
       LEFT JOIN Users u ON u.Id = t.OwnerUserId
       WHERE t.Kind = 'user' AND t.ShareStatus = 'pending'
       ORDER BY t.UpdatedAt ASC`
    );
    res.json({ success: true, data: rows.map(mapRow) });
  } catch (error) {
    logger.error('GET /api/templates/pending failed', { error });
    res.status(500).json({ success: false, message: 'Failed to load pending templates' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadById(Number(req.params.id));
    if (!row || !canView(row, req.user!.userId)) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error('GET /api/templates/:id failed', { error });
    res.status(500).json({ success: false, message: 'Failed to load template' });
  }
});

const createSchema = z.object({
  label: z.string().trim().min(1).max(255),
  description: z.string().trim().max(512).optional().nullable(),
  bodyMarkdown: z.string().max(500_000),
  kind: z.enum(['global', 'user']).optional(),
  sortOrder: z.coerce.number().int().optional(),
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid template payload' });
    }
    const userId = req.user!.userId;
    const admin = await isAdminUser(userId);
    let kind: TemplateKind = parsed.data.kind || 'user';
    if (kind === 'global' && !admin) {
      return res.status(403).json({ success: false, message: 'Only admins can create global templates' });
    }
    if (!admin) kind = 'user';

    const shareStatus: ShareStatus = kind === 'user' ? 'private' : 'published';
    const ownerUserId = kind === 'user' ? userId : null;
    const sortOrder = parsed.data.sortOrder ?? 100;

    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO NoteTemplates
        (Slug, Label, Description, BodyMarkdown, Kind, OwnerUserId, ShareStatus, SortOrder)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.data.label,
        parsed.data.description ?? null,
        parsed.data.bodyMarkdown,
        kind,
        ownerUserId,
        shareStatus,
        sortOrder,
      ]
    );
    const row = await loadById(Number(result.insertId));
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    logger.error('POST /api/templates failed', { error });
    res.status(500).json({ success: false, message: 'Failed to create template' });
  }
});

const updateSchema = z.object({
  label: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(512).optional().nullable(),
  bodyMarkdown: z.string().max(500_000).optional(),
  sortOrder: z.coerce.number().int().optional(),
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid template payload' });
    }
    const row = await loadById(Number(req.params.id));
    if (!row) return res.status(404).json({ success: false, message: 'Template not found' });

    const userId = req.user!.userId;
    const admin = await isAdminUser(userId);
    const isOwner = row.kind === 'user' && row.ownerUserId === userId;
    if (row.kind === 'user' && !isOwner && !admin) {
      return res.status(403).json({ success: false, message: 'Not allowed to edit this template' });
    }
    if ((row.kind === 'system' || row.kind === 'global') && !admin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const next = {
      label: parsed.data.label ?? row.label,
      description:
        parsed.data.description !== undefined ? parsed.data.description : row.description,
      bodyMarkdown: parsed.data.bodyMarkdown ?? row.bodyMarkdown,
      sortOrder: parsed.data.sortOrder ?? row.sortOrder,
    };

    await pool.execute(
      `UPDATE NoteTemplates
       SET Label = ?, Description = ?, BodyMarkdown = ?, SortOrder = ?
       WHERE Id = ?`,
      [next.label, next.description, next.bodyMarkdown, next.sortOrder, row.id]
    );
    const updated = await loadById(row.id);
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('PUT /api/templates/:id failed', { error });
    res.status(500).json({ success: false, message: 'Failed to update template' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadById(Number(req.params.id));
    if (!row) return res.status(404).json({ success: false, message: 'Template not found' });

    const userId = req.user!.userId;
    const admin = await isAdminUser(userId);
    if (row.kind === 'system') {
      return res.status(400).json({ success: false, message: 'System templates cannot be deleted' });
    }
    if (row.kind === 'global' && !admin) {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    if (row.kind === 'user' && row.ownerUserId !== userId && !admin) {
      return res.status(403).json({ success: false, message: 'Not allowed to delete this template' });
    }

    await pool.execute('DELETE FROM NoteTemplates WHERE Id = ?', [row.id]);
    res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    logger.error('DELETE /api/templates/:id failed', { error });
    res.status(500).json({ success: false, message: 'Failed to delete template' });
  }
});

router.post('/:id/share', async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadById(Number(req.params.id));
    if (!row || row.kind !== 'user' || row.ownerUserId !== req.user!.userId) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    if (row.shareStatus === 'published') {
      return res.status(400).json({ success: false, message: 'Template is already published' });
    }
    await pool.execute(`UPDATE NoteTemplates SET ShareStatus = 'pending' WHERE Id = ?`, [row.id]);
    res.json({ success: true, data: await loadById(row.id) });
  } catch (error) {
    logger.error('POST /api/templates/:id/share failed', { error });
    res.status(500).json({ success: false, message: 'Failed to request share' });
  }
});

router.post('/:id/withdraw', async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadById(Number(req.params.id));
    if (!row || row.kind !== 'user') {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    const userId = req.user!.userId;
    const admin = await isAdminUser(userId);
    if (row.ownerUserId !== userId && !admin) {
      return res.status(403).json({ success: false, message: 'Not allowed' });
    }
    await pool.execute(`UPDATE NoteTemplates SET ShareStatus = 'private' WHERE Id = ?`, [row.id]);
    res.json({ success: true, data: await loadById(row.id) });
  } catch (error) {
    logger.error('POST /api/templates/:id/withdraw failed', { error });
    res.status(500).json({ success: false, message: 'Failed to withdraw share' });
  }
});

router.post('/:id/approve', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadById(Number(req.params.id));
    if (!row || row.kind !== 'user') {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    if (row.shareStatus !== 'pending') {
      return res.status(400).json({ success: false, message: 'Template is not pending approval' });
    }
    await pool.execute(`UPDATE NoteTemplates SET ShareStatus = 'published' WHERE Id = ?`, [row.id]);
    res.json({ success: true, data: await loadById(row.id) });
  } catch (error) {
    logger.error('POST /api/templates/:id/approve failed', { error });
    res.status(500).json({ success: false, message: 'Failed to approve template' });
  }
});

router.post('/:id/reject', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const row = await loadById(Number(req.params.id));
    if (!row || row.kind !== 'user') {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    if (row.shareStatus !== 'pending') {
      return res.status(400).json({ success: false, message: 'Template is not pending approval' });
    }
    await pool.execute(`UPDATE NoteTemplates SET ShareStatus = 'private' WHERE Id = ?`, [row.id]);
    res.json({ success: true, data: await loadById(row.id) });
  } catch (error) {
    logger.error('POST /api/templates/:id/reject failed', { error });
    res.status(500).json({ success: false, message: 'Failed to reject template' });
  }
});

export default router;
