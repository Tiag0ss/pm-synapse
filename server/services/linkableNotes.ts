/**
 * Viewer-scoped note indexes for `[[@vault-slug/…]]` resolution.
 */
import { pool, RowDataPacket } from '../config/database';
import {
  accessibleVault,
  canOpenNoteOnWiki,
  canOpenVaultWiki,
  effectiveVisibility,
  listAccessibleVaults,
} from './vaultAccess';
import type { LinkableVaultNotes } from './notePaths';

const ACTIVE_NOTE = 'DeletedAt IS NULL';

/** Editable vaults (vault app) with all active notes. */
export async function listLinkableVaultNotesForApp(
  pmUserId: number
): Promise<LinkableVaultNotes[]> {
  const vaults = await listAccessibleVaults(pmUserId);
  if (!vaults.length) return [];

  const out: LinkableVaultNotes[] = [];
  for (const v of vaults) {
    const vaultId = Number(v.Id);
    const [notes] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, Title, Path FROM Notes WHERE VaultId = ? AND ${ACTIVE_NOTE} ORDER BY Path ASC`,
      [vaultId]
    );
    out.push({
      vaultId,
      vaultSlug: String(v.slug || ''),
      vaultName: String(v.Name || ''),
      notes: notes.map((n) => ({
        id: Number(n.Id),
        title: String(n.Title),
        path: String(n.Path || ''),
      })),
    });
  }
  return out.filter((v) => v.vaultSlug);
}

/**
 * Wiki viewer: vaults the viewer may open on the wiki, with notes they may open.
 * Includes the current vault plus other share/public vaults when applicable.
 */
export async function listLinkableVaultNotesForWikiViewer(opts: {
  pmUserId: number | null;
  isAuthed: boolean;
}): Promise<LinkableVaultNotes[]> {
  const [vaultRows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Name, slug, DefaultVisibility, AllowPublicPages, OwnerPmUserId
     FROM Vaults
     WHERE AllowPublicPages = 1
     ORDER BY Name ASC`
  );

  const out: LinkableVaultNotes[] = [];
  for (const v of vaultRows) {
    const vaultId = Number(v.Id);
    let shareRole: Awaited<ReturnType<typeof accessibleVault>> | null = null;
    if (opts.pmUserId) {
      shareRole = await accessibleVault(vaultId, opts.pmUserId, 'read');
    }
    const hasShare = Boolean(shareRole);
    const canEditVault = Boolean(
      shareRole && (shareRole.AccessRole === 'owner' || shareRole.AccessRole === 'edit')
    );
    const wikiGate = canOpenVaultWiki(v.DefaultVisibility, opts.isAuthed, hasShare);
    if (!wikiGate.ok) continue;

    const [notes] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, Title, Path, Visibility FROM Notes WHERE VaultId = ? AND ${ACTIVE_NOTE}`,
      [vaultId]
    );
    const openNotes = notes
      .filter((n) => {
        const vis = effectiveVisibility(n.Visibility, v.DefaultVisibility);
        return canOpenNoteOnWiki(vis, opts.isAuthed, canEditVault).ok;
      })
      .map((n) => ({
        id: Number(n.Id),
        title: String(n.Title),
        path: String(n.Path || ''),
      }));

    out.push({
      vaultId,
      vaultSlug: String(v.slug || ''),
      vaultName: String(v.Name || ''),
      notes: openNotes,
    });
  }
  return out.filter((v) => v.vaultSlug);
}
