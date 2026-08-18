import { decryptSecret, encryptSecret } from './crypto';
import { pool, RowDataPacket } from '../config/database';
import { getSettingBool, SETTING_KEYS } from './appSettings';
import logger from '../utils/logger';

export const PM_BASE_URL = (process.env.PM_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SYNAPSE_PUBLIC_URL = (
  process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3010}`
).replace(/\/+$/, '');

export function buildPmTaskOpenUrl(projectId: number, taskId: number): string {
  return `${PM_BASE_URL}/projects/${projectId}?tab=tasks&taskId=${taskId}`;
}

export function buildSynapseNoteUrl(vaultId: number, noteId: number): string {
  return `${SYNAPSE_PUBLIC_URL}/vaults/${vaultId}?note=${noteId}`;
}

export function pmApiKeyPrefix(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return key.slice(0, 7) + '…' + key.slice(-4);
}

/** Short-lived decrypted token cache — avoids DB + decrypt on every PM API call. */
const ssoTokenCache = new Map<number, { token: string; expiresAtMs: number }>();
const personalKeyCache = new Map<number, { token: string; expiresAtMs: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60_000;

export function invalidatePmTokenCache(userId?: number): void {
  if (userId != null) {
    ssoTokenCache.delete(userId);
    personalKeyCache.delete(userId);
  } else {
    ssoTokenCache.clear();
    personalKeyCache.clear();
  }
}

export async function clearSsoToken(userId: number): Promise<void> {
  await pool.execute('DELETE FROM SsoTokens WHERE UserId = ?', [userId]);
  ssoTokenCache.delete(userId);
}

export async function hasValidSsoToken(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT ExpiresAt FROM SsoTokens WHERE UserId = ?',
    [userId]
  );
  if (!rows.length) return false;
  const expiresAt = new Date(rows[0].ExpiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 60_000) {
    await clearSsoToken(userId);
    return false;
  }
  return true;
}

export async function hasPersonalPmApiKey(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT PmApiKeyEnc FROM Users WHERE Id = ? LIMIT 1',
    [userId]
  );
  return Boolean(rows[0]?.PmApiKeyEnc);
}

export async function getPersonalPmApiKeyPrefix(userId: number): Promise<string | null> {
  const token = await getPersonalPmApiKey(userId);
  return pmApiKeyPrefix(token);
}

async function getSsoAccessToken(userId: number): Promise<string | null> {
  const cached = ssoTokenCache.get(userId);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT AccessTokenEnc, ExpiresAt FROM SsoTokens WHERE UserId = ?',
    [userId]
  );
  if (!rows.length) {
    ssoTokenCache.delete(userId);
    return null;
  }
  const expiresAt = new Date(rows[0].ExpiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 60_000) {
    await clearSsoToken(userId);
    return null;
  }
  try {
    const token = decryptSecret(String(rows[0].AccessTokenEnc));
    const cacheUntil = Math.min(expiresAt.getTime(), Date.now() + TOKEN_CACHE_TTL_MS);
    ssoTokenCache.set(userId, { token, expiresAtMs: cacheUntil });
    return token;
  } catch (error) {
    ssoTokenCache.delete(userId);
    logger.error('Failed to decrypt PM SSO token', { error, userId });
    return null;
  }
}

async function getPersonalPmApiKey(userId: number): Promise<string | null> {
  const cached = personalKeyCache.get(userId);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT PmApiKeyEnc FROM Users WHERE Id = ? LIMIT 1',
    [userId]
  );
  const enc = rows[0]?.PmApiKeyEnc != null ? String(rows[0].PmApiKeyEnc) : '';
  if (!enc) {
    personalKeyCache.delete(userId);
    return null;
  }
  try {
    const token = decryptSecret(enc);
    personalKeyCache.set(userId, { token, expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS });
    return token;
  } catch (error) {
    personalKeyCache.delete(userId);
    logger.error('Failed to decrypt personal PM API key', { error, userId });
    return null;
  }
}

export async function setPersonalPmApiKey(userId: number, rawKey: string | null): Promise<void> {
  const trimmed = rawKey != null ? String(rawKey).trim() : '';
  if (!trimmed) {
    await pool.execute('UPDATE Users SET PmApiKeyEnc = NULL WHERE Id = ?', [userId]);
    personalKeyCache.delete(userId);
    return;
  }
  await pool.execute('UPDATE Users SET PmApiKeyEnc = ? WHERE Id = ?', [
    encryptSecret(trimmed),
    userId,
  ]);
  personalKeyCache.delete(userId);
}

export type PmBearerSource = 'sso' | 'personal';

export async function resolvePmBearerWithSource(
  userId: number
): Promise<{ token: string; source: PmBearerSource } | null> {
  const enabled = await getSettingBool(SETTING_KEYS.pmIntegrationEnabled, true);
  if (!enabled) return null;

  const sso = await getSsoAccessToken(userId);
  if (sso) return { token: sso, source: 'sso' };

  const personal = await getPersonalPmApiKey(userId);
  if (personal) return { token: personal, source: 'personal' };

  logger.warn('No PM credentials (SSO token or personal API key)', { userId });
  return null;
}

/** Prefer per-user SSO token; else personal pt_… API key. */
export async function resolvePmBearer(userId: number): Promise<string | null> {
  const resolved = await resolvePmBearerWithSource(userId);
  return resolved?.token ?? null;
}

/** @deprecated use resolvePmBearer — kept as alias for call-site compatibility during rename */
export async function getPmAccessToken(userId: number): Promise<string | null> {
  return resolvePmBearer(userId);
}

export const PM_NO_CREDENTIALS_MESSAGE =
  'No Project Management credentials — reconnect via SSO or add a personal API token in Profile';


async function persistRefreshedSsoToken(userId: number, accessToken: string): Promise<void> {
  // Sliding refresh from PM authenticateToken (X-New-Token) issues a new 24h JWT.
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.execute(
    `INSERT INTO SsoTokens (UserId, AccessTokenEnc, ExpiresAt)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE AccessTokenEnc = VALUES(AccessTokenEnc), ExpiresAt = VALUES(ExpiresAt)`,
    [userId, encryptSecret(accessToken), expiresAt]
  );
  ssoTokenCache.set(userId, {
    token: accessToken,
    expiresAtMs: Math.min(expiresAt.getTime(), Date.now() + TOKEN_CACHE_TTL_MS),
  });
}

async function pmFetch<T>(
  userId: number,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T & { message?: string; success?: boolean } }> {
  const enabled = await getSettingBool(SETTING_KEYS.pmIntegrationEnabled, true);
  if (!enabled) {
    return {
      ok: false,
      status: 503,
      data: {
        message: 'Project Management integration is disabled in Settings',
      } as T & { message?: string },
    };
  }

  const resolved = await resolvePmBearerWithSource(userId);
  if (!resolved) {
    return {
      ok: false,
      status: 401,
      data: {
        message: PM_NO_CREDENTIALS_MESSAGE,
      } as T & { message?: string },
    };
  }
  try {
    const res = await fetch(`${PM_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string; success?: boolean };

    if (resolved.source === 'sso') {
      const refreshed = res.headers.get('X-New-Token') || res.headers.get('x-new-token');
      if (refreshed && refreshed.trim()) {
        try {
          await persistRefreshedSsoToken(userId, refreshed.trim());
        } catch (error) {
          logger.warn('Failed to persist refreshed PM SSO token', { error, userId });
        }
      }
    }

    if (!res.ok) {
      logger.warn('PM API call failed', {
        path,
        status: res.status,
        message: data.message,
        userId,
        source: resolved.source,
      });
      if (res.status === 401) {
        if (resolved.source === 'sso') {
          await clearSsoToken(userId);
        } else {
          personalKeyCache.delete(userId);
        }
      }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    logger.error('PM API network error', { path, error, pmBase: PM_BASE_URL });
    return {
      ok: false,
      status: 502,
      data: {
        message: `Could not reach Project Management at ${PM_BASE_URL}`,
      } as T & { message?: string },
    };
  }
}
/** Normalize PM organization list from various response shapes. */
export function normalizeOrganizationList(payload: unknown): Array<{ Id: number; Name: string }> {
  let raw: unknown = payload;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.organizations)) raw = obj.organizations;
    else if (Array.isArray(obj.data)) raw = obj.data;
    else if (
      obj.data &&
      typeof obj.data === 'object' &&
      Array.isArray((obj.data as { organizations?: unknown }).organizations)
    ) {
      raw = (obj.data as { organizations: unknown[] }).organizations;
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      const row = o as { Id?: number; id?: number; Name?: string; name?: string };
      const Id = Number(row.Id ?? row.id);
      const Name = String(row.Name ?? row.name ?? Id);
      return { Id, Name };
    })
    .filter((o) => Number.isFinite(o.Id) && o.Id > 0);
}

export async function fetchPmOrganizations(userId: number) {
  return pmFetch<{ organizations?: unknown[]; data?: unknown[] }>(userId, '/api/organizations');
}

/** List PM projects the user can access (optionally scoped to an organization). */
export async function fetchPmProjects(userId: number, organizationId?: number | null) {
  const qs =
    organizationId != null && Number(organizationId) > 0
      ? `?organizationId=${Number(organizationId)}`
      : '';
  return pmFetch<{ projects?: unknown[]; data?: unknown[]; success?: boolean }>(
    userId,
    `/api/projects${qs}`
  );
}

export type PmProjectSummary = {
  Id: number;
  ProjectName?: string | null;
  Name?: string | null;
};

export function normalizePmProjectList(data: unknown): PmProjectSummary[] {
  const nested = data as { projects?: unknown[]; data?: unknown[] } | null;
  const raw =
    (nested && Array.isArray(nested.projects) && nested.projects) ||
    (nested && Array.isArray(nested.data) && nested.data) ||
    (Array.isArray(data) ? data : []);
  const out: PmProjectSummary[] = [];
  for (const row of raw) {
    const p = row as Record<string, unknown>;
    const Id = Number(p.Id ?? p.id);
    if (!Number.isFinite(Id) || Id <= 0) continue;
    out.push({
      Id,
      ProjectName:
        p.ProjectName != null
          ? String(p.ProjectName)
          : p.projectName != null
            ? String(p.projectName)
            : p.Name != null
              ? String(p.Name)
              : null,
      Name: p.Name != null ? String(p.Name) : null,
    });
  }
  return out;
}

export async function fetchPmProjectStatuses(userId: number, organizationId: number) {
  return pmFetch<{ statuses?: Array<{ Id: number }>; data?: Array<{ Id: number }> }>(
    userId,
    `/api/status-values/project/${organizationId}`
  );
}

export type PmTaskStatusValue = {
  Id: number;
  Name?: string | null;
  Label?: string | null;
  /** PM column alias — normalized onto Name */
  StatusName?: string | null;
  IsDefault?: number | boolean | null;
  IsClosed?: number | boolean | null;
  IsCancelled?: number | boolean | null;
  IsInProgress?: number | boolean | null;
  HideFromPlanningAndStatistics?: number | boolean | null;
};

export async function fetchPmTaskStatuses(userId: number, organizationId: number) {
  return pmFetch<{ statuses?: PmTaskStatusValue[]; data?: PmTaskStatusValue[] }>(
    userId,
    `/api/status-values/task/${organizationId}`
  );
}

export async function fetchPmTaskPriorities(userId: number, organizationId: number) {
  return pmFetch<{ priorities?: Array<{ Id: number }>; data?: Array<{ Id: number }> }>(
    userId,
    `/api/status-values/priority/${organizationId}`
  );
}

export type PmTaskSummary = {
  Id: number;
  TaskName?: string | null;
  Status?: number | null;
  /** Present on GET /api/tasks/project/:id */
  StatusName?: string | null;
  StatusIsClosed?: number | boolean | null;
  StatusIsCancelled?: number | boolean | null;
  /** Present on some task detail endpoints; optional on project list */
  StatusIsInProgress?: number | boolean | null;
  /** Joined from task status catalog on project task list */
  StatusHideFromPlanningAndStatistics?: number | boolean | null;
  SynapseVaultId?: number | null;
  SynapseNoteId?: number | null;
  SynapseMarkerId?: string | null;
  SynapseNoteUrl?: string | null;
  /** PM user id the task is assigned to (project task list). */
  AssignedTo?: number | null;
};

/** Fetch tasks for a PM project (includes StatusIsClosed / StatusIsCancelled / StatusName). */
export async function fetchPmProjectTasks(userId: number, projectId: number) {
  return pmFetch<{ tasks?: PmTaskSummary[]; success?: boolean }>(
    userId,
    `/api/tasks/project/${projectId}`
  );
}

function hasNonEmptySynapseField(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  const s = String(value).trim();
  return s.length > 0 && s !== '0';
}

/** True when the PM task already carries any Synapse reference. */
export function isPmTaskSynapseLinked(task: PmTaskSummary): boolean {
  return (
    hasNonEmptySynapseField(task.SynapseVaultId) ||
    hasNonEmptySynapseField(task.SynapseNoteId) ||
    hasNonEmptySynapseField(task.SynapseMarkerId) ||
    hasNonEmptySynapseField(task.SynapseNoteUrl)
  );
}

/** Normalize project task list payload into PmTaskSummary[]. */
export function normalizePmProjectTasks(data: unknown): PmTaskSummary[] {
  const nested = data as { tasks?: unknown[]; data?: unknown[] } | null;
  const raw =
    (nested && Array.isArray(nested.tasks) && nested.tasks) ||
    (nested && Array.isArray(nested.data) && nested.data) ||
    (Array.isArray(data) ? data : []);
  const out: PmTaskSummary[] = [];
  for (const row of raw) {
    const t = row as Record<string, unknown>;
    const Id = Number(t.Id ?? t.id);
    if (!Number.isFinite(Id) || Id <= 0) continue;
    out.push({
      Id,
      TaskName:
        t.TaskName != null
          ? String(t.TaskName)
          : t.taskName != null
            ? String(t.taskName)
            : t.Name != null
              ? String(t.Name)
              : null,
      Status: t.Status != null ? Number(t.Status) : null,
      StatusName: t.StatusName != null ? String(t.StatusName) : t.statusName != null ? String(t.statusName) : null,
      StatusIsClosed: t.StatusIsClosed as number | boolean | null | undefined,
      StatusIsCancelled: t.StatusIsCancelled as number | boolean | null | undefined,
      StatusIsInProgress: t.StatusIsInProgress as number | boolean | null | undefined,
      StatusHideFromPlanningAndStatistics: (() => {
        const raw =
          t.StatusHideFromPlanningAndStatistics ??
          t.statusHideFromPlanningAndStatistics ??
          t.HideFromPlanningAndStatistics ??
          t.hideFromPlanningAndStatistics;
        if (raw == null) return null;
        return Number(raw) === 1 ? 1 : 0;
      })(),
      SynapseVaultId: t.SynapseVaultId != null ? Number(t.SynapseVaultId) : t.synapseVaultId != null ? Number(t.synapseVaultId) : null,
      SynapseNoteId: t.SynapseNoteId != null ? Number(t.SynapseNoteId) : t.synapseNoteId != null ? Number(t.synapseNoteId) : null,
      SynapseMarkerId:
        t.SynapseMarkerId != null
          ? String(t.SynapseMarkerId)
          : t.synapseMarkerId != null
            ? String(t.synapseMarkerId)
            : null,
      SynapseNoteUrl:
        t.SynapseNoteUrl != null
          ? String(t.SynapseNoteUrl)
          : t.synapseNoteUrl != null
            ? String(t.synapseNoteUrl)
            : null,
      AssignedTo: (() => {
        const n = Number(
          t.AssignedTo ?? t.assignedTo ?? t.AssignedToUserId ?? t.AssigneeId ?? t.assigneeId
        );
        return Number.isFinite(n) && n > 0 ? n : null;
      })(),
    });
  }
  return out;
}

/**
 * Tasks with no Synapse refs, optionally excluding ids already linked in Synapse.
 */
export function listLinkablePmTasks(
  tasks: PmTaskSummary[],
  excludePmTaskIds?: Set<number> | Iterable<number> | null
): PmTaskSummary[] {
  const exclude =
    excludePmTaskIds instanceof Set
      ? excludePmTaskIds
      : new Set(excludePmTaskIds ? [...excludePmTaskIds] : []);
  return tasks.filter((t) => {
    const id = Number(t.Id);
    if (!Number.isFinite(id) || id <= 0) return false;
    if (exclude.has(id)) return false;
    return !isPmTaskSynapseLinked(t);
  });
}

export function isPmTaskDone(task: PmTaskSummary): boolean {
  return isPmTaskClosed(task) || isPmTaskCancelled(task);
}

export function isPmTaskClosed(task: PmTaskSummary): boolean {
  return Number(task.StatusIsClosed || 0) === 1;
}

/** True when Planner marks the task cancelled (flag, catalog, or status name). */
export function isPmTaskCancelled(
  task: PmTaskSummary,
  statusList?: PmTaskStatusValue[] | null
): boolean {
  if (Number(task.StatusIsCancelled || 0) === 1) return true;
  if (statusList && task.Status != null) {
    const row = statusList.find((s) => Number(s.Id) === Number(task.Status));
    if (row && Number(row.IsCancelled || 0) === 1) return true;
  }
  const name =
    String(task.StatusName || '').trim() ||
    (statusList ? statusNameFromId(statusList, task.Status) : null) ||
    '';
  return isPmStatusNameCancelled(name);
}

export function isPmStatusNameCancelled(statusName: string | null | undefined): boolean {
  const n = String(statusName || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!n) return false;
  return n === 'cancelled' || n === 'canceled' || n.includes('cancel');
}

/** True when Planner marks the status as in-progress (flag or name). */
export function isPmTaskInProgress(
  task: PmTaskSummary,
  statusList?: PmTaskStatusValue[] | null
): boolean {
  if (isPmTaskDone(task) || isPmTaskCancelled(task, statusList)) return false;
  if (Number(task.StatusIsInProgress || 0) === 1) return true;
  if (statusList && task.Status != null) {
    const row = statusList.find((s) => Number(s.Id) === Number(task.Status));
    if (row && Number(row.IsInProgress || 0) === 1) return true;
  }
  const name =
    String(task.StatusName || '').trim() ||
    (statusList ? statusNameFromId(statusList, task.Status) : null) ||
    '';
  return isPmStatusNameInProgress(name);
}

export function isPmStatusNameInProgress(statusName: string | null | undefined): boolean {
  const n = String(statusName || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!n) return false;
  return (
    n === 'in progress' ||
    n === 'inprogress' ||
    n === 'doing' ||
    n === 'wip' ||
    n === 'started' ||
    n === 'working' ||
    n === 'active' ||
    n.includes('in progress')
  );
}

/** True when Planner hides this status from planning views and statistics. */
export function isPmTaskHiddenFromPlanning(
  task: PmTaskSummary,
  statusList?: PmTaskStatusValue[] | null
): boolean {
  if (Number(task.StatusHideFromPlanningAndStatistics || 0) === 1) return true;
  if (statusList && task.Status != null) {
    const row = statusList.find((s) => Number(s.Id) === Number(task.Status));
    if (row && Number(row.HideFromPlanningAndStatistics || 0) === 1) return true;
  }
  return false;
}

export function normalizePmTaskStatusList(data: unknown): PmTaskStatusValue[] {
  const nested = data as { statuses?: unknown[]; data?: unknown[] } | null;
  const raw =
    (nested && Array.isArray(nested.statuses) && nested.statuses) ||
    (nested && Array.isArray(nested.data) && nested.data) ||
    (Array.isArray(data) ? data : []);
  const out: PmTaskStatusValue[] = [];
  for (const row of raw) {
    const s = row as Record<string, unknown>;
    const Id = Number(s.Id ?? s.id);
    if (!Number.isFinite(Id)) continue;
    const StatusName = s.StatusName != null ? String(s.StatusName) : null;
    const Name =
      (s.Name != null ? String(s.Name) : null) ||
      StatusName ||
      (s.Label != null ? String(s.Label) : null);
    out.push({
      Id,
      Name: Name ?? undefined,
      Label: s.Label != null ? String(s.Label) : Name ?? undefined,
      StatusName: StatusName ?? undefined,
      IsDefault: s.IsDefault as number | boolean | null | undefined,
      IsClosed: s.IsClosed as number | boolean | null | undefined,
      IsCancelled: s.IsCancelled as number | boolean | null | undefined,
      IsInProgress: s.IsInProgress as number | boolean | null | undefined,
      HideFromPlanningAndStatistics: s.HideFromPlanningAndStatistics as number | boolean | null | undefined,
    });
  }
  return out;
}

export function statusNameFromId(
  statusList: PmTaskStatusValue[],
  statusId: number | null | undefined
): string | null {
  if (statusId == null || !Number.isFinite(Number(statusId))) return null;
  const row = statusList.find((s) => Number(s.Id) === Number(statusId));
  if (!row) return null;
  const name = String(row.Name || row.StatusName || row.Label || '').trim();
  return name || null;
}

/**
 * Resolve PM task status id: prefer case-insensitive Name match on statusText,
 * else open vs closed by checked / done heuristic.
 */
export function resolvePmTaskStatusId(
  statusList: PmTaskStatusValue[],
  opts: { statusText?: string | null; checked?: boolean }
): number | null {
  if (!statusList.length) return null;
  const text = String(opts.statusText || '').trim().toLowerCase();
  if (text) {
    const byName = statusList.find((s) => {
      const n = String(s.Name || s.StatusName || '').trim().toLowerCase();
      const l = String(s.Label || '').trim().toLowerCase();
      return (n && n === text) || (l && l === text);
    });
    if (byName) return Number(byName.Id);
  }
  return pickStatusId(statusList, Boolean(opts.checked));
}

export async function createPmProject(
  userId: number,
  body: { organizationId: number; projectName: string; description?: string; status: number }
) {
  return pmFetch<{ projectId?: number; id?: number; data?: { Id?: number } }>(userId, '/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Read unsigned JWT payload `userId` (SSO access tokens only; not `pt_…`). */
function peekJwtUserId(token: string): number | null {
  if (!token || token.startsWith('pt_')) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as {
      userId?: unknown;
    };
    const id = Number(payload.userId);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * When the user enabled Profile → auto-assign, return their PM user id for `assignedTo`.
 * Prefer `Users.PmUserId`; fall back to SSO JWT `userId` if linked session exists.
 */
export async function resolveAutoAssignPmUserId(synapseUserId: number): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT PmUserId, PmAutoAssignOnCreate FROM Users WHERE Id = ? LIMIT 1',
    [synapseUserId]
  );
  const row = rows[0];
  if (!row || Number(row.PmAutoAssignOnCreate) !== 1) return null;

  if (row.PmUserId != null && Number(row.PmUserId) > 0) {
    return Number(row.PmUserId);
  }

  const sso = await getSsoAccessToken(synapseUserId);
  if (sso) {
    const fromJwt = peekJwtUserId(sso);
    if (fromJwt != null) return fromJwt;
  }

  logger.warn('PM auto-assign enabled but no PmUserId for Synapse user', { synapseUserId });
  return null;
}

/** PM user id linked to this Synapse account (SSO / Users.PmUserId), if any. */
export async function resolveLinkedPmUserId(synapseUserId: number): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT PmUserId FROM Users WHERE Id = ? LIMIT 1',
    [synapseUserId]
  );
  const linked = rows[0]?.PmUserId != null ? Number(rows[0].PmUserId) : 0;
  if (Number.isFinite(linked) && linked > 0) return linked;

  const sso = await getSsoAccessToken(synapseUserId);
  if (sso) {
    const fromJwt = peekJwtUserId(sso);
    if (fromJwt != null) return fromJwt;
  }
  return null;
}

export async function createPmTask(
  userId: number,
  body: {
    projectId: number;
    taskName: string;
    description?: string;
    status: number;
    priority: number;
    /** When set, creates a Planner subtask under this parent task */
    parentTaskId?: number | null;
    /** PM user id to assign; if omitted, may auto-assign from profile preference */
    assignedTo?: number | null;
    estimatedHours?: number;
    unscheduledWork?: boolean;
    synapseVaultId?: number;
    synapseNoteId?: number;
    synapseMarkerId?: string;
    synapseNoteUrl?: string;
  }
) {
  const payload: Record<string, unknown> = {
    projectId: body.projectId,
    taskName: body.taskName,
    status: body.status,
    priority: body.priority,
  };
  if (body.description != null) payload.description = body.description;
  if (body.parentTaskId != null) payload.parentTaskId = body.parentTaskId;
  if (body.estimatedHours != null && Number.isFinite(body.estimatedHours)) {
    payload.estimatedHours = body.estimatedHours;
  }
  if (body.unscheduledWork === true) payload.unscheduledWork = true;
  if (body.synapseVaultId != null) payload.synapseVaultId = body.synapseVaultId;
  if (body.synapseNoteId != null) payload.synapseNoteId = body.synapseNoteId;
  if (body.synapseMarkerId != null) payload.synapseMarkerId = body.synapseMarkerId;
  if (body.synapseNoteUrl != null) payload.synapseNoteUrl = body.synapseNoteUrl;

  const assignedTo =
    body.assignedTo != null && Number.isFinite(body.assignedTo) && body.assignedTo > 0
      ? Number(body.assignedTo)
      : await resolveAutoAssignPmUserId(userId);
  if (assignedTo != null) payload.assignedTo = assignedTo;

  return pmFetch<{ taskId?: number; id?: number; data?: { Id?: number } }>(userId, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updatePmTask(
  userId: number,
  taskId: number,
  body: {
    status?: number;
    taskName?: string;
    synapseVaultId?: number;
    synapseNoteId?: number;
    synapseMarkerId?: string;
    synapseNoteUrl?: string;
    /** When true, PM clears all Synapse* columns on the task. */
    clearSynapseLink?: boolean;
  }
) {
  return pmFetch<{ success?: boolean }>(userId, `/api/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function pickStatusId(list: PmTaskStatusValue[], preferClosed: boolean): number | null {
  if (!list.length) return null;
  if (preferClosed) {
    const closed = list.find(
      (s) => Number(s.IsClosed) === 1 || Number(s.IsCancelled) === 1
    );
    if (closed) return Number(closed.Id);
  } else {
    const open = list.find(
      (s) =>
        Number(s.IsClosed) !== 1 &&
        Number(s.IsCancelled) !== 1 &&
        Number(s.IsDefault) === 1
    );
    if (open) return Number(open.Id);
    const anyOpen = list.find(
      (s) => Number(s.IsClosed) !== 1 && Number(s.IsCancelled) !== 1
    );
    if (anyOpen) return Number(anyOpen.Id);
  }
  return Number(list[0].Id);
}

export async function resolveTaskStatusId(
  userId: number,
  organizationId: number,
  checked: boolean
): Promise<number | null> {
  const statusRes = await fetchPmTaskStatuses(userId, organizationId);
  const statusList = normalizePmTaskStatusList(statusRes.data);
  return pickStatusId(statusList, checked);
}

/** Resolve status id + display name for open/closed toggle. */
export async function resolveTaskStatusIdWithName(
  userId: number,
  organizationId: number,
  checked: boolean
): Promise<{ statusId: number | null; statusName: string | null }> {
  const statusRes = await fetchPmTaskStatuses(userId, organizationId);
  const statusList = normalizePmTaskStatusList(statusRes.data);
  const statusId = pickStatusId(statusList, checked);
  return { statusId, statusName: statusNameFromId(statusList, statusId) };
}

export type PmUserSummary = {
  id: number;
  username: string;
  email: string;
  isAdmin: boolean;
  isActive: boolean;
};

/** List all PM users (requires admin SSO or the admin’s personal pt_… token). */
export async function fetchPmUsers(userId: number) {
  return pmFetch<{ users?: unknown[]; data?: unknown[] }>(userId, '/api/users');
}

export function normalizePmUserList(payload: unknown): PmUserSummary[] {
  let raw: unknown = payload;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.users)) raw = obj.users;
    else if (Array.isArray(obj.data)) raw = obj.data;
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const u = row as {
        Id?: number;
        id?: number;
        Username?: string;
        username?: string;
        Email?: string;
        email?: string;
        IsAdmin?: number | boolean;
        isAdmin?: boolean;
        IsActive?: number | boolean;
        isActive?: boolean;
      };
      const id = Number(u.Id ?? u.id);
      const username = String(u.Username ?? u.username ?? '').trim();
      const email = String(u.Email ?? u.email ?? '').trim();
      const isAdmin = Number(u.IsAdmin ?? (u.isAdmin ? 1 : 0)) === 1;
      const isActive = u.IsActive === undefined && u.isActive === undefined
        ? true
        : Number(u.IsActive ?? (u.isActive ? 1 : 0)) === 1;
      return { id, username, email, isAdmin, isActive };
    })
    .filter((u) => Number.isFinite(u.id) && u.id > 0);
}
