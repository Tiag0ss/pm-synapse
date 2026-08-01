import { pool, RowDataPacket } from '../config/database';

export type VaultAccessRole = 'owner' | 'edit' | 'read';

export type VaultAccess = RowDataPacket & {
  AccessRole: VaultAccessRole;
};

const ROLE_RANK: Record<VaultAccessRole, number> = {
  read: 1,
  edit: 2,
  owner: 3,
};

export function roleMeets(role: VaultAccessRole, minimum: VaultAccessRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function normalizeMemberRole(role: unknown): 'read' | 'edit' | null {
  const r = String(role || '').toLowerCase();
  if (r === 'read' || r === 'edit') return r;
  return null;
}

/** Vault accessible to this user (owner or member), with optional minimum role. */
export async function accessibleVault(
  vaultId: number,
  pmUserId: number,
  minimum: VaultAccessRole = 'read'
): Promise<VaultAccess | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT v.*,
       CASE
         WHEN v.OwnerPmUserId = ? THEN 'owner'
         ELSE LOWER(COALESCE(m.Role, 'read'))
       END AS AccessRole
     FROM Vaults v
     LEFT JOIN VaultMembers m ON m.VaultId = v.Id AND m.PmUserId = ?
     WHERE v.Id = ?
       AND (v.OwnerPmUserId = ? OR m.PmUserId IS NOT NULL)`,
    [pmUserId, pmUserId, vaultId, pmUserId]
  );
  const row = rows[0];
  if (!row) return null;
  const role = String(row.AccessRole || 'read').toLowerCase() as VaultAccessRole;
  if (!roleMeets(role, minimum)) return null;
  return { ...row, AccessRole: role } as VaultAccess;
}

export async function listAccessibleVaults(pmUserId: number): Promise<VaultAccess[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT v.*,
       CASE
         WHEN v.OwnerPmUserId = ? THEN 'owner'
         ELSE LOWER(COALESCE(m.Role, 'read'))
       END AS AccessRole
     FROM Vaults v
     LEFT JOIN VaultMembers m ON m.VaultId = v.Id AND m.PmUserId = ?
     WHERE v.OwnerPmUserId = ? OR m.PmUserId IS NOT NULL
     ORDER BY v.Name ASC`,
    [pmUserId, pmUserId, pmUserId]
  );
  return rows.map((row) => ({
    ...row,
    AccessRole: String(row.AccessRole || 'read').toLowerCase() as VaultAccessRole,
  })) as VaultAccess[];
}

export const NOTE_VISIBILITY_VALUES = ['private', 'authenticated', 'unlisted', 'public'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITY_VALUES)[number];
