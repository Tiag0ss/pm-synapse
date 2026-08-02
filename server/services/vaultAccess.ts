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

/** Share Read is wiki-only; vault editor requires edit or owner. */
export function canOpenVaultApp(role: VaultAccessRole): boolean {
  return roleMeets(role, 'edit');
}

/** Any share membership (read/edit) or owner — used for private wiki audience. */
export function hasWikiShare(role: VaultAccessRole | null | undefined): boolean {
  return Boolean(role && roleMeets(role, 'read'));
}

export function normalizeMemberRole(role: unknown): 'read' | 'edit' | null {
  const r = String(role || '').toLowerCase();
  if (r === 'read' || r === 'edit') return r;
  return null;
}

export const NOTE_VISIBILITY_VALUES = ['private', 'authenticated', 'unlisted', 'public'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITY_VALUES)[number];

export function effectiveVisibility(noteVis: unknown, vaultDefault: unknown): string {
  return String(noteVis || vaultDefault || 'private').toLowerCase();
}

/**
 * Who may open the vault wiki (`/w/:slug`) given vault DefaultVisibility.
 * `AllowPublicPages` must already be checked by the caller.
 */
export function canOpenVaultWiki(
  vaultDefaultVisibility: unknown,
  isAuthed: boolean,
  hasShare: boolean
): { ok: boolean; reason?: 'auth' | 'private' | 'forbidden' } {
  const vis = effectiveVisibility(null, vaultDefaultVisibility);
  if (vis === 'public' || vis === 'unlisted') return { ok: true };
  if (vis === 'authenticated') {
    if (isAuthed) return { ok: true };
    return { ok: false, reason: 'auth' };
  }
  // private
  if (hasShare) return { ok: true };
  if (isAuthed) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'private' };
}

/** Whether this vault appears in the `/w` directory for the viewer. */
export function canListVaultInWikiDirectory(
  vaultDefaultVisibility: unknown,
  isAuthed: boolean,
  hasShare: boolean
): boolean {
  const vis = effectiveVisibility(null, vaultDefaultVisibility);
  if (vis === 'unlisted') return false;
  if (vis === 'public') return true;
  if (vis === 'authenticated') return isAuthed;
  // private: only for people with share
  return hasShare;
}

/**
 * List / open a note inside an accessible wiki.
 * - private: vault edit/owner only (Share Read does not see private notes)
 * - authenticated: any signed-in viewer who passed the vault wiki gate
 * - unlisted: open by URL, not listed in sidebar (except edit/owner who see all listable)
 * - public: everyone who passed the vault wiki gate
 */
export function canListNoteOnWiki(
  noteVisibility: string,
  isAuthed: boolean,
  canEditVault: boolean
): boolean {
  if (canEditVault) return true;
  if (noteVisibility === 'public') return true;
  if (noteVisibility === 'authenticated' && isAuthed) return true;
  return false;
}

export function canOpenNoteOnWiki(
  noteVisibility: string,
  isAuthed: boolean,
  canEditVault: boolean
): { ok: boolean; robots: string; reason?: 'auth' | 'private' } {
  if (canEditVault) return { ok: true, robots: 'noindex,nofollow' };
  if (noteVisibility === 'public') return { ok: true, robots: 'index,follow' };
  if (noteVisibility === 'unlisted') return { ok: true, robots: 'noindex,nofollow' };
  if (noteVisibility === 'authenticated') {
    if (isAuthed) return { ok: true, robots: 'noindex,nofollow' };
    return { ok: false, robots: 'noindex,nofollow', reason: 'auth' };
  }
  return { ok: false, robots: 'noindex,nofollow', reason: 'private' };
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

/**
 * Vaults shown in the Synapse vault app / home list.
 * Share Read is wiki-only and excluded.
 */
export async function listAccessibleVaults(pmUserId: number): Promise<VaultAccess[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT v.*,
       CASE
         WHEN v.OwnerPmUserId = ? THEN 'owner'
         ELSE LOWER(COALESCE(m.Role, 'read'))
       END AS AccessRole
     FROM Vaults v
     LEFT JOIN VaultMembers m ON m.VaultId = v.Id AND m.PmUserId = ?
     WHERE v.OwnerPmUserId = ?
        OR (m.PmUserId IS NOT NULL AND LOWER(m.Role) = 'edit')
     ORDER BY v.Name ASC`,
    [pmUserId, pmUserId, pmUserId]
  );
  return rows.map((row) => ({
    ...row,
    AccessRole: String(row.AccessRole || 'read').toLowerCase() as VaultAccessRole,
  })) as VaultAccess[];
}
