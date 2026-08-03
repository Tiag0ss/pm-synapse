import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateSession, AuthRequest, requireAdmin } from '../middleware/auth';
import {
  deleteExportTemplate,
  listExportTemplates,
  saveExportTemplate,
  updateExportTemplateMeta,
} from '../services/exportTemplates';
import logger from '../utils/logger';

const router = Router();
router.use(authenticateSession);

/** Any signed-in user can list templates (needed for note export). */
router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const templates = await listExportTemplates();
    res.json({ success: true, data: templates });
  } catch (error) {
    logger.error('List export templates failed', { error });
    res.status(500).json({ success: false, message: 'Failed to list export templates' });
  }
});

router.post('/', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      label: z.string().trim().min(1).max(255),
      description: z.string().max(512).optional().nullable(),
      dataBase64: z.string().min(1),
      fileName: z.string().max(512).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid template upload' });
    }
    const created = await saveExportTemplate({
      label: parsed.data.label,
      description: parsed.data.description,
      dataBase64: parsed.data.dataBase64,
      fileName: parsed.data.fileName,
      uploadedByUserId: req.user!.userId,
    });
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    const status = (error as { status?: number })?.status || 500;
    const message =
      error instanceof Error ? error.message : 'Failed to upload export template';
    if (status >= 500) logger.error('Upload export template failed', { error });
    res.status(status).json({ success: false, message });
  }
});

router.patch('/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid template id' });
    }
    const schema = z.object({
      label: z.string().trim().min(1).max(255).optional(),
      description: z.string().max(512).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid template data' });
    }
    const updated = await updateExportTemplateMeta(id, parsed.data);
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    res.json({ success: true, data: updated });
  } catch (error) {
    const status = (error as { status?: number })?.status || 500;
    const message =
      error instanceof Error ? error.message : 'Failed to update export template';
    if (status >= 500) logger.error('Update export template failed', { error });
    res.status(status).json({ success: false, message });
  }
});

router.delete('/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ success: false, message: 'Invalid template id' });
    }
    const ok = await deleteExportTemplate(id);
    if (!ok) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    logger.error('Delete export template failed', { error });
    res.status(500).json({ success: false, message: 'Failed to delete export template' });
  }
});

export default router;
