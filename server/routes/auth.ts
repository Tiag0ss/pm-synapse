import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import {
  authenticateSession,
  AuthRequest,
  signSession,
  SynapseUser,
} from '../middleware/auth';
import { encryptSecret } from '../services/crypto';
import { accessibleVault } from '../services/vaultAccess';
import { PM_BASE_URL } from '../services/pmClient';
import {
  countUsers,
  getPmApiKey,
  getPublicAuthProviders,
  getSettingBool,
  getSettingInt,
  isSmtpConfigured,
  isSsoEnvConfigured,
  normalizeEmail,
  SETTING_KEYS,
} from '../services/appSettings';
import { sendPasswordResetEmail } from '../services/email';
import { hasValidSsoToken } from '../services/pmClient';
import { bumpSessionVersion } from '../services/sessionVersion';
import logger from '../utils/logger';

const router = Router();

const COOKIE = 'synapse_session';
const LAST_VAULT_COOKIE = 'synapse_last_vault';
const BCRYPT_ROUNDS = 10;
/** Valid bcrypt hash so missing users still take a compare (timing). */
const DUMMY_PASSWORD_HASH = '$2b$10$Sy95sWgdHL.ifT.pMMYP2.FuRe4Kp6eSFOmnNA6.2Teov.aPDbcK2';

function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3010}`
  ).replace(/\/+$/, '');
}

function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1';
}

function setSessionCookie(res: Response, user: SynapseUser): void {
  const session = signSession(user);
  res.cookie(COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

type UserRow = {
  Id: number;
  Username: string;
  Email: string;
  PasswordHash: string | null;
  PmUserId: number | null;
  IsAdmin: number;
  IsActive: number;
  SessionVersion: number;
};

async function fetchUserById(id: number): Promise<UserRow | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, SessionVersion FROM Users WHERE Id = ?`,
    [id]
  );
  return (rows[0] as UserRow) || null;
}

function toSessionUser(row: UserRow): SynapseUser {
  return {
    userId: Number(row.Id),
    username: String(row.Username),
    email: String(row.Email),
    isAdmin: Number(row.IsAdmin) === 1,
    sessionVersion: Number(row.SessionVersion ?? 0),
  };
}

async function touchLastLogin(userId: number): Promise<void> {
  await pool.execute('UPDATE Users SET LastLoginAt = CURRENT_TIMESTAMP WHERE Id = ?', [userId]);
}

async function storeSsoToken(userId: number, accessToken: string, expiresIn: number): Promise<void> {
  const expiresAt = new Date(Date.now() + (expiresIn || 28800) * 1000);
  await pool.execute(
    `INSERT INTO SsoTokens (UserId, AccessTokenEnc, ExpiresAt)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE AccessTokenEnc = VALUES(AccessTokenEnc), ExpiresAt = VALUES(ExpiresAt)`,
    [userId, encryptSecret(accessToken), expiresAt]
  );
}

/** Resolve or create Synapse user from PM SSO profile (PmUserId, then email). */
async function resolveUserFromSso(pm: {
  id: number;
  username: string;
  email: string;
}): Promise<{ ok: true; user: UserRow } | { ok: false; message: string }> {
  const email = normalizeEmail(pm.email);
  if (!email) {
    return { ok: false, message: 'SSO user has no email — cannot link accounts' };
  }

  const [byPm] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, SessionVersion FROM Users WHERE PmUserId = ?`,
    [pm.id]
  );
  if (byPm[0]) {
    const row = byPm[0] as UserRow;
    if (Number(row.IsActive) !== 1) {
      return { ok: false, message: 'This account is disabled' };
    }
    await pool.execute(
      `UPDATE Users SET Username = ?, Email = ?, LastLoginAt = CURRENT_TIMESTAMP WHERE Id = ?`,
      [pm.username, email, row.Id]
    );
    const refreshed = await fetchUserById(Number(row.Id));
    return { ok: true, user: refreshed! };
  }

  const [byEmail] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, SessionVersion FROM Users WHERE Email = ?`,
    [email]
  );
  if (byEmail[0]) {
    const row = byEmail[0] as UserRow;
    if (Number(row.IsActive) !== 1) {
      return { ok: false, message: 'This account is disabled' };
    }
    if (row.PmUserId != null && Number(row.PmUserId) !== pm.id) {
      logger.warn('SSO email conflict with different PmUserId', {
        email,
        existingPm: row.PmUserId,
        incomingPm: pm.id,
      });
      return {
        ok: false,
        message: 'This email is already linked to a different Project Management account',
      };
    }
    await pool.execute(
      `UPDATE Users SET PmUserId = ?, Username = ?, LastLoginAt = CURRENT_TIMESTAMP WHERE Id = ?`,
      [pm.id, pm.username, row.Id]
    );
    const refreshed = await fetchUserById(Number(row.Id));
    return { ok: true, user: refreshed! };
  }

  const userCount = await countUsers();
  const isAdmin = userCount === 0 ? 1 : 0;
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO Users (Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, LastLoginAt)
     VALUES (?, ?, NULL, ?, ?, 1, CURRENT_TIMESTAMP)`,
    [pm.username, email, pm.id, isAdmin]
  );
  const created = await fetchUserById(Number(result.insertId));
  if (!created) return { ok: false, message: 'Failed to create user' };
  return { ok: true, user: created };
}

router.get('/providers', async (_req, res) => {
  try {
    const data = await getPublicAuthProviders();
    res.json({ success: true, data });
  } catch (error) {
    logger.error('providers failed', { error });
    res.status(500).json({ success: false, message: 'Failed to load auth providers' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const userCount = await countUsers();
    const allowReg = await getSettingBool(SETTING_KEYS.allowPublicRegistration, true);
    if (userCount > 0 && !allowReg) {
      return res.status(403).json({ success: false, message: 'Public registration is disabled' });
    }

    const minLen = await getSettingInt(SETTING_KEYS.minPasswordLength, 8);
    const schema = z.object({
      username: z.string().trim().min(2).max(64),
      email: z.string().trim().email().max(255),
      password: z.string().min(minLen).max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: `Invalid input (password min ${minLen} characters)`,
      });
    }

    const email = normalizeEmail(parsed.data.email);
    const username = parsed.data.username.trim();
    const hash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    const isAdmin = userCount === 0 ? 1 : 0;

    try {
      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO Users (Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, LastLoginAt)
         VALUES (?, ?, ?, NULL, ?, 1, CURRENT_TIMESTAMP)`,
        [username, email, hash, isAdmin]
      );
      const row = await fetchUserById(Number(result.insertId));
      if (!row) {
        return res.status(500).json({ success: false, message: 'Registration failed' });
      }
      const sessionUser = toSessionUser(row);
      setSessionCookie(res, sessionUser);
      res.status(201).json({ success: true, data: sessionUser });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ success: false, message: 'Username or email already in use' });
      }
      throw error;
    }
  } catch (error) {
    logger.error('register failed', { error });
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const schema = z.object({
      login: z.string().trim().min(1),
      password: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Login and password required' });
    }

    const login = parsed.data.login.trim();
    const emailNorm = normalizeEmail(login);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive, SessionVersion FROM Users
       WHERE Username = ? OR Email = ? LIMIT 1`,
      [login, emailNorm]
    );
    const row = rows[0] as UserRow | undefined;
    const hash = row?.PasswordHash ? String(row.PasswordHash) : DUMMY_PASSWORD_HASH;
    const ok = await bcrypt.compare(parsed.data.password, hash);
    if (!row || !row.PasswordHash || !ok || Number(row.IsActive) !== 1) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    await touchLastLogin(Number(row.Id));
    const sessionUser = toSessionUser(row);
    setSessionCookie(res, sessionUser);
    res.json({ success: true, data: sessionUser });
  } catch (error) {
    logger.error('login failed', { error });
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const generic = {
    success: true,
    message: 'If an account exists for that email, a reset link has been sent.',
  };
  try {
    const schema = z.object({ email: z.string().trim().email() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.json(generic);
    }
    if (!(await isSmtpConfigured())) {
      return res.json(generic);
    }
    const email = normalizeEmail(parsed.data.email);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, Email, PasswordHash, IsActive FROM Users WHERE Email = ? LIMIT 1`,
      [email]
    );
    const row = rows[0];
    if (row && Number(row.IsActive) === 1 && row.PasswordHash) {
      const raw = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await pool.execute(
        `INSERT INTO PasswordResetTokens (UserId, TokenHash, ExpiresAt) VALUES (?, ?, ?)`,
        [row.Id, tokenHash, expiresAt]
      );
      const resetUrl = `${appBaseUrl()}/reset-password?token=${raw}`;
      const sent = await sendPasswordResetEmail(String(row.Email), resetUrl);
      if (!sent.ok) {
        logger.warn('Password reset email failed', { message: sent.message });
      }
    }
    return res.json(generic);
  } catch (error) {
    logger.error('forgot-password failed', { error });
    return res.json(generic);
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const minLen = await getSettingInt(SETTING_KEYS.minPasswordLength, 8);
    const schema = z.object({
      token: z.string().min(20),
      password: z.string().min(minLen).max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: `Invalid token or password (min ${minLen} characters)`,
      });
    }
    const tokenHash = crypto.createHash('sha256').update(parsed.data.token).digest('hex');
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, UserId, ExpiresAt, UsedAt FROM PasswordResetTokens WHERE TokenHash = ? LIMIT 1`,
      [tokenHash]
    );
    const tok = rows[0];
    if (!tok || tok.UsedAt || new Date(tok.ExpiresAt).getTime() <= Date.now()) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }
    const hash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    await pool.execute('UPDATE Users SET PasswordHash = ? WHERE Id = ?', [hash, tok.UserId]);
    await bumpSessionVersion(Number(tok.UserId));
    await pool.execute('UPDATE PasswordResetTokens SET UsedAt = CURRENT_TIMESTAMP WHERE Id = ?', [
      tok.Id,
    ]);
    res.json({ success: true, message: 'Password updated — you can sign in now' });
  } catch (error) {
    logger.error('reset-password failed', { error });
    res.status(500).json({ success: false, message: 'Password reset failed' });
  }
});

router.get('/sso/start', async (_req, res) => {
  const allowSso = await getSettingBool(SETTING_KEYS.allowSsoLogin, true);
  if (!allowSso || !isSsoEnvConfigured()) {
    return res.status(403).send('SSO login is disabled');
  }
  const state = cryptoRandom();
  const redirectUri = `${appBaseUrl()}/api/auth/sso/callback`;
  const clientId = process.env.SSO_CLIENT_ID || 'pm-synapse';
  const url = new URL(`${PM_BASE_URL}/sso/authorize`);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('client_id', clientId);
  res.cookie('sso_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(),
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(url.toString());
});

router.get('/sso/callback', async (req, res) => {
  try {
    const allowSso = await getSettingBool(SETTING_KEYS.allowSsoLogin, true);
    if (!allowSso || !isSsoEnvConfigured()) {
      return res.status(403).send('SSO login is disabled');
    }

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const expected = (req as AuthRequest & { cookies?: Record<string, string> }).cookies?.sso_state;
    if (!code) {
      return res.status(400).send('Missing code');
    }
    if (!expected || !state || expected !== state) {
      res.clearCookie('sso_state');
      return res.status(400).send('Invalid state');
    }
    res.clearCookie('sso_state');

    const redirectUri = `${appBaseUrl()}/api/auth/sso/callback`;
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
      data?: {
        accessToken: string;
        expiresIn: number;
        user: { id: number; username: string; email: string };
      };
    };
    if (!tokenRes.ok || !payload.data?.accessToken) {
      logger.error('SSO token exchange failed', { payload });
      return res.status(401).send(payload.message || 'SSO failed');
    }

    const resolved = await resolveUserFromSso(payload.data.user);
    if (!resolved.ok) {
      return res.status(403).send(resolved.message);
    }

    await storeSsoToken(
      Number(resolved.user.Id),
      payload.data.accessToken,
      payload.data.expiresIn || 28800
    );

    const sessionUser = toSessionUser(resolved.user);
    setSessionCookie(res, sessionUser);

    const cookies = (req as AuthRequest & { cookies?: Record<string, string> }).cookies || {};
    const lastRaw = String(cookies[LAST_VAULT_COOKIE] || '').trim();
    const lastId = Number(lastRaw);
    if (Number.isFinite(lastId) && lastId > 0) {
      const access = await accessibleVault(lastId, sessionUser.userId, 'read');
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
  try {
    const row = await fetchUserById(req.user!.userId);
    if (!row || Number(row.IsActive) !== 1) {
      res.clearCookie(COOKIE);
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const [ssoToken, instanceKey, pmEnabled] = await Promise.all([
      hasValidSsoToken(req.user!.userId),
      getPmApiKey(),
      getSettingBool(SETTING_KEYS.pmIntegrationEnabled, true),
    ]);
    res.json({
      success: true,
      data: {
        userId: Number(row.Id),
        username: String(row.Username),
        email: String(row.Email),
        isAdmin: Number(row.IsAdmin) === 1,
        pmUserId: row.PmUserId != null ? Number(row.PmUserId) : null,
        hasPassword: Boolean(row.PasswordHash),
        authMethods: {
          local: Boolean(row.PasswordHash),
          sso: row.PmUserId != null,
        },
        pmIntegration: {
          enabled: pmEnabled,
          ssoToken,
          instanceApiKey: Boolean(instanceKey),
        },
      },
    });
  } catch (error) {
    logger.error('/me failed', { error });
    res.status(500).json({ success: false, message: 'Failed to load profile' });
  }
});

/** Update own profile (username / email / password). SSO-linked email is not editable. */
router.patch('/me', authenticateSession, async (req: AuthRequest, res: Response) => {
  try {
    const row = await fetchUserById(req.user!.userId);
    if (!row || Number(row.IsActive) !== 1) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const minLen = await getSettingInt(SETTING_KEYS.minPasswordLength, 8);
    const ssoLinked = row.PmUserId != null;
    const schema = z.object({
      username: z.string().trim().min(2).max(64).optional(),
      email: z.string().trim().email().max(255).optional(),
      currentPassword: z.string().min(1).optional(),
      newPassword: z.string().min(minLen).max(200).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: `Invalid profile data (password min ${minLen} characters when set)`,
      });
    }

    const sets: string[] = [];
    const params: Array<string | number> = [];

    if (parsed.data.username != null && parsed.data.username !== String(row.Username)) {
      sets.push('Username = ?');
      params.push(parsed.data.username);
    }

    if (parsed.data.email != null) {
      const nextEmail = normalizeEmail(parsed.data.email);
      if (nextEmail !== normalizeEmail(String(row.Email))) {
        if (ssoLinked) {
          return res.status(400).json({
            success: false,
            message:
              'Email is managed by Project Management SSO and cannot be changed here',
          });
        }
        sets.push('Email = ?');
        params.push(nextEmail);
      }
    }

    if (parsed.data.newPassword != null) {
      const hasLocal = Boolean(row.PasswordHash);
      if (hasLocal) {
        if (!parsed.data.currentPassword) {
          return res.status(400).json({
            success: false,
            message: 'Current password is required to set a new password',
          });
        }
        const ok = await bcrypt.compare(
          parsed.data.currentPassword,
          String(row.PasswordHash)
        );
        if (!ok) {
          return res.status(400).json({ success: false, message: 'Current password is incorrect' });
        }
      }
      const hash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS);
      sets.push('PasswordHash = ?');
      params.push(hash);
      sets.push('SessionVersion = SessionVersion + 1');
    }

    if (!sets.length) {
      return res.status(400).json({ success: false, message: 'No changes to save' });
    }

    params.push(row.Id);
    try {
      await pool.execute(`UPDATE Users SET ${sets.join(', ')} WHERE Id = ?`, params);
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          success: false,
          message: 'Username or email already in use',
        });
      }
      throw error;
    }

    const updated = await fetchUserById(req.user!.userId);
    if (!updated) {
      return res.status(500).json({ success: false, message: 'Profile updated but reload failed' });
    }
    const user = toSessionUser(updated);
    setSessionCookie(res, user);

    res.json({
      success: true,
      message: 'Profile updated',
      data: {
        userId: user.userId,
        username: user.username,
        email: user.email,
        isAdmin: user.isAdmin,
        pmUserId: updated.PmUserId != null ? Number(updated.PmUserId) : null,
        hasPassword: Boolean(updated.PasswordHash),
        authMethods: {
          local: Boolean(updated.PasswordHash),
          sso: updated.PmUserId != null,
        },
      },
    });
  } catch (error) {
    logger.error('PATCH /me failed', { error });
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

function cryptoRandom(): string {
  return crypto.randomBytes(16).toString('hex');
}

export default router;
