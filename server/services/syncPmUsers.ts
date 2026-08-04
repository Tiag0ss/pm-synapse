import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { normalizeEmail } from './appSettings';
import {
  fetchPmUsers,
  normalizePmUserList,
  type PmUserSummary,
} from './pmClient';
import logger from '../utils/logger';
import { bumpSessionVersion } from './sessionVersion';

export type SyncPmUsersResult = {
  created: number;
  updated: number;
  linked: number;
  skipped: number;
  failed: number;
  errors: Array<{ pmUserId: number; message: string }>;
};

function sanitizeUsername(raw: string, pmUserId: number): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^\w.\-@]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned.length >= 2 ? cleaned : `pm_user_${pmUserId}`;
}

async function usernameTaken(username: string, excludeId?: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    excludeId
      ? 'SELECT Id FROM Users WHERE Username = ? AND Id != ? LIMIT 1'
      : 'SELECT Id FROM Users WHERE Username = ? LIMIT 1',
    excludeId ? [username, excludeId] : [username]
  );
  return rows.length > 0;
}

async function uniqueUsername(desired: string, pmUserId: number, excludeId?: number): Promise<string> {
  let base = sanitizeUsername(desired, pmUserId);
  if (!(await usernameTaken(base, excludeId))) return base;
  const suffix = `_${pmUserId}`;
  base = sanitizeUsername(`${desired}${suffix}`, pmUserId).slice(0, 64);
  if (!(await usernameTaken(base, excludeId))) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base.slice(0, Math.max(2, 64 - String(i).length - 1))}_${i}`;
    if (!(await usernameTaken(candidate, excludeId))) return candidate;
  }
  return `pm_user_${pmUserId}_${Date.now().toString(36)}`.slice(0, 64);
}

async function upsertOne(
  pm: PmUserSummary,
  result: SyncPmUsersResult
): Promise<void> {
  const email = normalizeEmail(pm.email);
  if (!email || !email.includes('@')) {
    result.skipped += 1;
    result.errors.push({
      pmUserId: pm.id,
      message: 'Skipped — no usable email on PM user',
    });
    return;
  }

  const [byPm] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Username, Email, PmUserId, IsAdmin, IsActive FROM Users WHERE PmUserId = ?',
    [pm.id]
  );
  if (byPm[0]) {
    const id = Number(byPm[0].Id);
    const wasActive = Number(byPm[0].IsActive) === 1;
    const username = await uniqueUsername(pm.username || email.split('@')[0], pm.id, id);
    await pool.execute(
      `UPDATE Users SET Username = ?, Email = ?, IsActive = ? WHERE Id = ?`,
      [username, email, pm.isActive ? 1 : 0, id]
    );
    if (wasActive && !pm.isActive) {
      await bumpSessionVersion(id);
    }
    result.updated += 1;
    return;
  }

  const [byEmail] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, PmUserId FROM Users WHERE Email = ?',
    [email]
  );
  if (byEmail[0]) {
    const id = Number(byEmail[0].Id);
    const existingPm = byEmail[0].PmUserId != null ? Number(byEmail[0].PmUserId) : null;
    if (existingPm != null && existingPm !== pm.id) {
      result.failed += 1;
      result.errors.push({
        pmUserId: pm.id,
        message: `Email ${email} already linked to a different PM user (#${existingPm})`,
      });
      return;
    }
    const username = await uniqueUsername(pm.username || email.split('@')[0], pm.id, id);
    await pool.execute(
      `UPDATE Users SET PmUserId = ?, Username = ?, IsActive = ? WHERE Id = ?`,
      [pm.id, username, pm.isActive ? 1 : 0, id]
    );
    result.linked += 1;
    result.updated += 1;
    return;
  }

  const username = await uniqueUsername(pm.username || email.split('@')[0], pm.id);
  try {
    await pool.execute<ResultSetHeader>(
      `INSERT INTO Users (Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive)
       VALUES (?, ?, NULL, ?, ?, ?)`,
      [username, email, pm.id, pm.isAdmin ? 1 : 0, pm.isActive ? 1 : 0]
    );
    result.created += 1;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    result.failed += 1;
    result.errors.push({
      pmUserId: pm.id,
      message:
        code === 'ER_DUP_ENTRY'
          ? 'Username or email conflict'
          : (error as Error).message || 'Insert failed',
    });
  }
}

/**
 * Pull PM users into Synapse (admin action).
 * Matches by PmUserId then email; creates SSO-ready accounts (no local password).
 * Does not delete Synapse-only users. Does not change IsAdmin on existing rows.
 */
export async function syncUsersFromPm(actingUserId: number): Promise<SyncPmUsersResult> {
  const res = await fetchPmUsers(actingUserId);
  if (!res.ok) {
    throw Object.assign(
      new Error(res.data.message || 'Failed to fetch users from Project Management'),
      { status: res.status }
    );
  }

  const pmUsers = normalizePmUserList(res.data);
  const result: SyncPmUsersResult = {
    created: 0,
    updated: 0,
    linked: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  if (!pmUsers.length) {
    logger.warn('PM user sync returned empty list', { actingUserId });
    return result;
  }

  for (const pm of pmUsers) {
    try {
      await upsertOne(pm, result);
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        pmUserId: pm.id,
        message: (error as Error).message || 'Sync failed for user',
      });
      logger.warn('PM user sync row failed', { pmUserId: pm.id, error });
    }
  }

  return result;
}
