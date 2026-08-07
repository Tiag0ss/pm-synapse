import { Router, Response } from 'express';
import { z } from 'zod';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { authenticateSession, AuthRequest, requireAdmin } from '../middleware/auth';
import {
  getDecryptedSetting,
  getSetting,
  getSettingBool,
  invalidateSettingsCache,
  isSmtpConfigured,
  SETTING_KEYS,
  setSetting,
} from '../services/appSettings';
import { PM_BASE_URL } from '../services/pmClient';
import { sendMail } from '../services/email';
import {
  adminAddVaultMember,
  adminRemoveVaultMember,
  adminUpdateVaultMemberRole,
  getVaultMembersForAdmin,
  listAllVaultsForAdmin,
  transferVaultOwnership,
} from '../services/adminVaults';
import logger from '../utils/logger';

const router = Router();

router.use(authenticateSession, requireAdmin);

router.get('/general', async (_req: AuthRequest, res: Response) => {
  try {
    const [
      siteName,
      allowPublicWikiDirectory,
      allowPublicRegistration,
      allowSsoLogin,
      minPasswordLength,
      pmIntegrationEnabled,
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      smtpFrom,
      smtpFromName,
      smtpPassword,
    ] = await Promise.all([
      getSetting(SETTING_KEYS.siteName),
      getSettingBool(SETTING_KEYS.allowPublicWikiDirectory, true),
      getSettingBool(SETTING_KEYS.allowPublicRegistration, true),
      getSettingBool(SETTING_KEYS.allowSsoLogin, true),
      getSetting(SETTING_KEYS.minPasswordLength),
      getSettingBool(SETTING_KEYS.pmIntegrationEnabled, true),
      getSetting(SETTING_KEYS.smtpHost),
      getSetting(SETTING_KEYS.smtpPort),
      getSettingBool(SETTING_KEYS.smtpSecure, false),
      getSetting(SETTING_KEYS.smtpUser),
      getSetting(SETTING_KEYS.smtpFrom),
      getSetting(SETTING_KEYS.smtpFromName),
      getDecryptedSetting(SETTING_KEYS.smtpPassword),
    ]);

    res.json({
      success: true,
      data: {
        general: {
          siteName: siteName || 'PM Synapse',
          allowPublicWikiDirectory,
        },
        auth: {
          allowPublicRegistration,
          allowSsoLogin,
          minPasswordLength: Number(minPasswordLength || 8),
        },
        email: {
          smtpHost: smtpHost || '',
          smtpPort: smtpPort || '587',
          smtpSecure,
          smtpUser: smtpUser || '',
          smtpFrom: smtpFrom || '',
          smtpFromName: smtpFromName || 'PM Synapse',
          hasSmtpPassword: Boolean(smtpPassword),
          smtpConfigured: await isSmtpConfigured(),
        },
        projectManagement: {
          pmBaseUrl: PM_BASE_URL,
          pmIntegrationEnabled,
        },
      },
    });
  } catch (error) {
    logger.error('GET settings/general failed', { error });
    res.status(500).json({ success: false, message: 'Failed to load settings' });
  }
});

router.put('/general', async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      siteName: z.string().trim().min(1).max(128).optional(),
      allowPublicWikiDirectory: z.boolean().optional(),
      allowPublicRegistration: z.boolean().optional(),
      allowSsoLogin: z.boolean().optional(),
      minPasswordLength: z.number().int().min(6).max(128).optional(),
      smtpHost: z.string().max(255).optional(),
      smtpPort: z.union([z.string(), z.number()]).optional(),
      smtpSecure: z.boolean().optional(),
      smtpUser: z.string().max(255).optional(),
      smtpFrom: z.string().max(255).optional(),
      smtpFromName: z.string().max(128).optional(),
      /** omit = leave unchanged; empty string = clear */
      smtpPassword: z.string().max(500).nullable().optional(),
      pmIntegrationEnabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Invalid settings payload' });
    }
    const d = parsed.data;

    if (d.siteName != null) await setSetting(SETTING_KEYS.siteName, d.siteName);
    if (d.allowPublicWikiDirectory != null) {
      await setSetting(SETTING_KEYS.allowPublicWikiDirectory, d.allowPublicWikiDirectory ? 'true' : 'false');
    }
    if (d.allowPublicRegistration != null) {
      await setSetting(SETTING_KEYS.allowPublicRegistration, d.allowPublicRegistration ? 'true' : 'false');
    }
    if (d.allowSsoLogin != null) {
      await setSetting(SETTING_KEYS.allowSsoLogin, d.allowSsoLogin ? 'true' : 'false');
    }
    if (d.minPasswordLength != null) {
      await setSetting(SETTING_KEYS.minPasswordLength, String(d.minPasswordLength));
    }
    if (d.smtpHost != null) await setSetting(SETTING_KEYS.smtpHost, d.smtpHost);
    if (d.smtpPort != null) await setSetting(SETTING_KEYS.smtpPort, String(d.smtpPort));
    if (d.smtpSecure != null) {
      await setSetting(SETTING_KEYS.smtpSecure, d.smtpSecure ? 'true' : 'false');
    }
    if (d.smtpUser != null) await setSetting(SETTING_KEYS.smtpUser, d.smtpUser);
    if (d.smtpFrom != null) await setSetting(SETTING_KEYS.smtpFrom, d.smtpFrom);
    if (d.smtpFromName != null) await setSetting(SETTING_KEYS.smtpFromName, d.smtpFromName);
    if (d.smtpPassword !== undefined) {
      await setSetting(SETTING_KEYS.smtpPassword, d.smtpPassword === '' || d.smtpPassword == null ? null : d.smtpPassword);
    }
    if (d.pmIntegrationEnabled != null) {
      await setSetting(SETTING_KEYS.pmIntegrationEnabled, d.pmIntegrationEnabled ? 'true' : 'false');
    }

    invalidateSettingsCache();
    res.json({ success: true, message: 'Settings saved' });
  } catch (error) {
    logger.error('PUT settings/general failed', { error });
    res.status(500).json({ success: false, message: 'Failed to save settings' });
  }
});

router.post('/email/test', async (req: AuthRequest, res: Response) => {
  try {
    const to = req.user!.email;
    if (!to) {
      return res.status(400).json({ success: false, message: 'Your account has no email address' });
    }
    const result = await sendMail({
      to,
      subject: 'PM Synapse — test email',
      text: 'This is a test email from PM Synapse. SMTP is working.',
      html: '<p>This is a test email from <strong>PM Synapse</strong>. SMTP is working.</p>',
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch (error) {
    logger.error('email test failed', { error });
    res.status(500).json({ success: false, message: 'Failed to send test email' });
  }
});

/** List every vault (admin). */
router.get('/vaults', async (_req: AuthRequest, res: Response) => {
  try {
    const data = await listAllVaultsForAdmin();
    res.json({ success: true, data });
  } catch (error) {
    logger.error('GET settings/vaults failed', { error });
    res.status(500).json({ success: false, message: 'Failed to list vaults' });
  }
});

router.get('/vaults/:vaultId/members', async (req: AuthRequest, res: Response) => {
  try {
    const data = await getVaultMembersForAdmin(Number(req.params.vaultId));
    if (!data) return res.status(404).json({ success: false, message: 'Vault not found' });
    res.json({ success: true, data });
  } catch (error) {
    logger.error('GET settings/vaults/:id/members failed', { error });
    res.status(500).json({ success: false, message: 'Failed to load members' });
  }
});

router.post('/vaults/:vaultId/members', async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      userId: z.coerce.number().int().positive().optional(),
      pmUserId: z.coerce.number().int().positive().optional(),
      role: z.enum(['read', 'edit']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'userId (or pmUserId) and role (read|edit) required',
      });
    }

    let targetUserId = parsed.data.userId ?? null;
    let pendingFirstLogin = false;

    if (targetUserId == null && parsed.data.pmUserId != null) {
      const [byId] = await pool.execute<RowDataPacket[]>(
        'SELECT Id FROM Users WHERE Id = ?',
        [parsed.data.pmUserId]
      );
      if (byId[0]) {
        targetUserId = Number(byId[0].Id);
      } else {
        const [byPm] = await pool.execute<RowDataPacket[]>(
          'SELECT Id FROM Users WHERE PmUserId = ?',
          [parsed.data.pmUserId]
        );
        if (byPm[0]) {
          targetUserId = Number(byPm[0].Id);
        } else {
          const [ins] = await pool.execute<ResultSetHeader>(
            `INSERT INTO Users (Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive)
             VALUES (?, ?, NULL, ?, 0, 1)`,
            [
              `user#${parsed.data.pmUserId}`,
              `pending-pm-${parsed.data.pmUserId}@local`,
              parsed.data.pmUserId,
            ]
          );
          targetUserId = Number(ins.insertId);
          pendingFirstLogin = true;
        }
      }
    }

    if (targetUserId == null) {
      return res.status(400).json({
        success: false,
        message: 'userId (or pmUserId) and role (read|edit) required',
      });
    }

    const result = await adminAddVaultMember({
      vaultId: Number(req.params.vaultId),
      targetUserId,
      role: parsed.data.role,
      invitedByUserId: req.user!.userId,
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    res.status(201).json({
      success: true,
      data: {
        userId: targetUserId,
        pmUserId: targetUserId,
        role: parsed.data.role,
        pendingFirstLogin,
      },
    });
  } catch (error) {
    logger.error('POST settings/vaults/:id/members failed', { error });
    res.status(500).json({ success: false, message: 'Failed to add member' });
  }
});

router.patch('/vaults/:vaultId/members/:memberUserId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await adminUpdateVaultMemberRole(
      Number(req.params.vaultId),
      Number(req.params.memberUserId),
      req.body?.role
    );
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    res.json({
      success: true,
      data: { pmUserId: Number(req.params.memberUserId), role: result.role },
    });
  } catch (error) {
    logger.error('PATCH settings/vaults members failed', { error });
    res.status(500).json({ success: false, message: 'Failed to update member' });
  }
});

router.delete('/vaults/:vaultId/members/:memberUserId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await adminRemoveVaultMember(
      Number(req.params.vaultId),
      Number(req.params.memberUserId)
    );
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('DELETE settings/vaults members failed', { error });
    res.status(500).json({ success: false, message: 'Failed to remove member' });
  }
});

/** Transfer vault ownership (admin). Previous owner keeps Edit by default. */
router.patch('/vaults/:vaultId/owner', async (req: AuthRequest, res: Response) => {
  try {
    const schema = z.object({
      ownerUserId: z.coerce.number().int().positive(),
      keepPreviousOwnerAsEdit: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'ownerUserId is required' });
    }
    const result = await transferVaultOwnership({
      vaultId: Number(req.params.vaultId),
      newOwnerUserId: parsed.data.ownerUserId,
      invitedByUserId: req.user!.userId,
      keepPreviousOwnerAsEdit: parsed.data.keepPreviousOwnerAsEdit,
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    const members = await getVaultMembersForAdmin(Number(req.params.vaultId));
    res.json({
      success: true,
      message: 'Ownership transferred',
      data: members,
    });
  } catch (error) {
    logger.error('PATCH settings/vaults/:id/owner failed', { error });
    res.status(500).json({ success: false, message: 'Failed to transfer ownership' });
  }
});

export default router;
