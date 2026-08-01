import { decryptSecret } from './crypto';
import { pool, RowDataPacket } from '../config/database';
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
const tokenCache = new Map<number, { token: string; expiresAtMs: number }>();
const TOKEN_CACHE_TTL_MS = 5 * 60_000;

export async function getPmAccessToken(pmUserId: number): Promise<string | null> {
  const cached = tokenCache.get(pmUserId);
  if (cached && cached.expiresAtMs > Date.now() + 60_000) {
    return cached.token;
  }

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT AccessTokenEnc, ExpiresAt FROM SsoTokens WHERE PmUserId = ?',
    [pmUserId]
  );
  if (!rows.length) {
    tokenCache.delete(pmUserId);
    logger.warn('No PM SSO token stored for user', { pmUserId });
    return null;
  }
  const expiresAt = new Date(rows[0].ExpiresAt);
  // 60s skew buffer
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 60_000) {
    tokenCache.delete(pmUserId);
    logger.warn('PM SSO token expired or invalid expiry', { pmUserId, expiresAt: rows[0].ExpiresAt });
    return null;
  }
  try {
    const token = decryptSecret(String(rows[0].AccessTokenEnc));
    const cacheUntil = Math.min(expiresAt.getTime(), Date.now() + TOKEN_CACHE_TTL_MS);
    tokenCache.set(pmUserId, { token, expiresAtMs: cacheUntil });
    return token;
  } catch (error) {
    tokenCache.delete(pmUserId);
    logger.error('Failed to decrypt PM token', { error, pmUserId });
    return null;
  }
}

async function pmFetch<T>(
  pmUserId: number,
  path: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T & { message?: string; success?: boolean } }> {
  const token = await getPmAccessToken(pmUserId);
  if (!token) {
    return {
      ok: false,
      status: 401,
      data: { message: 'SSO session expired — sign in again with Project Management' } as T & {
        message?: string;
      },
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
        pmUserId,
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
    else if (obj.data && typeof obj.data === 'object' && Array.isArray((obj.data as { organizations?: unknown }).organizations)) {
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

export async function fetchPmOrganizations(pmUserId: number) {
  return pmFetch<{ organizations?: unknown[]; data?: unknown[] }>(pmUserId, '/api/organizations');
}

export async function fetchPmProjectStatuses(pmUserId: number, organizationId: number) {
  return pmFetch<{ statuses?: Array<{ Id: number }>; data?: Array<{ Id: number }> }>(
    pmUserId,
    `/api/status-values/project/${organizationId}`
  );
}

export async function fetchPmTaskStatuses(pmUserId: number, organizationId: number) {
  return pmFetch<{ statuses?: Array<{ Id: number }>; data?: Array<{ Id: number }> }>(
    pmUserId,
    `/api/status-values/task/${organizationId}`
  );
}

export async function fetchPmTaskPriorities(pmUserId: number, organizationId: number) {
  return pmFetch<{ priorities?: Array<{ Id: number }>; data?: Array<{ Id: number }> }>(
    pmUserId,
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
export async function fetchPmProjectTasks(pmUserId: number, projectId: number) {
  return pmFetch<{ tasks?: PmTaskSummary[]; success?: boolean }>(
    pmUserId,
    `/api/tasks/project/${projectId}`
  );
}

export function isPmTaskDone(task: PmTaskSummary): boolean {
  return Number(task.StatusIsClosed || 0) === 1 || Number(task.StatusIsCancelled || 0) === 1;
}

export async function createPmProject(
  pmUserId: number,
  body: { organizationId: number; projectName: string; description?: string; status: number }
) {
  return pmFetch<{ projectId?: number; id?: number; data?: { Id?: number } }>(pmUserId, '/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function createPmTask(
  pmUserId: number,
  body: {
    projectId: number;
    taskName: string;
    description?: string;
    status: number;
    priority: number;
    synapseVaultId?: number;
    synapseNoteId?: number;
    synapseMarkerId?: string;
    synapseNoteUrl?: string;
  }
) {
  return pmFetch<{ taskId?: number; id?: number; data?: { Id?: number } }>(pmUserId, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updatePmTask(
  pmUserId: number,
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
  return pmFetch<{ success?: boolean }>(pmUserId, `/api/tasks/${taskId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function pickStatusId(
  list: Array<{ Id: number; IsDefault?: number; IsClosed?: number }>,
  preferClosed: boolean
): number | null {
  if (!list.length) return null;
  if (preferClosed) {
    const closed = list.find((s) => Number(s.IsClosed) === 1);
    if (closed) return Number(closed.Id);
  } else {
    const open = list.find((s) => Number(s.IsClosed) !== 1 && Number(s.IsDefault) === 1);
    if (open) return Number(open.Id);
    const anyOpen = list.find((s) => Number(s.IsClosed) !== 1);
    if (anyOpen) return Number(anyOpen.Id);
  }
  return Number(list[0].Id);
}

export async function resolveTaskStatusId(
  pmUserId: number,
  organizationId: number,
  checked: boolean
): Promise<number | null> {
  const statusRes = await fetchPmTaskStatuses(pmUserId, organizationId);
  const statusList =
    (statusRes.data as { statuses?: Array<{ Id: number; IsDefault?: number; IsClosed?: number }> }).statuses ||
    (Array.isArray(statusRes.data)
      ? (statusRes.data as Array<{ Id: number; IsDefault?: number; IsClosed?: number }>)
      : []);
  return pickStatusId(statusList, checked);
}

export { PM_BASE_URL, SYNAPSE_PUBLIC_URL };
