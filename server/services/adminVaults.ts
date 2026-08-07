/**
 * Admin vault listing / ownership / share helpers.
 * Used only from admin settings routes (requireAdmin).
 */
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { normalizeMemberRole } from './vaultAccess';
import logger from '../utils/logger';

export type AdminVaultRow = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  defaultVisibility: string;
  allowPublicPages: boolean;
  noteCount: number;
  memberCount: number;
  owner: {
    userId: number;
    username: string;
    email: string;
  } | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export async function listAllVaultsForAdmin(): Promise<AdminVaultRow[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT v.Id, v.Name, v.slug, v.Description, v.DefaultVisibility, v.AllowPublicPages,
            v.OwnerPmUserId, v.CreatedAt, v.UpdatedAt,
            u.Username AS OwnerUsername, u.Email AS OwnerEmail,
            (SELECT COUNT(*) FROM Notes n WHERE n.VaultId = v.Id AND n.DeletedAt IS NULL) AS NoteCount,
            (SELECT COUNT(*) FROM VaultMembers m WHERE m.VaultId = v.Id) AS MemberCount
     FROM Vaults v
     LEFT JOIN Users u ON u.Id = v.OwnerPmUserId
     ORDER BY v.Name ASC, v.Id ASC`
  );

  return rows.map((r) => {
    const ownerId = Number(r.OwnerPmUserId);
    return {
      id: Number(r.Id),
      name: String(r.Name),
      slug: String(r.slug),
      description: r.Description != null ? String(r.Description) : null,
      defaultVisibility: String(r.DefaultVisibility || 'private'),
      allowPublicPages: Number(r.AllowPublicPages) === 1,
      noteCount: Number(r.NoteCount || 0),
      memberCount: Number(r.MemberCount || 0),
      owner:
        r.OwnerUsername != null
          ? {
              userId: ownerId,
              username: String(r.OwnerUsername),
              email: String(r.OwnerEmail || ''),
            }
          : ownerId
            ? {
                userId: ownerId,
                username: `user#${ownerId}`,
                email: '',
              }
            : null,
      updatedAt: r.UpdatedAt != null ? String(r.UpdatedAt) : null,
      createdAt: r.CreatedAt != null ? String(r.CreatedAt) : null,
    };
  });
}

export async function loadVaultRow(vaultId: number): Promise<RowDataPacket | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Name, slug, Description, DefaultVisibility, AllowPublicPages, OwnerPmUserId FROM Vaults WHERE Id = ?',
    [vaultId]
  );
  return rows[0] || null;
}

export async function getVaultMembersForAdmin(vaultId: number) {
  const vault = await loadVaultRow(vaultId);
  if (!vault) return null;

  const [ownerRows] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Username, Email FROM Users WHERE Id = ?',
    [vault.OwnerPmUserId]
  );
  const [members] = await pool.execute<RowDataPacket[]>(
    `SELECT m.PmUserId, m.Role, m.CreatedAt, u.Username, u.Email
     FROM VaultMembers m
     LEFT JOIN Users u ON u.Id = m.PmUserId
     WHERE m.VaultId = ?
     ORDER BY u.Username ASC, m.PmUserId ASC`,
    [vault.Id]
  );

  return {
    vault: {
      id: Number(vault.Id),
      name: String(vault.Name),
      slug: String(vault.slug),
    },
    accessRole: 'owner' as const,
    owner: ownerRows[0]
      ? {
          userId: Number(ownerRows[0].Id),
          pmUserId: Number(ownerRows[0].Id),
          username: String(ownerRows[0].Username),
          email: String(ownerRows[0].Email),
          role: 'owner' as const,
        }
      : {
          userId: Number(vault.OwnerPmUserId),
          pmUserId: Number(vault.OwnerPmUserId),
          username: `user#${vault.OwnerPmUserId}`,
          email: '',
          role: 'owner' as const,
        },
    members: members.map((m) => ({
      userId: Number(m.PmUserId),
      pmUserId: Number(m.PmUserId),
      username: m.Username ? String(m.Username) : `user#${m.PmUserId}`,
      email: m.Email ? String(m.Email) : '',
      role: String(m.Role).toLowerCase() === 'edit' ? ('edit' as const) : ('read' as const),
      createdAt: m.CreatedAt,
    })),
  };
}

export async function transferVaultOwnership(params: {
  vaultId: number;
  newOwnerUserId: number;
  invitedByUserId: number;
  /** When true (default), previous owner keeps Edit share */
  keepPreviousOwnerAsEdit?: boolean;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const vault = await loadVaultRow(params.vaultId);
  if (!vault) return { ok: false, status: 404, message: 'Vault not found' };

  const oldOwnerId = Number(vault.OwnerPmUserId);
  const newOwnerId = params.newOwnerUserId;
  if (newOwnerId === oldOwnerId) {
    return { ok: false, status: 400, message: 'User is already the owner' };
  }

  const [users] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, IsActive FROM Users WHERE Id = ?',
    [newOwnerId]
  );
  if (!users.length) return { ok: false, status: 404, message: 'New owner user not found' };
  if (Number(users[0].IsActive) !== 1) {
    return { ok: false, status: 400, message: 'New owner account is inactive' };
  }

  const slug = String(vault.slug);
  const [slugClash] = await pool.execute<RowDataPacket[]>(
    'SELECT Id FROM Vaults WHERE OwnerPmUserId = ? AND slug = ? AND Id <> ? LIMIT 1',
    [newOwnerId, slug, params.vaultId]
  );
  if (slugClash.length) {
    return {
      ok: false,
      status: 409,
      message: `New owner already has a vault with slug "${slug}" — rename one first`,
    };
  }

  try {
    // Drop membership for new owner (owner is not a member row)
    await pool.execute('DELETE FROM VaultMembers WHERE VaultId = ? AND PmUserId = ?', [
      params.vaultId,
      newOwnerId,
    ]);
    await pool.execute('UPDATE Vaults SET OwnerPmUserId = ? WHERE Id = ?', [
      newOwnerId,
      params.vaultId,
    ]);

    const keepPrev = params.keepPreviousOwnerAsEdit !== false;
    if (keepPrev && oldOwnerId > 0) {
      await pool.execute(
        `INSERT INTO VaultMembers (VaultId, PmUserId, Role, InvitedByPmUserId)
         VALUES (?, ?, 'edit', ?)
         ON DUPLICATE KEY UPDATE Role = 'edit', InvitedByPmUserId = VALUES(InvitedByPmUserId)`,
        [params.vaultId, oldOwnerId, params.invitedByUserId]
      );
    }

    logger.info('Admin transferred vault ownership', {
      vaultId: params.vaultId,
      from: oldOwnerId,
      to: newOwnerId,
      by: params.invitedByUserId,
    });
    return { ok: true };
  } catch (error) {
    logger.error('transferVaultOwnership failed', { error, vaultId: params.vaultId });
    return { ok: false, status: 500, message: 'Failed to transfer ownership' };
  }
}

export async function adminAddVaultMember(params: {
  vaultId: number;
  targetUserId: number;
  role: 'read' | 'edit';
  invitedByUserId: number;
}): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const vault = await loadVaultRow(params.vaultId);
  if (!vault) return { ok: false, status: 404, message: 'Vault not found' };
  if (params.targetUserId === Number(vault.OwnerPmUserId)) {
    return { ok: false, status: 400, message: 'Owner already has full access' };
  }
  const [users] = await pool.execute<RowDataPacket[]>(
    'SELECT Id FROM Users WHERE Id = ? AND IsActive = 1',
    [params.targetUserId]
  );
  if (!users.length) return { ok: false, status: 404, message: 'User not found' };

  await pool.execute(
    `INSERT INTO VaultMembers (VaultId, PmUserId, Role, InvitedByPmUserId)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE Role = VALUES(Role), InvitedByPmUserId = VALUES(InvitedByPmUserId)`,
    [params.vaultId, params.targetUserId, params.role, params.invitedByUserId]
  );
  return { ok: true };
}

export async function adminUpdateVaultMemberRole(
  vaultId: number,
  memberUserId: number,
  roleRaw: unknown
): Promise<{ ok: true; role: 'read' | 'edit' } | { ok: false; status: number; message: string }> {
  const role = normalizeMemberRole(roleRaw);
  if (!role) return { ok: false, status: 400, message: 'role must be read or edit' };
  const vault = await loadVaultRow(vaultId);
  if (!vault) return { ok: false, status: 404, message: 'Vault not found' };
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE VaultMembers SET Role = ? WHERE VaultId = ? AND PmUserId = ?',
    [role, vaultId, memberUserId]
  );
  if (!result.affectedRows) return { ok: false, status: 404, message: 'Member not found' };
  return { ok: true, role };
}

export async function adminRemoveVaultMember(
  vaultId: number,
  memberUserId: number
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const vault = await loadVaultRow(vaultId);
  if (!vault) return { ok: false, status: 404, message: 'Vault not found' };
  const [result] = await pool.execute<ResultSetHeader>(
    'DELETE FROM VaultMembers WHERE VaultId = ? AND PmUserId = ?',
    [vaultId, memberUserId]
  );
  if (!result.affectedRows) return { ok: false, status: 404, message: 'Member not found' };
  return { ok: true };
}
