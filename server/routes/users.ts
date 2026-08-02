import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { authenticateSession, AuthRequest, requireAdmin } from '../middleware/auth';
import {
  getSettingInt,
  normalizeEmail,
  SETTING_KEYS,
} from '../services/appSettings';
import { syncUsersFromPm } from '../services/syncPmUsers';
import logger from '../utils/logger';

const router = Router();
const BCRYPT_ROUNDS = 10;

router.use(authenticateSession, requireAdmin);

router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, LastLoginAt, CreatedAt
       FROM Users ORDER BY Username ASC`
    );
    res.json({
      success: true,
      data: rows.map((r) => ({
        id: Number(r.Id),
        username: String(r.Username),
        email: String(r.Email),
        isAdmin: Number(r.IsAdmin) === 1,
        isActive: Number(r.IsActive) === 1,
        hasPassword: Boolean(r.PasswordHash),
        pmUserId: r.PmUserId != null ? Number(r.PmUserId) : null,
        lastLoginAt: r.LastLoginAt,
        createdAt: r.CreatedAt,
      })),
    });
  } catch (error) {
    logger.error('GET users failed', { error });
    res.status(500).json({ success: false, message: 'Failed to list users' });
  }
});

/** Import / link users from Project Management into Synapse. */
router.post('/sync-from-pm', async (req: AuthRequest, res: Response) => {
  try {
    const data = await syncUsersFromPm(req.user!.userId);
    res.json({
      success: true,
      data,
      message: `Synced from PM — created ${data.created}, updated ${data.updated}, linked ${data.linked}, skipped ${data.skipped}, failed ${data.failed}`,
    });
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    if (status >= 500) logger.error('POST users/sync-from-pm failed', { error });
    res.status(status).json({
      success: false,
      message: err.message || 'Failed to sync users from Project Management',
    });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const minLen = await getSettingInt(SETTING_KEYS.minPasswordLength, 8);
    const schema = z.object({
      username: z.string().trim().min(2).max(64),
      email: z.string().trim().email().max(255),
      password: z.string().min(minLen).max(200),
      isAdmin: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: `Invalid input (password min ${minLen} characters)`,
      });
    }
    const email = normalizeEmail(parsed.data.email);
    const hash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    try {
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO Users (Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive)
         VALUES (?, ?, ?, NULL, ?, 1)`,
        [parsed.data.username.trim(), email, hash, parsed.data.isAdmin ? 1 : 0]
      );
      res.status(201).json({
        success: true,
        data: { id: Number(result.insertId) },
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, message: 'Username or email already in use' });
      }
      throw error;
    }
  } catch (error) {
    logger.error('POST users failed', { error });
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    const minLen = await getSettingInt(SETTING_KEYS.minPasswordLength, 8);
    const schema = z.object({
      username: z.string().trim().min(2).max(64).optional(),
      email: z.string().trim().email().max(255).optional(),
      isAdmin: z.boolean().optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(minLen).max(200).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid update payload' });
    }

    const [existing] = await pool.execute<RowDataPacket[]>(
      'SELECT Id, IsAdmin FROM Users WHERE Id = ?',
      [id]
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (parsed.data.isAdmin === false && Number(existing[0].IsAdmin) === 1) {
      const [admins] = await pool.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM Users WHERE IsAdmin = 1 AND IsActive = 1'
      );
      if (Number(admins[0]?.c || 0) <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot remove the last admin' });
      }
    }
    if (parsed.data.isActive === false && id === req.user!.userId) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate your own account' });
    }

    const sets: string[] = [];
    const params: Array<string | number> = [];
    if (parsed.data.username != null) {
      sets.push('Username = ?');
      params.push(parsed.data.username.trim());
    }
    if (parsed.data.email != null) {
      sets.push('Email = ?');
      params.push(normalizeEmail(parsed.data.email));
    }
    if (parsed.data.isAdmin != null) {
      sets.push('IsAdmin = ?');
      params.push(parsed.data.isAdmin ? 1 : 0);
    }
    if (parsed.data.isActive != null) {
      sets.push('IsActive = ?');
      params.push(parsed.data.isActive ? 1 : 0);
    }
    if (parsed.data.password != null) {
      sets.push('PasswordHash = ?');
      params.push(await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS));
    }
    if (!sets.length) {
      return res.status(400).json({ success: false, message: 'No changes provided' });
    }
    params.push(id);
    try {
      await pool.execute(`UPDATE Users SET ${sets.join(', ')} WHERE Id = ?`, params);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, message: 'Username or email already in use' });
      }
      throw error;
    }
    res.json({ success: true, message: 'User updated' });
  } catch (error) {
    logger.error('PATCH users failed', { error });
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    if (id === req.user!.userId) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    }
    const [existing] = await pool.execute<RowDataPacket[]>(
      'SELECT Id, IsAdmin FROM Users WHERE Id = ?',
      [id]
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (Number(existing[0].IsAdmin) === 1) {
      const [admins] = await pool.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS c FROM Users WHERE IsAdmin = 1'
      );
      if (Number(admins[0]?.c || 0) <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot delete the last admin' });
      }
    }
    const [vaults] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS c FROM Vaults WHERE OwnerPmUserId = ?',
      [id]
    );
    if (Number(vaults[0]?.c || 0) > 0) {
      return res.status(400).json({
        success: false,
        message: 'User still owns vaults — delete or reassign them first',
      });
    }
    await pool.execute('DELETE FROM VaultMembers WHERE PmUserId = ?', [id]);
    await pool.execute('DELETE FROM Users WHERE Id = ?', [id]);
    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    logger.error('DELETE users failed', { error });
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  }
});

export default router;
