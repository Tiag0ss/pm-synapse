import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateSession, AuthRequest, requireAdmin } from '../middleware/auth';
import {
  getDecryptedSetting,
  getPmApiKey,
  getSetting,
  getSettingBool,
  invalidateSettingsCache,
  isSmtpConfigured,
  pmApiKeyPrefix,
  SETTING_KEYS,
  setSetting,
} from '../services/appSettings';
import { invalidatePmTokenCache, PM_BASE_URL } from '../services/pmClient';
import { sendMail } from '../services/email';
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
      apiKey,
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
      getPmApiKey(),
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
          hasApiKey: Boolean(apiKey),
          apiKeyPrefix: pmApiKeyPrefix(apiKey),
          apiKeyFromEnv: Boolean((process.env.PM_API_KEY || '').trim()) && !(await getDecryptedSetting(SETTING_KEYS.pmApiKey)),
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
      /** omit = leave unchanged; empty string/null = clear */
      pmApiKey: z.string().max(200).nullable().optional(),
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
    if (d.pmApiKey !== undefined) {
      await setSetting(
        SETTING_KEYS.pmApiKey,
        d.pmApiKey === '' || d.pmApiKey == null ? null : d.pmApiKey
      );
      invalidatePmTokenCache();
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

export default router;
