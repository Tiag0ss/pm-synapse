import { Router, Response } from 'express';
import { z } from 'zod';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { authenticateSession, AuthRequest } from '../middleware/auth';
import { slugify, extractWikiLinks } from '../services/markdown';
import { resolveNoteId } from '../services/notePaths';
import {
  createPmProject,
  fetchPmOrganizations,
  fetchPmProjectStatuses,
  normalizeOrganizationList,
  resolveTaskStatusId,
  updatePmTask,
  buildPmTaskOpenUrl,
  buildSynapseNoteUrl,
  PM_BASE_URL,
} from '../services/pmClient';
import {
  rebuildNoteGraph,
  rewriteWikiLinksOnRename,
  snapshotRevision,
} from '../services/notesGraph';
import {
  ensureCheckboxMarker,
  parseCheckboxes,
  setCheckboxCheckedByIndex,
  setCheckboxCheckedByMarker,
  titleToPath,
} from '../services/checkboxes';
import {
  syncNoteCheckboxesFromPm,
} from '../services/pmCheckboxSync';
import { readVaultMedia, saveVaultImage } from '../services/vaultMedia';
import { importVaultZip } from '../services/vaultZipImport';
import { exportVaultZip } from '../services/vaultZipExport';
import { frontmatterJsonString, parseFrontmatter } from '../services/frontmatter';
import {
  checkboxTextKey,
  pushMissingCheckboxTasks,
  pushNoteAsPmTask,
  pushSingleCheckboxTask,
} from '../services/pushCheckboxTasks';
import { normalizeNoteIcon } from '../services/noteIcons';
import {
  accessibleVault,
  listAccessibleVaults,
  normalizeMemberRole,
  NOTE_VISIBILITY_VALUES,
} from '../services/vaultAccess';
import logger from '../utils/logger';

const ACTIVE_NOTE = 'DeletedAt IS NULL';

const visibilityEnum = z.enum(NOTE_VISIBILITY_VALUES);

type CheckboxLinkRow = {
  NoteId: number;
  MarkerId: string;
  Text: string;
  PmTaskId: number | null;
  PmProjectId: number | null;
  Checked?: number | boolean | null;
};

/** Resolve a checkbox → NoteCheckboxTasks row (marker first, then text fallback). */
function resolveCheckboxLink(
  noteId: number,
  box: { markerId: string | null; text: string },
  byMarker: Map<string, CheckboxLinkRow>,
  byText: Map<string, CheckboxLinkRow>
): CheckboxLinkRow | null {
  if (box.markerId) {
    const byM = byMarker.get(`${noteId}:${box.markerId}`);
    if (byM) return byM;
  }
  return byText.get(checkboxTextKey(noteId, box.text)) || null;
}

const router = Router();
router.use(authenticateSession);

router.get('/pm/organizations', async (req: AuthRequest, res: Response) => {
  const result = await fetchPmOrganizations(req.user!.userId);
  if (!result.ok) {
    return res.status(result.status).json({
      success: false,
      message: result.data.message || 'Failed to load organizations',
      reauth: result.status === 401,
    });
  }
  const orgs = normalizeOrganizationList(result.data);
  if (orgs.length === 0) {
    logger.warn('PM organizations response parsed to empty list', {
      keys: result.data && typeof result.data === 'object' ? Object.keys(result.data as object) : [],
    });
  }
  res.json({ success: true, data: orgs });
});

function effectiveVisibility(noteVis: string | null, vaultDefault: string): string {
  return (noteVis || vaultDefault || 'private').toLowerCase();
}

async function ownedVault(vaultId: number, pmUserId: number) {
  return accessibleVault(vaultId, pmUserId, 'owner');
}

async function editableVault(vaultId: number, pmUserId: number) {
  return accessibleVault(vaultId, pmUserId, 'edit');
}

async function readableVault(vaultId: number, pmUserId: number) {
  // Vault editor APIs require edit/owner — Share Read is wiki-only
  return accessibleVault(vaultId, pmUserId, 'edit');
}

/** Upload image (paste / drop / file picker) — JSON body with base64. */
router.post('/:vaultId/media', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

  const schema = z.object({
    mimeType: z.string().min(3).max(128),
    dataBase64: z.string().min(1),
    fileName: z.string().max(512).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'mimeType and dataBase64 required' });
  }

  try {
    const saved = await saveVaultImage({
      vaultId: Number(vault.Id),
      pmUserId: req.user!.userId,
      mimeType: parsed.data.mimeType,
      dataBase64: parsed.data.dataBase64,
      fileName: parsed.data.fileName,
    });
    res.status(201).json({ success: true, data: saved });
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    if (status >= 500) logger.error('Media upload failed', { error });
    res.status(status).json({ success: false, message: err.message || 'Upload failed' });
  }
});

/** Serve uploaded media for the vault owner. */
router.get('/:vaultId/media/:mediaId', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Not found' });
  const media = await readVaultMedia(Number(vault.Id), Number(req.params.mediaId));
  if (!media) return res.status(404).json({ success: false, message: 'Not found' });
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (media.originalName) {
    res.setHeader('Content-Disposition', `inline; filename="${media.originalName.replace(/"/g, '')}"`);
  }
  res.send(media.buffer);
});

/** Import Markdown (+ images) from a ZIP, preserving folder structure. */
router.post('/:vaultId/import-zip', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

  const schema = z.object({
    dataBase64: z.string().min(1),
    overwrite: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'dataBase64 required' });
  }

  try {
    const data = await importVaultZip({
      vaultId: Number(vault.Id),
      pmUserId: req.user!.userId,
      zipBase64: parsed.data.dataBase64,
      overwrite: Boolean(parsed.data.overwrite),
    });
    res.json({ success: true, data });
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    if (status >= 500) logger.error('ZIP import failed', { error });
    res.status(status).json({ success: false, message: err.message || 'Import failed' });
  }
});

async function syncCheckboxRows(noteId: number, bodyMarkdown: string): Promise<void> {
  const boxes = parseCheckboxes(bodyMarkdown);
  const keepMarkers: string[] = [];
  for (const box of boxes) {
    if (!box.markerId) continue;
    keepMarkers.push(box.markerId);
    await pool.execute(
      `INSERT INTO NoteCheckboxTasks (NoteId, MarkerId, Text, Checked)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE Text = VALUES(Text), Checked = VALUES(Checked)`,
      [noteId, box.markerId, box.text.slice(0, 512), box.checked ? 1 : 0]
    );
  }
  if (keepMarkers.length) {
    const placeholders = keepMarkers.map(() => '?').join(',');
    await pool.execute(
      `DELETE FROM NoteCheckboxTasks
       WHERE NoteId = ? AND PmTaskId IS NULL AND MarkerId NOT IN (${placeholders})`,
      [noteId, ...keepMarkers]
    );
  }
}

router.get('/', async (req: AuthRequest, res: Response) => {
  const rows = await listAccessibleVaults(req.user!.userId);
  res.json({ success: true, data: rows });
});

/** Search Synapse users for vault sharing. */
router.get('/users/search', async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) {
    return res.json({ success: true, data: [] });
  }
  const like = `%${q}%`;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Username, Email, PmUserId FROM Users
     WHERE Id <> ?
       AND IsActive = 1
       AND (Username LIKE ? OR Email LIKE ? OR CAST(Id AS CHAR) = ? OR CAST(PmUserId AS CHAR) = ?)
     ORDER BY Username ASC
     LIMIT 20`,
    [req.user!.userId, like, like, q, q]
  );
  res.json({
    success: true,
    data: rows.map((r) => ({
      userId: Number(r.Id),
      pmUserId: Number(r.Id), // legacy alias for share UI
      username: String(r.Username),
      email: String(r.Email),
      linkedPmUserId: r.PmUserId != null ? Number(r.PmUserId) : null,
    })),
  });
});

router.get('/:vaultId/members', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
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
  res.json({
    success: true,
    data: {
      accessRole: vault.AccessRole,
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
        role: String(m.Role).toLowerCase() === 'edit' ? 'edit' : 'read',
        createdAt: m.CreatedAt,
      })),
    },
  });
});

router.post('/:vaultId/members', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const schema = z.object({
    userId: z.coerce.number().int().positive().optional(),
    pmUserId: z.coerce.number().int().positive().optional(), // Synapse user id (legacy) or PM id for stub
    role: z.enum(['read', 'edit']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'userId (or pmUserId) and role (read|edit) required' });
  }

  let targetUserId = parsed.data.userId ?? null;
  let pendingFirstLogin = false;

  if (targetUserId == null && parsed.data.pmUserId != null) {
    // Treat as Synapse user id first
    const [byId] = await pool.execute<RowDataPacket[]>(
      'SELECT Id FROM Users WHERE Id = ?',
      [parsed.data.pmUserId]
    );
    if (byId[0]) {
      targetUserId = Number(byId[0].Id);
    } else {
      // Invite by PM user id before first Synapse login — stub Users row
      const [byPm] = await pool.execute<RowDataPacket[]>(
        'SELECT Id FROM Users WHERE PmUserId = ?',
        [parsed.data.pmUserId]
      );
      if (byPm[0]) {
        targetUserId = Number(byPm[0].Id);
      } else {
        const [ins] = await pool.execute<ResultSetHeader>(
          `INSERT INTO Users (Username, Email, PasswordHash, PmUserId, IsAdmin, IsActive)
           VALUES (?, ?, NULL, ?, 0, 1)`,
          [`user#${parsed.data.pmUserId}`, `pending-pm-${parsed.data.pmUserId}@local`, parsed.data.pmUserId]
        );
        targetUserId = Number(ins.insertId);
        pendingFirstLogin = true;
      }
    }
  }

  if (targetUserId == null) {
    return res.status(400).json({ success: false, message: 'userId (or pmUserId) and role (read|edit) required' });
  }
  if (targetUserId === Number(vault.OwnerPmUserId)) {
    return res.status(400).json({ success: false, message: 'Owner already has full access' });
  }

  const [profiles] = await pool.execute<RowDataPacket[]>(
    'SELECT Id FROM Users WHERE Id = ?',
    [targetUserId]
  );
  if (!profiles.length) {
    return res.status(404).json({ success: false, message: 'User not found' });
  }

  await pool.execute(
    `INSERT INTO VaultMembers (VaultId, PmUserId, Role, InvitedByPmUserId)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE Role = VALUES(Role), InvitedByPmUserId = VALUES(InvitedByPmUserId)`,
    [vault.Id, targetUserId, parsed.data.role, req.user!.userId]
  );
  res.status(201).json({
    success: true,
    data: {
      userId: targetUserId,
      pmUserId: targetUserId,
      role: parsed.data.role,
      pendingFirstLogin,
    },
  });
});

router.patch('/:vaultId/members/:memberPmUserId', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const memberPmUserId = Number(req.params.memberPmUserId);
  const role = normalizeMemberRole(req.body?.role);
  if (!role) {
    return res.status(400).json({ success: false, message: 'role must be read or edit' });
  }
  const [result] = await pool.execute<ResultSetHeader>(
    'UPDATE VaultMembers SET Role = ? WHERE VaultId = ? AND PmUserId = ?',
    [role, vault.Id, memberPmUserId]
  );
  if (!result.affectedRows) {
    return res.status(404).json({ success: false, message: 'Member not found' });
  }
  res.json({ success: true, data: { pmUserId: memberPmUserId, role } });
});

router.delete('/:vaultId/members/:memberPmUserId', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const memberPmUserId = Number(req.params.memberPmUserId);
  const [result] = await pool.execute<ResultSetHeader>(
    'DELETE FROM VaultMembers WHERE VaultId = ? AND PmUserId = ?',
    [vault.Id, memberPmUserId]
  );
  if (!result.affectedRows) {
    return res.status(404).json({ success: false, message: 'Member not found' });
  }
  res.json({ success: true });
});

/** Member leaves a shared vault (not available to the owner). Share Read may leave too. */
router.post('/:vaultId/leave', async (req: AuthRequest, res: Response) => {
  const vault = await accessibleVault(Number(req.params.vaultId), req.user!.userId, 'read');
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  if (vault.AccessRole === 'owner') {
    return res.status(400).json({
      success: false,
      message: 'Owners cannot leave — delete the vault or transfer ownership first',
    });
  }
  const [result] = await pool.execute<ResultSetHeader>(
    'DELETE FROM VaultMembers WHERE VaultId = ? AND PmUserId = ?',
    [vault.Id, req.user!.userId]
  );
  if (!result.affectedRows) {
    return res.status(404).json({ success: false, message: 'Membership not found' });
  }
  res.json({ success: true, message: 'Left vault' });
});

router.post('/:vaultId/delete', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const confirm = String(req.body?.confirmName || '').trim();
  if (!confirm || confirm !== String(vault.Name)) {
    return res.status(400).json({
      success: false,
      message: 'Type the vault name exactly to confirm deletion',
    });
  }
  await pool.execute('DELETE FROM Vaults WHERE Id = ? AND OwnerPmUserId = ?', [
    vault.Id,
    req.user!.userId,
  ]);
  logger.info('Vault deleted', { vaultId: vault.Id, name: vault.Name, by: req.user!.userId });
  res.json({ success: true, message: 'Vault deleted' });
});

router.get('/:vaultId/export-zip', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  try {
    const result = await exportVaultZip(Number(vault.Id), String(vault.Name || `vault-${vault.Id}`));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
    res.setHeader('X-Synapse-Note-Count', String(result.noteCount));
    res.setHeader('X-Synapse-Image-Count', String(result.imageCount));
    res.send(result.buffer);
  } catch (error) {
    logger.error('Vault ZIP export failed', { error, vaultId: vault.Id });
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

router.patch('/:vaultId', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const schema = z.object({
    allowPublicPages: z.boolean().optional(),
    defaultVisibility: visibilityEnum.optional(),
    description: z.string().max(5000).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid payload' });
  }
  if (parsed.data.allowPublicPages !== undefined) {
    await pool.execute('UPDATE Vaults SET AllowPublicPages = ? WHERE Id = ?', [
      parsed.data.allowPublicPages ? 1 : 0,
      vault.Id,
    ]);
  }
  if (parsed.data.defaultVisibility) {
    await pool.execute('UPDATE Vaults SET DefaultVisibility = ? WHERE Id = ?', [
      parsed.data.defaultVisibility,
      vault.Id,
    ]);
  }
  if (parsed.data.description !== undefined) {
    await pool.execute('UPDATE Vaults SET Description = ? WHERE Id = ?', [
      parsed.data.description,
      vault.Id,
    ]);
  }
  res.json({ success: true });
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const schema = z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(5000).optional().nullable(),
    defaultVisibility: visibilityEnum.optional(),
    allowPublicPages: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid vault payload' });
  }
  const slug = slugify(parsed.data.name);
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO Vaults (OwnerPmUserId, Name, slug, Description, DefaultVisibility, AllowPublicPages)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.user!.userId,
        parsed.data.name,
        slug,
        parsed.data.description || null,
        parsed.data.defaultVisibility || 'private',
        parsed.data.allowPublicPages ? 1 : 0,
      ]
    );
    res.json({ success: true, data: { id: result.insertId, slug } });
  } catch (error) {
    logger.error('Create vault failed', { error });
    res.status(500).json({ success: false, message: 'Failed to create vault' });
  }
});

router.get('/:vaultId', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  res.json({ success: true, data: vault });
});

router.get('/:vaultId/notes', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const trash = String(req.query.trash || '') === '1';
  const q = String(req.query.q || '').trim();
  const deletedClause = trash ? 'DeletedAt IS NOT NULL' : ACTIVE_NOTE;
  let rows: RowDataPacket[];
  if (q) {
    const like = `%${q}%`;
    [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, VaultId, Path, Title, Visibility, UpdatedAt, PmTaskId, PmProjectId, DeletedAt, Icon
       FROM Notes
       WHERE VaultId = ? AND ${deletedClause}
         AND (Title LIKE ? OR Path LIKE ? OR BodyMarkdown LIKE ?)
       ORDER BY Path ASC
       LIMIT 500`,
      [vault.Id, like, like, like]
    );
  } else {
    [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id, VaultId, Path, Title, Visibility, UpdatedAt, PmTaskId, PmProjectId, DeletedAt, Icon
       FROM Notes WHERE VaultId = ? AND ${deletedClause} ORDER BY Path ASC`,
      [vault.Id]
    );
  }
  res.json({ success: true, data: rows });
});

/** Full-text-ish search with snippets for quick switcher. */
router.get('/:vaultId/search', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const q = String(req.query.q || '').trim();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  if (q.length < 1) {
    return res.json({ success: true, data: [] });
  }
  const like = `%${q}%`;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT n.Id, n.Path, n.Title, n.BodyMarkdown,
       CASE
         WHEN n.Title LIKE ? THEN 'title'
         WHEN n.Path LIKE ? THEN 'path'
         WHEN EXISTS (
           SELECT 1 FROM NoteTags t WHERE t.NoteId = n.Id AND t.Tag LIKE ?
         ) THEN 'tag'
         ELSE 'body'
       END AS MatchIn
     FROM Notes n
     WHERE n.VaultId = ? AND n.DeletedAt IS NULL
       AND (
         n.Title LIKE ? OR n.Path LIKE ? OR n.BodyMarkdown LIKE ?
         OR EXISTS (SELECT 1 FROM NoteTags t WHERE t.NoteId = n.Id AND t.Tag LIKE ?)
       )
     ORDER BY
       CASE
         WHEN n.Title LIKE ? THEN 0
         WHEN n.Path LIKE ? THEN 1
         WHEN EXISTS (SELECT 1 FROM NoteTags t WHERE t.NoteId = n.Id AND t.Tag LIKE ?) THEN 2
         ELSE 3
       END,
       n.Path ASC
     LIMIT ${limit}`,
    [like, like, like, vault.Id, like, like, like, like, like, like, like]
  );

  const qLower = q.toLowerCase();
  const data = rows.map((r) => {
    const body = String(r.BodyMarkdown || '');
    let snippet: string | undefined;
    if (String(r.MatchIn) === 'body') {
      const idx = body.toLowerCase().indexOf(qLower);
      if (idx >= 0) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(body.length, idx + q.length + 60);
        snippet = `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ')}${end < body.length ? '…' : ''}`;
      }
    }
    return {
      id: Number(r.Id),
      title: String(r.Title),
      path: String(r.Path),
      matchIn: String(r.MatchIn) as 'title' | 'path' | 'body' | 'tag',
      snippet,
    };
  });
  res.json({ success: true, data });
});

router.post('/:vaultId/notes', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

  const schema = z.object({
    path: z.string().min(1).max(1024).optional(),
    title: z.string().min(1).max(512),
    bodyMarkdown: z.string().default(''),
    visibility: visibilityEnum.optional().nullable(),
    aliases: z.array(z.string()).optional(),
    icon: z.union([z.string().max(64), z.null()]).optional(),
    /** When creating from a missing [[wikilink]], rebuild that note's outbound links. */
    linkFromNoteId: z.coerce.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid note payload' });
  }
  let path = parsed.data.path || titleToPath(parsed.data.title);
  if (!path.endsWith('.md')) path = `${path}.md`;
  const fmJson = frontmatterJsonString(parseFrontmatter(parsed.data.bodyMarkdown).data);
  const icon =
    parsed.data.icon === undefined ? null : normalizeNoteIcon(parsed.data.icon);

  const [pathHits] = await pool.execute<RowDataPacket[]>(
    `SELECT Id FROM Notes WHERE VaultId = ? AND Path = ? AND ${ACTIVE_NOTE} LIMIT 1`,
    [vault.Id, path]
  );
  if (pathHits.length) {
    const existingId = Number(pathHits[0].Id);
    if (parsed.data.linkFromNoteId) {
      const [src] = await pool.execute<RowDataPacket[]>(
        'SELECT Id FROM Notes WHERE Id = ? AND VaultId = ?',
        [parsed.data.linkFromNoteId, vault.Id]
      );
      if (src.length) {
        await rebuildNoteGraph(Number(parsed.data.linkFromNoteId), Number(vault.Id));
      }
    }
    return res.status(409).json({
      success: false,
      message: 'A note already exists at this path',
      data: { id: existingId, path, title: parsed.data.title },
    });
  }

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO Notes (VaultId, Path, Title, BodyMarkdown, Visibility, AliasesJson, FrontmatterJson, Icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        vault.Id,
        path,
        parsed.data.title,
        parsed.data.bodyMarkdown,
        parsed.data.visibility || null,
        JSON.stringify(parsed.data.aliases || []),
        fmJson,
        icon,
      ]
    );
    const noteId = result.insertId;
    await snapshotRevision(noteId, req.user!.userId, {
      title: parsed.data.title,
      path,
      bodyMarkdown: parsed.data.bodyMarkdown,
      frontmatterJson: fmJson,
      visibility: parsed.data.visibility || null,
    });
    await rebuildNoteGraph(noteId, Number(vault.Id));

    if (parsed.data.linkFromNoteId && parsed.data.linkFromNoteId !== noteId) {
      const [src] = await pool.execute<RowDataPacket[]>(
        'SELECT Id FROM Notes WHERE Id = ? AND VaultId = ?',
        [parsed.data.linkFromNoteId, vault.Id]
      );
      if (src.length) {
        await rebuildNoteGraph(Number(parsed.data.linkFromNoteId), Number(vault.Id));
      }
    }

    res.json({
      success: true,
      data: { id: noteId, path, title: parsed.data.title, icon },
    });
  } catch (error) {
    logger.error('Create note failed', { error, vaultId: vault.Id, path });
    res.status(500).json({ success: false, message: 'Failed to create note' });
  }
});

router.get('/:vaultId/notes/:noteId', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM Notes WHERE Id = ? AND VaultId = ? AND ${ACTIVE_NOTE}`,
    [req.params.noteId, vault.Id]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Note not found' });
  res.json({ success: true, data: rows[0] });
});

router.put('/:vaultId/notes/:noteId', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [existingRows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM Notes WHERE Id = ? AND VaultId = ? AND ${ACTIVE_NOTE}`,
    [req.params.noteId, vault.Id]
  );
  if (!existingRows.length) return res.status(404).json({ success: false, message: 'Note not found' });
  const existing = existingRows[0];

  const schema = z.object({
    path: z.string().min(1).max(1024).optional(),
    title: z.string().min(1).max(512).optional(),
    bodyMarkdown: z.string().optional(),
    visibility: visibilityEnum.optional().nullable(),
    aliases: z.array(z.string()).optional(),
    icon: z.union([z.string().max(64), z.null()]).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Invalid note payload' });
  }

  const title = parsed.data.title ?? String(existing.Title);
  // Path is auto-managed from title unless an explicit path is sent
  let path =
    parsed.data.path ??
    (parsed.data.title ? titleToPath(title) : String(existing.Path));
  if (!path.endsWith('.md')) path = `${path}.md`;
  const body = parsed.data.bodyMarkdown ?? String(existing.BodyMarkdown);
  const visibility =
    parsed.data.visibility !== undefined ? parsed.data.visibility : existing.Visibility;
  const aliasesJson = JSON.stringify(
    parsed.data.aliases ?? JSON.parse(String(existing.AliasesJson || '[]'))
  );
  const fmJson = frontmatterJsonString(parseFrontmatter(body).data);
  const icon =
    parsed.data.icon !== undefined
      ? normalizeNoteIcon(parsed.data.icon)
      : existing.Icon
        ? normalizeNoteIcon(existing.Icon)
        : null;

  await pool.execute(
    `UPDATE Notes SET Path = ?, Title = ?, BodyMarkdown = ?, Visibility = ?, AliasesJson = ?, FrontmatterJson = ?, Icon = ?
     WHERE Id = ?`,
    [path, title, body, visibility, aliasesJson, fmJson, icon, existing.Id]
  );

  await snapshotRevision(Number(existing.Id), req.user!.userId, {
    title,
    path,
    bodyMarkdown: body,
    frontmatterJson: fmJson,
    visibility: visibility ? String(visibility) : null,
  });

  if (title !== existing.Title || path !== existing.Path) {
    await rewriteWikiLinksOnRename(
      Number(vault.Id),
      String(existing.Title),
      title,
      String(existing.Path),
      path
    );
  }
  await rebuildNoteGraph(Number(existing.Id), Number(vault.Id));
  await syncCheckboxRows(Number(existing.Id), body);
  res.json({ success: true });
});

router.delete('/:vaultId/notes/:noteId', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const noteId = Number(req.params.noteId);
  const hard = String(req.query.hard || '') === '1';
  const [existingRows] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, DeletedAt FROM Notes WHERE Id = ? AND VaultId = ?',
    [noteId, vault.Id]
  );
  if (!existingRows.length) {
    return res.status(404).json({ success: false, message: 'Note not found' });
  }
  const existing = existingRows[0];
  if (hard || existing.DeletedAt) {
    await pool.execute('DELETE FROM Notes WHERE Id = ? AND VaultId = ?', [noteId, vault.Id]);
    logger.info('Note permanently deleted', { vaultId: vault.Id, noteId, title: existing.Title });
    return res.json({ success: true, message: 'Note permanently deleted' });
  }
  const trashPath = `__trash__/${noteId}/${String(existing.Path)}`.slice(0, 1024);
  await pool.execute(
    `UPDATE Notes SET DeletedAt = CURRENT_TIMESTAMP, Path = ? WHERE Id = ? AND VaultId = ?`,
    [trashPath, noteId, vault.Id]
  );
  await pool.execute('DELETE FROM NoteLinks WHERE FromNoteId = ? OR ToNoteId = ?', [noteId, noteId]);
  logger.info('Note moved to trash', { vaultId: vault.Id, noteId, title: existing.Title });
  res.json({ success: true, message: 'Note moved to trash' });
});

router.post('/:vaultId/notes/:noteId/restore', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const noteId = Number(req.params.noteId);
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Path, Title FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NOT NULL',
    [noteId, vault.Id]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Trash note not found' });
  const row = rows[0];
  let path = String(row.Path || '');
  const prefix = `__trash__/${noteId}/`;
  if (path.startsWith(prefix)) path = path.slice(prefix.length);
  if (!path.endsWith('.md')) path = `${path}.md`;

  const [clash] = await pool.execute<RowDataPacket[]>(
    `SELECT Id FROM Notes WHERE VaultId = ? AND Path = ? AND ${ACTIVE_NOTE} LIMIT 1`,
    [vault.Id, path]
  );
  if (clash.length) {
    return res.status(409).json({
      success: false,
      message: `Cannot restore — an active note already uses path ${path}`,
    });
  }

  await pool.execute(
    `UPDATE Notes SET DeletedAt = NULL, Path = ? WHERE Id = ? AND VaultId = ?`,
    [path, noteId, vault.Id]
  );
  await rebuildNoteGraph(noteId, Number(vault.Id));
  res.json({ success: true, data: { id: noteId, path, title: row.Title } });
});

router.post('/:vaultId/notes/:noteId/rebuild-graph', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const noteId = Number(req.params.noteId);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id FROM Notes WHERE Id = ? AND VaultId = ? AND ${ACTIVE_NOTE}`,
    [noteId, vault.Id]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Note not found' });
  await rebuildNoteGraph(noteId, Number(vault.Id));
  res.json({ success: true });
});

router.get('/:vaultId/notes/:noteId/revisions', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT r.Id, r.RevisionNumber, r.Title, r.Path, r.CreatedAt, r.CreatedByPmUserId
     FROM NoteRevisions r
     INNER JOIN Notes n ON n.Id = r.NoteId
     WHERE r.NoteId = ? AND n.VaultId = ?
     ORDER BY r.RevisionNumber DESC`,
    [req.params.noteId, vault.Id]
  );
  res.json({ success: true, data: rows });
});

router.get('/:vaultId/notes/:noteId/revisions/:rev', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT r.* FROM NoteRevisions r
     INNER JOIN Notes n ON n.Id = r.NoteId
     WHERE r.NoteId = ? AND n.VaultId = ? AND r.RevisionNumber = ?`,
    [req.params.noteId, vault.Id, req.params.rev]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Revision not found' });
  res.json({ success: true, data: rows[0] });
});

router.post('/:vaultId/notes/:noteId/revisions/:rev/restore', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT r.* FROM NoteRevisions r
     INNER JOIN Notes n ON n.Id = r.NoteId
     WHERE r.NoteId = ? AND n.VaultId = ? AND r.RevisionNumber = ?`,
    [req.params.noteId, vault.Id, req.params.rev]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Revision not found' });
  const rev = rows[0];
  await pool.execute(
    `UPDATE Notes SET Path = ?, Title = ?, BodyMarkdown = ?, Visibility = ?
     WHERE Id = ?`,
    [rev.Path, rev.Title, rev.BodyMarkdown, rev.Visibility, rev.NoteId]
  );
  await snapshotRevision(Number(rev.NoteId), req.user!.userId, {
    title: String(rev.Title),
    path: String(rev.Path),
    bodyMarkdown: String(rev.BodyMarkdown),
    frontmatterJson: rev.FrontmatterJson ? String(rev.FrontmatterJson) : null,
    visibility: rev.Visibility ? String(rev.Visibility) : null,
  });
  await rebuildNoteGraph(Number(rev.NoteId), Number(vault.Id));
  res.json({ success: true, message: `Restored revision #${rev.RevisionNumber}` });
});

function preferWikilinkRows(rows: RowDataPacket[]): RowDataPacket[] {
  const byId = new Map<number, RowDataPacket>();
  for (const row of rows) {
    const id = Number(row.Id);
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, row);
      continue;
    }
    if (String(row.Kind) === 'wikilink' && String(existing.Kind) !== 'wikilink') {
      byId.set(id, row);
    }
  }
  return [...byId.values()].sort((a, b) =>
    String(a.Title).localeCompare(String(b.Title), undefined, { sensitivity: 'base' })
  );
}

/** One edge per note pair — prefer wikilink over mention. */
function dedupeGraphEdges(rows: RowDataPacket[]): RowDataPacket[] {
  const map = new Map<string, RowDataPacket>();
  for (const row of rows) {
    const key = `${row.FromNoteId}->${row.ToNoteId}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    if (String(row.Kind) === 'wikilink' && String(existing.Kind) !== 'wikilink') {
      map.set(key, row);
    }
  }
  return [...map.values()];
}

router.get('/:vaultId/notes/:noteId/backlinks', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const noteId = Number(req.params.noteId);
  const [incoming] = await pool.execute<RowDataPacket[]>(
    `SELECT n.Id, n.Title, n.Path, l.Kind
     FROM NoteLinks l
     INNER JOIN Notes n ON n.Id = l.FromNoteId
     WHERE l.ToNoteId = ? AND n.VaultId = ? AND n.DeletedAt IS NULL
     ORDER BY n.Title ASC`,
    [noteId, vault.Id]
  );
  const [outgoing] = await pool.execute<RowDataPacket[]>(
    `SELECT n.Id, n.Title, n.Path, l.Kind
     FROM NoteLinks l
     INNER JOIN Notes n ON n.Id = l.ToNoteId
     WHERE l.FromNoteId = ? AND n.VaultId = ? AND n.DeletedAt IS NULL
     ORDER BY n.Title ASC`,
    [noteId, vault.Id]
  );
  res.json({
    success: true,
    data: {
      backlinks: preferWikilinkRows(incoming),
      references: preferWikilinkRows(outgoing),
    },
  });
});

router.get('/:vaultId/graph', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [nodes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL',
    [vault.Id]
  );
  const [edges] = await pool.execute<RowDataPacket[]>(
    `SELECT l.FromNoteId, l.ToNoteId, l.Kind
     FROM NoteLinks l
     INNER JOIN Notes n ON n.Id = l.FromNoteId
     WHERE n.VaultId = ?`,
    [vault.Id]
  );
  res.json({ success: true, data: { nodes, edges: dedupeGraphEdges(edges) } });
});

/** Unresolved [[wikilinks]] across the vault. */
router.get('/:vaultId/broken-links', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, BodyMarkdown FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL ORDER BY Path ASC',
    [vault.Id]
  );
  const resolveIndex = notes.map((n) => ({
    id: Number(n.Id),
    title: String(n.Title),
    path: String(n.Path || ''),
  }));

  type BrokenItem = {
    noteId: number;
    noteTitle: string;
    notePath: string;
    target: string;
    occurrence: number;
  };
  const items: BrokenItem[] = [];
  const uniqueTargets = new Set<string>();

  for (const note of notes) {
    const targets = extractWikiLinks(String(note.BodyMarkdown || ''));
    const counts = new Map<string, number>();
    for (const target of targets) {
      counts.set(target, (counts.get(target) || 0) + 1);
      if (resolveNoteId(target, resolveIndex) != null) continue;
      const occurrence = counts.get(target) || 1;
      // One row per unique target per note (first occurrence index)
      if (items.some((i) => i.noteId === Number(note.Id) && i.target === target)) continue;
      items.push({
        noteId: Number(note.Id),
        noteTitle: String(note.Title),
        notePath: String(note.Path || ''),
        target,
        occurrence,
      });
      uniqueTargets.add(target.toLowerCase());
    }
  }

  res.json({
    success: true,
    data: {
      total: items.length,
      uniqueTargets: uniqueTargets.size,
      items,
    },
  });
});

router.get('/:vaultId/tags', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT t.Tag, COUNT(*) AS Count
     FROM NoteTags t
     INNER JOIN Notes n ON n.Id = t.NoteId
     WHERE n.VaultId = ?
     GROUP BY t.Tag
     ORDER BY t.Tag ASC`,
    [vault.Id]
  );
  res.json({ success: true, data: rows });
});

router.post('/:vaultId/push-project', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  if (vault.PmProjectId) {
    return res.status(409).json({
      success: false,
      message: 'Vault already linked to a PM project',
      data: { pmProjectId: vault.PmProjectId, openUrl: `${PM_BASE_URL}/projects/${vault.PmProjectId}` },
    });
  }
  const schema = z.object({
    organizationId: z.coerce.number().int().positive(),
    projectName: z.string().min(1).max(255).optional(),
    description: z.string().max(5000).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'organizationId required' });
  }

  const statusesRes = await fetchPmProjectStatuses(req.user!.userId, parsed.data.organizationId);
  const statusList = (statusesRes.data as { statuses?: Array<{ Id: number; IsDefault?: number }> }).statuses
    || (statusesRes.data as { data?: Array<{ Id: number; IsDefault?: number }> }).data
    || (Array.isArray(statusesRes.data) ? (statusesRes.data as Array<{ Id: number; IsDefault?: number }>) : []);
  const defaultStatus = statusList.find((s) => Number(s.IsDefault) === 1) || statusList[0];
  if (!defaultStatus?.Id) {
    return res.status(400).json({ success: false, message: 'Could not resolve a PM project status for this organization' });
  }

  const result = await createPmProject(req.user!.userId, {
    organizationId: parsed.data.organizationId,
    projectName: parsed.data.projectName || String(vault.Name),
    description: parsed.data.description || vault.Description || undefined,
    status: Number(defaultStatus.Id),
  });
  if (!result.ok) {
    return res.status(result.status).json({
      success: false,
      message: result.data.message || 'Failed to create PM project',
    });
  }
  const projectId =
    result.data.projectId ||
    result.data.id ||
    (result.data as { data?: { Id?: number } }).data?.Id;
  if (!projectId) {
    return res.status(500).json({ success: false, message: 'PM did not return project id' });
  }
  await pool.execute(
    `UPDATE Vaults SET PmOrganizationId = ?, PmProjectId = ?, PmProjectLinkedAt = CURRENT_TIMESTAMP WHERE Id = ?`,
    [parsed.data.organizationId, projectId, vault.Id]
  );
  res.json({
    success: true,
    data: { pmProjectId: projectId, openUrl: `${PM_BASE_URL}/projects/${projectId}` },
  });
});

router.post('/:vaultId/link-project', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const schema = z.object({
    organizationId: z.coerce.number().int().positive(),
    projectId: z.coerce.number().int().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'organizationId and projectId required' });
  }
  await pool.execute(
    `UPDATE Vaults SET PmOrganizationId = ?, PmProjectId = ?, PmProjectLinkedAt = CURRENT_TIMESTAMP WHERE Id = ?`,
    [parsed.data.organizationId, parsed.data.projectId, vault.Id]
  );
  res.json({
    success: true,
    data: {
      pmProjectId: parsed.data.projectId,
      openUrl: `${PM_BASE_URL}/projects/${parsed.data.projectId}`,
    },
  });
});

/** All markdown checkboxes in the vault (for vault PM options).
 *  By default skips PM status sync (settings only needs link state). Pass ?sync=1 to pull. */
router.get('/:vaultId/checkboxes', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const syncFromPm =
    String(req.query.sync || '') === '1' || String(req.query.sync || '').toLowerCase() === 'true';

  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, BodyMarkdown FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL ORDER BY Title ASC',
    [vault.Id]
  );
  const [linkRows] = await pool.execute<RowDataPacket[]>(
    `SELECT c.NoteId, c.MarkerId, c.Text, c.PmTaskId, c.PmProjectId, c.Checked
     FROM NoteCheckboxTasks c
     INNER JOIN Notes n ON n.Id = c.NoteId
     WHERE n.VaultId = ?`,
    [vault.Id]
  );

  const links: CheckboxLinkRow[] = linkRows.map((l) => ({
    NoteId: Number(l.NoteId),
    MarkerId: String(l.MarkerId),
    Text: String(l.Text || ''),
    PmTaskId: l.PmTaskId != null ? Number(l.PmTaskId) : null,
    PmProjectId: l.PmProjectId != null ? Number(l.PmProjectId) : null,
    Checked: l.Checked,
  }));

  const bodyByNoteId = new Map<number, string>();
  let syncedCount = 0;

  if (syncFromPm) {
    const linksByNote = new Map<number, CheckboxLinkRow[]>();
    for (const l of links) {
      const list = linksByNote.get(l.NoteId) || [];
      list.push(l);
      linksByNote.set(l.NoteId, list);
    }
    let taskById: Map<number, import('../services/pmClient').PmTaskSummary> | undefined;
    for (const note of notes) {
      const noteId = Number(note.Id);
      const noteLinks = linksByNote.get(noteId) || [];
      if (!noteLinks.some((l) => l.PmTaskId)) {
        bodyByNoteId.set(noteId, String(note.BodyMarkdown || ''));
        continue;
      }
      const synced = await syncNoteCheckboxesFromPm({
        pmUserId: req.user!.userId,
        noteId,
        bodyMarkdown: String(note.BodyMarkdown || ''),
        links: noteLinks,
        defaultProjectId: vault.PmProjectId ? Number(vault.PmProjectId) : null,
        taskById,
      });
      taskById = synced.taskById;
      bodyByNoteId.set(noteId, synced.bodyMarkdown);
      syncedCount += synced.updated;
    }
  }

  const byMarker = new Map(links.map((l) => [`${l.NoteId}:${l.MarkerId}`, l] as const));
  const byText = new Map<string, CheckboxLinkRow>();
  for (const l of links) {
    if (!l.PmTaskId) continue;
    const key = checkboxTextKey(l.NoteId, l.Text);
    if (!byText.has(key)) byText.set(key, l);
  }

  const items = [];
  for (const note of notes) {
    const noteId = Number(note.Id);
    const body = bodyByNoteId.get(noteId) ?? String(note.BodyMarkdown || '');
    const boxes = parseCheckboxes(body);
    for (const box of boxes) {
      const link = resolveCheckboxLink(noteId, box, byMarker, byText);
      items.push({
        noteId,
        noteTitle: String(note.Title),
        index: box.index,
        text: box.text,
        checked: box.checked,
        markerId: box.markerId,
        indent: box.indent,
        pmTaskId: link?.PmTaskId ? Number(link.PmTaskId) : null,
        pmProjectId: link?.PmProjectId ? Number(link.PmProjectId) : null,
        openUrl: link?.PmTaskId
          ? buildPmTaskOpenUrl(
              Number(link.PmProjectId || vault.PmProjectId),
              Number(link.PmTaskId)
            )
          : null,
      });
    }
  }
  res.json({
    success: true,
    data: {
      vaultProjectId: vault.PmProjectId ? Number(vault.PmProjectId) : null,
      vaultOrganizationId: vault.PmOrganizationId ? Number(vault.PmOrganizationId) : null,
      syncedFromPm: syncedCount,
      items,
    },
  });
});

router.get('/:vaultId/notes/:noteId/checkboxes', async (req: AuthRequest, res: Response) => {
  const vault = await readableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Notes WHERE Id = ? AND VaultId = ?',
    [req.params.noteId, vault.Id]
  );
  if (!notes.length) return res.status(404).json({ success: false, message: 'Note not found' });
  const note = notes[0];
  const noteId = Number(note.Id);
  const [linkRows] = await pool.execute<RowDataPacket[]>(
    'SELECT MarkerId, Text, PmTaskId, PmProjectId, Checked FROM NoteCheckboxTasks WHERE NoteId = ?',
    [noteId]
  );
  const links: CheckboxLinkRow[] = linkRows.map((l) => ({
    NoteId: noteId,
    MarkerId: String(l.MarkerId),
    Text: String(l.Text || ''),
    PmTaskId: l.PmTaskId != null ? Number(l.PmTaskId) : null,
    PmProjectId: l.PmProjectId != null ? Number(l.PmProjectId) : null,
    Checked: l.Checked,
  }));
  const synced = await syncNoteCheckboxesFromPm({
    pmUserId: req.user!.userId,
    noteId,
    bodyMarkdown: String(note.BodyMarkdown || ''),
    links,
    defaultProjectId: vault.PmProjectId ? Number(vault.PmProjectId) : null,
  });
  const body = synced.bodyMarkdown;
  const boxes = parseCheckboxes(body);
  const byMarker = new Map(links.map((l) => [`${noteId}:${l.MarkerId}`, l] as const));
  const byText = new Map<string, CheckboxLinkRow>();
  for (const l of links) {
    if (!l.PmTaskId) continue;
    const key = checkboxTextKey(noteId, l.Text);
    if (!byText.has(key)) byText.set(key, l);
  }
  const notePmTaskId = note.PmTaskId != null ? Number(note.PmTaskId) : null;
  const projectId = vault.PmProjectId ? Number(vault.PmProjectId) : null;
  res.json({
    success: true,
    data: {
      bodyMarkdown: synced.updated > 0 ? body : undefined,
      syncedFromPm: synced.updated,
      notePmTaskId,
      noteOpenUrl:
        notePmTaskId && projectId ? buildPmTaskOpenUrl(projectId, notePmTaskId) : null,
      items: boxes.map((box) => {
        const link = resolveCheckboxLink(noteId, box, byMarker, byText);
        return {
          index: box.index,
          text: box.text,
          checked: box.checked,
          markerId: box.markerId,
          indent: box.indent,
          pmTaskId: link?.PmTaskId ? Number(link.PmTaskId) : null,
          pmProjectId: link?.PmProjectId ? Number(link.PmProjectId) : null,
          openUrl: link?.PmTaskId
            ? buildPmTaskOpenUrl(
                Number(link.PmProjectId || vault.PmProjectId),
                Number(link.PmTaskId)
              )
            : null,
        };
      }),
    },
  });
});

/** Create PM tasks for all checkboxes in the vault that are not yet linked.
 *  Pass ?stream=1 for NDJSON progress events (progress / done / error lines). */
router.post('/:vaultId/checkboxes/push-missing', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

  const projectId = Number(vault.PmProjectId);
  const orgId = Number(vault.PmOrganizationId);
  if (!projectId || !orgId) {
    return res.status(400).json({
      success: false,
      message: 'Link or create a PM project on this vault first',
    });
  }

  const stream =
    String(req.query.stream || '') === '1' ||
    String(req.query.stream || '').toLowerCase() === 'true' ||
    String(req.headers.accept || '').includes('application/x-ndjson');

  if (stream) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    const writeLine = (payload: unknown) => {
      res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const data = await pushMissingCheckboxTasks({
        vaultId: Number(vault.Id),
        pmUserId: req.user!.userId,
        projectId,
        organizationId: orgId,
        onProgress: (p) => {
          writeLine({ type: 'progress', ...p });
        },
      });
      writeLine({
        type: 'done',
        success: true,
        data: {
          ...data,
          openUrl: `${PM_BASE_URL}/projects/${projectId}?tab=tasks`,
        },
      });
      res.end();
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string };
      if ((err.status || 500) >= 500) logger.error('Bulk checkbox push failed', { error });
      writeLine({
        type: 'error',
        success: false,
        message: err.message || 'Bulk push failed',
      });
      res.end();
    }
    return;
  }

  try {
    const data = await pushMissingCheckboxTasks({
      vaultId: Number(vault.Id),
      pmUserId: req.user!.userId,
      projectId,
      organizationId: orgId,
    });
    res.json({
      success: true,
      data: {
        ...data,
        openUrl: `${PM_BASE_URL}/projects/${projectId}?tab=tasks`,
      },
    });
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    if (status >= 500) logger.error('Bulk checkbox push failed', { error });
    res.status(status).json({ success: false, message: err.message || 'Bulk push failed' });
  }
});

/** Create a PM task from a checkbox in the note (nested → Planner subtasks). */
router.post('/:vaultId/notes/:noteId/checkboxes/push', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

  const schema = z.object({
    index: z.coerce.number().int().min(0),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'index required' });
  }

  const projectId = Number(vault.PmProjectId);
  const orgId = Number(vault.PmOrganizationId);
  if (!projectId || !orgId) {
    return res.status(400).json({
      success: false,
      message: 'Link or create a PM project on this vault first',
    });
  }

  try {
    const data = await pushSingleCheckboxTask({
      vaultId: Number(vault.Id),
      noteId: Number(req.params.noteId),
      checkboxIndex: parsed.data.index,
      pmUserId: req.user!.userId,
      projectId,
      organizationId: orgId,
    });
    if (data.alreadyLinked) {
      return res.status(409).json({
        success: false,
        message: 'Checkbox already linked to a PM task',
        data,
      });
    }
    res.json({ success: true, data });
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    if (status >= 500) logger.error('Checkbox push failed', { error });
    res.status(status).json({ success: false, message: err.message || 'Failed to create PM task' });
  }
});

/** Create a PM task for the note itself (checkboxes can nest under it). */
router.post('/:vaultId/notes/:noteId/push-task', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

  const projectId = Number(vault.PmProjectId);
  const orgId = Number(vault.PmOrganizationId);
  if (!projectId || !orgId) {
    return res.status(400).json({
      success: false,
      message: 'Link or create a PM project on this vault first',
    });
  }

  const schema = z.object({
    /** Also create missing checkbox tasks as subtasks of the note task */
    withCheckboxes: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  const withCheckboxes = Boolean(parsed.success && parsed.data.withCheckboxes);

  try {
    const noteTask = await pushNoteAsPmTask({
      vaultId: Number(vault.Id),
      noteId: Number(req.params.noteId),
      pmUserId: req.user!.userId,
      projectId,
      organizationId: orgId,
    });

    let checkboxResult: Awaited<ReturnType<typeof pushMissingCheckboxTasks>> | null = null;
    if (withCheckboxes) {
      checkboxResult = await pushMissingCheckboxTasks({
        vaultId: Number(vault.Id),
        noteId: Number(req.params.noteId),
        pmUserId: req.user!.userId,
        projectId,
        organizationId: orgId,
      });
    }

    res.json({
      success: true,
      data: {
        ...noteTask,
        checkboxes: checkboxResult,
      },
    });
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    if (status >= 500) logger.error('Note task push failed', { error });
    res.status(status).json({ success: false, message: err.message || 'Failed to create note task' });
  }
});

/** Create missing PM tasks for checkboxes in a single note. */
router.post(
  '/:vaultId/notes/:noteId/checkboxes/push-missing',
  async (req: AuthRequest, res: Response) => {
    const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
    if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });

    const projectId = Number(vault.PmProjectId);
    const orgId = Number(vault.PmOrganizationId);
    if (!projectId || !orgId) {
      return res.status(400).json({
        success: false,
        message: 'Link or create a PM project on this vault first',
      });
    }

    try {
      const data = await pushMissingCheckboxTasks({
        vaultId: Number(vault.Id),
        noteId: Number(req.params.noteId),
        pmUserId: req.user!.userId,
        projectId,
        organizationId: orgId,
      });
      res.json({
        success: true,
        data: {
          ...data,
          openUrl: `${PM_BASE_URL}/projects/${projectId}?tab=tasks`,
        },
      });
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string };
      const status = err.status || 500;
      if (status >= 500) logger.error('Note checkbox bulk push failed', { error });
      res.status(status).json({ success: false, message: err.message || 'Bulk push failed' });
    }
  }
);

/** Toggle checkbox done state in the note (and sync linked PM task status). */
router.patch('/:vaultId/notes/:noteId/checkboxes', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Notes WHERE Id = ? AND VaultId = ?',
    [req.params.noteId, vault.Id]
  );
  if (!notes.length) return res.status(404).json({ success: false, message: 'Note not found' });
  const note = notes[0];

  const schema = z.object({
    index: z.coerce.number().int().min(0).optional(),
    markerId: z.string().min(1).max(64).optional(),
    checked: z.boolean(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || (parsed.data.markerId == null && parsed.data.index == null)) {
    return res.status(400).json({ success: false, message: 'markerId or index + checked required' });
  }

  let body = String(note.BodyMarkdown || '');
  let markerId = parsed.data.markerId || null;

  if (!markerId && parsed.data.index != null) {
    const ensured = ensureCheckboxMarker(body, parsed.data.index);
    if (!ensured) {
      return res.status(404).json({ success: false, message: 'Checkbox not found' });
    }
    body = ensured.markdown;
    markerId = ensured.markerId;
  }

  const next = markerId
    ? setCheckboxCheckedByMarker(body, markerId, parsed.data.checked)
    : setCheckboxCheckedByIndex(body, parsed.data.index!, parsed.data.checked);
  if (next == null) {
    return res.status(404).json({ success: false, message: 'Checkbox not found' });
  }
  body = next;

  const box = parseCheckboxes(body).find((b) =>
    markerId ? b.markerId === markerId : b.index === parsed.data.index
  );

  await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, note.Id]);
  await snapshotRevision(Number(note.Id), req.user!.userId, {
    title: String(note.Title),
    path: String(note.Path),
    bodyMarkdown: body,
    frontmatterJson: null,
    visibility: note.Visibility ? String(note.Visibility) : null,
  });

  if (markerId && box) {
    await pool.execute(
      `INSERT INTO NoteCheckboxTasks (NoteId, MarkerId, Text, Checked)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE Text = VALUES(Text), Checked = VALUES(Checked)`,
      [note.Id, markerId, box.text.slice(0, 512), parsed.data.checked ? 1 : 0]
    );

    const [linkRows] = await pool.execute<RowDataPacket[]>(
      'SELECT PmTaskId FROM NoteCheckboxTasks WHERE NoteId = ? AND MarkerId = ?',
      [note.Id, markerId]
    );
    const pmTaskId = linkRows[0]?.PmTaskId ? Number(linkRows[0].PmTaskId) : null;
    const orgId = Number(vault.PmOrganizationId);
    if (pmTaskId && orgId) {
      const statusId = await resolveTaskStatusId(req.user!.userId, orgId, parsed.data.checked);
      if (statusId) {
        const upd = await updatePmTask(req.user!.userId, pmTaskId, {
          status: statusId,
          synapseVaultId: Number(vault.Id),
          synapseNoteId: Number(note.Id),
          synapseMarkerId: markerId,
          synapseNoteUrl: buildSynapseNoteUrl(Number(vault.Id), Number(note.Id)),
        });
        if (!upd.ok) {
          logger.warn('Failed to sync PM task status from checkbox', {
            pmTaskId,
            message: upd.data.message,
          });
        }
      }
    }
  }

  res.json({
    success: true,
    data: { bodyMarkdown: body, markerId, checked: parsed.data.checked },
  });
});

router.post('/:vaultId/notes/:noteId/push-task', async (req: AuthRequest, res: Response) => {
  return res.status(410).json({
    success: false,
    message:
      'Pushing a whole note as one task is removed. Use checkbox tasks from vault settings or the note tasks panel.',
  });
});

router.post('/:vaultId/unlink-pm', async (req: AuthRequest, res: Response) => {
  const vault = await ownedVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  await pool.execute(
    `UPDATE Vaults SET PmOrganizationId = NULL, PmProjectId = NULL, PmProjectLinkedAt = NULL WHERE Id = ?`,
    [vault.Id]
  );
  res.json({ success: true });
});

router.post('/:vaultId/notes/:noteId/unlink-pm', async (req: AuthRequest, res: Response) => {
  const vault = await editableVault(Number(req.params.vaultId), req.user!.userId);
  if (!vault) return res.status(404).json({ success: false, message: 'Vault not found' });
  await pool.execute(
    `UPDATE Notes SET PmTaskId = NULL, PmProjectId = NULL, PmTaskLinkedAt = NULL
     WHERE Id = ? AND VaultId = ?`,
    [req.params.noteId, vault.Id]
  );
  res.json({ success: true });
});

export default router;
export { effectiveVisibility };
