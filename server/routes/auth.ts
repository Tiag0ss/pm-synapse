import { Router, Response } from 'express';
import { pool } from '../config/database';
import { authenticateSession, AuthRequest, signSession } from '../middleware/auth';
import { encryptSecret } from '../services/crypto';
import { accessibleVault } from '../services/vaultAccess';
import { PM_BASE_URL } from '../services/pmClient';
import logger from '../utils/logger';

const router = Router();

const COOKIE = 'synapse_session';
const LAST_VAULT_COOKIE = 'synapse_last_vault';

router.get('/sso/start', (req, res) => {
  const state = String(req.query.state || cryptoRandom());
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3010}`}/api/auth/sso/callback`;
  const clientId = process.env.SSO_CLIENT_ID || 'pm-synapse';
  const url = new URL(`${PM_BASE_URL}/sso/authorize`);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('client_id', clientId);
  res.cookie('sso_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(url.toString());
});

router.get('/sso/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const expected = (req as AuthRequest & { cookies?: Record<string, string> }).cookies?.sso_state;
    if (!code) {
      return res.status(400).send('Missing code');
    }
    if (expected && state && expected !== state) {
      return res.status(400).send('Invalid state');
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3010}`}/api/auth/sso/callback`;
    const tokenRes = await fetch(`${PM_BASE_URL}/api/sso/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.SSO_CLIENT_ID || 'pm-synapse',
        client_secret: process.env.SSO_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
      }),
    });
    const payload = (await tokenRes.json()) as {
      success?: boolean;
      message?: string;
      data?: { accessToken: string; expiresIn: number; user: { id: number; username: string; email: string } };
    };
    if (!tokenRes.ok || !payload.data?.accessToken) {
      logger.error('SSO token exchange failed', { payload });
      return res.status(401).send(payload.message || 'SSO failed');
    }

    const user = payload.data.user;
    const expiresAt = new Date(Date.now() + (payload.data.expiresIn || 28800) * 1000);
    await pool.execute(
      `INSERT INTO UserProfiles (PmUserId, Username, Email, LastLoginAt)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE Username = VALUES(Username), Email = VALUES(Email), LastLoginAt = CURRENT_TIMESTAMP`,
      [user.id, user.username, user.email]
    );
    await pool.execute(
      `INSERT INTO SsoTokens (PmUserId, AccessTokenEnc, ExpiresAt)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE AccessTokenEnc = VALUES(AccessTokenEnc), ExpiresAt = VALUES(ExpiresAt)`,
      [user.id, encryptSecret(payload.data.accessToken), expiresAt]
    );

    const session = signSession({
      pmUserId: user.id,
      username: user.username,
      email: user.email,
    });
    res.cookie(COOKIE, session, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.clearCookie('sso_state');

    const cookies = (req as AuthRequest & { cookies?: Record<string, string> }).cookies || {};
    const lastRaw = String(cookies[LAST_VAULT_COOKIE] || '').trim();
    const lastId = Number(lastRaw);
    if (Number.isFinite(lastId) && lastId > 0) {
      const access = await accessibleVault(lastId, user.id, 'read');
      if (access) {
        return res.redirect(`/vaults/${lastId}`);
      }
    }
    return res.redirect('/');
  } catch (error) {
    logger.error('SSO callback error', { error });
    return res.status(500).send('SSO callback failed');
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ success: true });
});

router.get('/me', authenticateSession, async (req: AuthRequest, res: Response) => {
  res.json({
    success: true,
    data: {
      pmUserId: req.user!.pmUserId,
      username: req.user!.username,
      email: req.user!.email,
    },
  });
});

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export default router;
