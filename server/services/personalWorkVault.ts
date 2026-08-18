import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { parseFrontmatter, frontmatterJsonString } from './frontmatter';
import logger from '../utils/logger';

export const PERSONAL_WORK_VAULT_NAME = 'My work';
export const PERSONAL_WORK_VAULT_SLUG = 'my-work';
export const HUB_NOTE_PATH = 'planner/overview.md';
export const HUB_NOTE_TITLE = 'planner/overview';
export const HUB_SYNAPSE_KEY = 'planner-overview';

export const HUB_SEED_BODY = `---
synapse: planner-overview
---

# My work

<!--synapse:planner-tasks-->
<!--/synapse:planner-tasks-->

## Linked notes
`;

export function isPersonalWorkVault(vault: Record<string, unknown> | null | undefined): boolean {
  return Number(vault?.IsPersonalWork || 0) === 1;
}

export function isPlannerOverviewNote(path: string, bodyMarkdown?: string): boolean {
  if (String(path || '').replace(/\\/g, '/') === HUB_NOTE_PATH) return true;
  const fm = parseFrontmatter(String(bodyMarkdown || ''));
  return String(fm.data.synapse || '') === HUB_SYNAPSE_KEY;
}

function overviewNoteRow(note: Record<string, unknown> | null | undefined): boolean {
  return isPlannerOverviewNote(String(note?.Path || ''), String(note?.BodyMarkdown || ''));
}

export { overviewNoteRow };

export async function findPersonalWorkVaultId(ownerUserId: number): Promise<number | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT Id FROM Vaults WHERE OwnerPmUserId = ? AND IsPersonalWork = 1 LIMIT 1',
    [ownerUserId]
  );
  return rows[0]?.Id != null ? Number(rows[0].Id) : null;
}

export async function findHubNoteId(vaultId: number): Promise<number | null> {
  const [byPath] = await pool.execute<RowDataPacket[]>(
    `SELECT Id FROM Notes WHERE VaultId = ? AND Path = ? AND DeletedAt IS NULL LIMIT 1`,
    [vaultId, HUB_NOTE_PATH]
  );
  if (byPath[0]?.Id) return Number(byPath[0].Id);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, BodyMarkdown FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL`,
    [vaultId]
  );
  for (const row of rows) {
    if (isPlannerOverviewNote(String(row.Path || ''), String(row.BodyMarkdown || ''))) {
      return Number(row.Id);
    }
  }
  return null;
}

async function createHubNote(vaultId: number): Promise<number> {
  const fmJson = frontmatterJsonString(parseFrontmatter(HUB_SEED_BODY).data);
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO Notes (VaultId, Path, Title, BodyMarkdown, Visibility, AliasesJson, FrontmatterJson)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    [vaultId, HUB_NOTE_PATH, HUB_NOTE_TITLE, HUB_SEED_BODY, JSON.stringify([]), fmJson]
  );
  return Number(result.insertId);
}

export async function ensureHubNote(vaultId: number): Promise<number> {
  const existing = await findHubNoteId(vaultId);
  if (existing) return existing;
  try {
    return await createHubNote(vaultId);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'ER_DUP_ENTRY') {
      const again = await findHubNoteId(vaultId);
      if (again) return again;
    }
    throw error;
  }
}

async function insertPersonalWorkVault(ownerUserId: number, slug: string): Promise<number> {
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO Vaults (
       OwnerPmUserId, Name, slug, Description, DefaultVisibility, AllowPublicPages, IsPersonalWork
     ) VALUES (?, ?, ?, ?, 'private', 0, 1)`,
    [
      ownerUserId,
      PERSONAL_WORK_VAULT_NAME,
      slug,
      'Pull-only view of Planner tasks assigned to you. Refresh the overview note to update.',
    ]
  );
  return Number(result.insertId);
}

/** Create the per-user My work vault + hub note if missing. */
export async function ensurePersonalWorkVault(ownerUserId: number): Promise<{
  vaultId: number;
  hubNoteId: number;
}> {
  let vaultId = await findPersonalWorkVaultId(ownerUserId);
  if (!vaultId) {
    let slug = PERSONAL_WORK_VAULT_SLUG;
    const [slugHit] = await pool.execute<RowDataPacket[]>(
      'SELECT Id FROM Vaults WHERE OwnerPmUserId = ? AND slug = ? LIMIT 1',
      [ownerUserId, slug]
    );
    if (slugHit.length) slug = `${PERSONAL_WORK_VAULT_SLUG}-${ownerUserId}`;
    try {
      vaultId = await insertPersonalWorkVault(ownerUserId, slug);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'ER_DUP_ENTRY') {
        vaultId = await findPersonalWorkVaultId(ownerUserId);
      }
      if (!vaultId) {
        logger.error('Failed to create personal work vault', { error, ownerUserId });
        throw error;
      }
    }
  }
  const hubNoteId = await ensureHubNote(vaultId);
  return { vaultId, hubNoteId };
}
