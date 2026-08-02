import { decryptSecret } from './crypto';
import { pool, RowDataPacket } from '../config/database';
import { getPmApiKey, getSettingBool, SETTING_KEYS } from './appSettings';
import logger from '../utils/logger';

const PM_BASE_URL = (process.env.PM_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const SYNAPSE_PUBLIC_URL = (
  process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3010}`
).replace(/\/+$/, '');

export function buildPmTaskOpenUrl(projectId: number, taskId: number): string {
  return `${PM_BASE_URL}/projects/${projectId}?tab=tasks&taskId=${taskId}`;
}

export function buildSynapseNoteUrl(vaultId: number, noteId: number): string {
  return `${SYNAPSE_PUBLIC_URL}/vaults/${vaultId}?note=${noteId}`;
}

/** Short-lived decrypted token cache — avoids DB + decrypt on every PM API call. */
const ssoTokenCache = new Map<number, { token: string; expiresAtMs: number }>();
let instanceKeyCache: { token: string; expiresAtMs: number } | null = null;
const TOKEN_CACHE_TTL_MS = 5 * 60_000;

export function invalidatePmTokenCache(userId?: number): void {
  if (userId != null) ssoTokenCache.delete(userId);
  else {
    ssoTokenCache.clear();
    instanceKeyCache = null;
  }
}

export async function hasValidSsoToken(userId: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT ExpiresAt FROM SsoTokens WHERE UserId = ?',
    [userId]
  );
  if (!rows.length) return false;
  const expiresAt = new Date(rows[0].ExpiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now() + 60_000;
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
    ssoTokenCache.delete(userId);
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

/** Prefer per-user SSO token; fall back to instance PM API key. */
export async function resolvePmBearer(userId: number): Promise<string | null> {
  const enabled = await getSettingBool(SETTING_KEYS.pmIntegrationEnabled, true);
  if (!enabled) return null;

  const sso = await getSsoAccessToken(userId);
  if (sso) return sso;

  if (instanceKeyCache && instanceKeyCache.expiresAtMs > Date.now() + 60_000) {
    return instanceKeyCache.token;
  }
  const apiKey = await getPmApiKey();
  if (apiKey) {
    instanceKeyCache = { token: apiKey, expiresAtMs: Date.now() + TOKEN_CACHE_TTL_MS };
    return apiKey;
  }
  logger.warn('No PM credentials (SSO token or instance API key)', { userId });
  return null;
}

/** @deprecated use resolvePmBearer — kept as alias for call-site compatibility during rename */
export async function getPmAccessToken(userId: number): Promise<string | null> {
  return resolvePmBearer(userId);
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

  const token = await resolvePmBearer(userId);
  if (!token) {
    return {
      ok: false,
      status: 401,
      data: {
        message:
          'No Project Management credentials — sign in with PM (SSO) or ask an admin to set an API key in Settings',
      } as T & { message?: string },
    };
  }
  try {
    const res = await fetch(`${PM_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string; success?: boolean };
    if (!res.ok) {
      logger.warn('PM API call failed', {
        path,
        status: res.status,
        message: data.message,
        userId,
      });
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
  IsDefault?: number | boolean | null;
  IsClosed?: number | boolean | null;
  IsCancelled?: number | boolean | null;
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
  Status?: number | null;
  StatusIsClosed?: number | boolean | null;
  StatusIsCancelled?: number | boolean | null;
};

/** Fetch tasks for a PM project (includes StatusIsClosed / StatusIsCancelled). */
export async function fetchPmProjectTasks(userId: number, projectId: number) {
  return pmFetch<{ tasks?: PmTaskSummary[]; success?: boolean }>(
    userId,
    `/api/tasks/project/${projectId}`
  );
}

export function isPmTaskDone(task: PmTaskSummary): boolean {
  return Number(task.StatusIsClosed || 0) === 1 || Number(task.StatusIsCancelled || 0) === 1;
}

export function normalizePmTaskStatusList(data: unknown): PmTaskStatusValue[] {
  const nested = data as { statuses?: PmTaskStatusValue[]; data?: PmTaskStatusValue[] } | null;
  const list =
    (nested && Array.isArray(nested.statuses) && nested.statuses) ||
    (nested && Array.isArray(nested.data) && nested.data) ||
    (Array.isArray(data) ? (data as PmTaskStatusValue[]) : []);
  return list.filter((s) => s && Number.isFinite(Number(s.Id)));
}

export function statusNameFromId(
  statusList: PmTaskStatusValue[],
  statusId: number | null | undefined
): string | null {
  if (statusId == null || !Number.isFinite(Number(statusId))) return null;
  const row = statusList.find((s) => Number(s.Id) === Number(statusId));
  if (!row) return null;
  const name = String(row.Name || row.Label || '').trim();
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
      const n = String(s.Name || '').trim().toLowerCase();
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

/** List all PM users (requires admin SSO token or admin API key). */
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

export { PM_BASE_URL, SYNAPSE_PUBLIC_URL };
