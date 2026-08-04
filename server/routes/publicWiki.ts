import { Router, Response, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { markdownToSafeHtml } from '../services/markdown';
import { applySafeMediaHeaders, readVaultMedia } from '../services/vaultMedia';
import { pool, RowDataPacket } from '../config/database';
import { optionalAuthenticateSession, AuthRequest } from '../middleware/auth';
import {
  accessibleVault,
  canListNoteOnWiki,
  canListVaultInWikiDirectory,
  canOpenNoteOnWiki,
  canOpenVaultApp,
  canOpenVaultWiki,
  effectiveVisibility,
  hasWikiShare,
  type VaultAccessRole,
} from '../services/vaultAccess';
import { listLinkableVaultNotesForWikiViewer } from '../services/linkableNotes';
import { getSettingBool, SETTING_KEYS } from '../services/appSettings';
import { buildPmTaskOpenUrl } from '../services/pmClient';

const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLimiter);
router.use(optionalAuthenticateSession);

async function resolveShareRole(
  vaultId: number,
  userId: number | undefined
): Promise<VaultAccessRole | null> {
  if (!userId) return null;
  const access = await accessibleVault(vaultId, userId, 'read');
  return access ? access.AccessRole : null;
}

type WikiContext = {
  isAuthed: boolean;
  shareRole: VaultAccessRole | null;
  hasShare: boolean;
  canEditVault: boolean;
  wikiGate: ReturnType<typeof canOpenVaultWiki>;
};

async function wikiContextFor(
  vault: RowDataPacket,
  req: AuthRequest
): Promise<WikiContext> {
  const isAuthed = Boolean(req.user?.userId);
  const shareRole = await resolveShareRole(Number(vault.Id), req.user?.userId);
  const hasShare = hasWikiShare(shareRole);
  const canEditVault = Boolean(shareRole && canOpenVaultApp(shareRole));
  const wikiGate = canOpenVaultWiki(vault.DefaultVisibility, isAuthed, hasShare);
  return { isAuthed, shareRole, hasShare, canEditVault, wikiGate };
}

function denyWikiGate(res: Response, reason?: 'auth' | 'private' | 'forbidden') {
  if (reason === 'auth') {
    return res.status(401).json({
      success: false,
      message: 'Sign in required to view this wiki',
      requiresAuth: true,
    });
  }
  if (reason === 'forbidden') {
    return res.status(403).json({
      success: false,
      message: 'You do not have access to this private wiki',
    });
  }
  return res.status(404).json({ success: false, message: 'Public vault not found' });
}

/** Directory of wikis visible to the current viewer. */
router.get('/', async (req: AuthRequest, res: Response) => {
  if (!(await getSettingBool(SETTING_KEYS.allowPublicWikiDirectory, true))) {
    return res.json({ success: true, data: { wikis: [], authenticated: Boolean(req.user?.userId) } });
  }
  const isAuthed = Boolean(req.user?.userId);
  const userId = req.user?.userId;
  const [vaults] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Name, slug, Description, DefaultVisibility, OwnerPmUserId, UpdatedAt
     FROM Vaults
     WHERE AllowPublicPages = 1
     ORDER BY Name ASC`
  );

  const items: Array<{
    id: number;
    name: string;
    slug: string;
    description: string | null;
    defaultVisibility: string;
    noteCount: number;
    hasAccess: boolean;
    canOpenVault: boolean;
    visibilityHint: 'public' | 'authenticated' | 'private' | 'access';
  }> = [];

  for (const vault of vaults) {
    const vaultId = Number(vault.Id);
    const shareRole = await resolveShareRole(vaultId, userId);
    const hasShare = hasWikiShare(shareRole);
    const canEditVault = Boolean(shareRole && canOpenVaultApp(shareRole));
    const vaultVis = effectiveVisibility(null, vault.DefaultVisibility);

    if (!canListVaultInWikiDirectory(vault.DefaultVisibility, isAuthed, hasShare)) {
      continue;
    }
    if (!canOpenVaultWiki(vault.DefaultVisibility, isAuthed, hasShare).ok) {
      continue;
    }

    const [notes] = await pool.execute<RowDataPacket[]>(
      `SELECT Visibility FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL`,
      [vaultId]
    );
    const listable = notes.filter((n) =>
      canListNoteOnWiki(
        effectiveVisibility(n.Visibility, vault.DefaultVisibility),
        isAuthed,
        canEditVault
      )
    );
    // Private vaults with share but zero listable notes still appear (empty wiki)
    if (!listable.length && vaultVis !== 'private') continue;
    if (!listable.length && vaultVis === 'private' && !hasShare) continue;

    let visibilityHint: 'public' | 'authenticated' | 'private' | 'access' = 'public';
    if (hasShare && vaultVis === 'private') {
      visibilityHint = 'access';
    } else if (vaultVis === 'authenticated') {
      visibilityHint = 'authenticated';
    } else if (vaultVis === 'private') {
      visibilityHint = 'private';
    } else {
      visibilityHint = 'public';
    }

    items.push({
      id: vaultId,
      name: String(vault.Name),
      slug: String(vault.slug),
      description: vault.Description ? String(vault.Description) : null,
      defaultVisibility: vaultVis,
      noteCount: listable.length,
      hasAccess: hasShare,
      canOpenVault: canEditVault,
      visibilityHint,
    });
  }

  res.json({
    success: true,
    data: {
      wikis: items,
      authenticated: isAuthed,
    },
  });
});

/** Public media when vault allows public pages, viewer may open the wiki, and media is referenced by an openable note. */
router.get('/:slug/media/:mediaId', async (req: AuthRequest, res: Response) => {
  const [vaults] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Vaults WHERE slug = ? AND AllowPublicPages = 1',
    [req.params.slug]
  );
  if (!vaults.length) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  const vault = vaults[0];
  const ctx = await wikiContextFor(vault, req);
  if (!ctx.wikiGate.ok) {
    return denyWikiGate(res, ctx.wikiGate.reason);
  }
  const mediaId = Number(req.params.mediaId);
  if (!Number.isFinite(mediaId) || mediaId <= 0) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  const vaultId = Number(vault.Id);
  const needleA = `/api/vaults/${vaultId}/media/${mediaId}`;
  const needleB = `/api/public/${String(vault.slug)}/media/${mediaId}`;
  const [refs] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Visibility FROM Notes
     WHERE VaultId = ? AND DeletedAt IS NULL
       AND (BodyMarkdown LIKE ? OR BodyMarkdown LIKE ?)`,
    [vaultId, `%${needleA}%`, `%${needleB}%`]
  );
  let allowed = false;
  for (const n of refs) {
    const visibility = effectiveVisibility(n.Visibility, vault.DefaultVisibility);
    const open = canOpenNoteOnWiki(visibility, ctx.isAuthed, ctx.canEditVault);
    if (open.ok) {
      allowed = true;
      break;
    }
  }
  if (!allowed) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  const media = await readVaultMedia(vaultId, mediaId);
  if (!media) return res.status(404).json({ success: false, message: 'Not found' });
  if (
    !applySafeMediaHeaders(res, {
      mimeType: media.mimeType,
      originalName: media.originalName,
      cacheControl: 'public, max-age=86400',
    })
  ) {
    return res.status(415).json({ success: false, message: 'Unsupported media type' });
  }
  res.send(media.buffer);
});

router.get('/:slug', async (req: AuthRequest, res: Response) => {
  const [vaults] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Vaults WHERE slug = ? AND AllowPublicPages = 1',
    [req.params.slug]
  );
  if (!vaults.length) {
    return res.status(404).json({ success: false, message: 'Public vault not found' });
  }
  const vault = vaults[0];
  const ctx = await wikiContextFor(vault, req);
  if (!ctx.wikiGate.ok) {
    return denyWikiGate(res, ctx.wikiGate.reason);
  }

  const [allNotes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Path, Title, Visibility, UpdatedAt, Icon
     FROM Notes
     WHERE VaultId = ? AND DeletedAt IS NULL
     ORDER BY Path ASC`,
    [vault.Id]
  );
  const notes = allNotes.filter((n) =>
    canListNoteOnWiki(
      effectiveVisibility(n.Visibility, vault.DefaultVisibility),
      ctx.isAuthed,
      ctx.canEditVault
    )
  );
  const vaultVis = effectiveVisibility(null, vault.DefaultVisibility);
  res.json({
    success: true,
    data: {
      vault: {
        id: Number(vault.Id),
        name: vault.Name,
        slug: vault.slug,
        description: vault.Description,
        defaultVisibility: vaultVis,
      },
      notes,
      authenticated: ctx.isAuthed,
      user: ctx.isAuthed
        ? {
            userId: req.user!.userId,
            username: req.user!.username,
            email: req.user!.email,
          }
        : null,
      hasShare: ctx.hasShare,
      canOpenVault: ctx.canEditVault,
      robots: vaultVis === 'public' ? 'index,follow' : 'noindex,nofollow',
    },
  });
});

router.get('/:slug/notes/:noteId', async (req: AuthRequest, res: Response) => {
  const [vaults] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Vaults WHERE slug = ? AND AllowPublicPages = 1',
    [req.params.slug]
  );
  if (!vaults.length) {
    return res.status(404).json({ success: false, message: 'Public vault not found' });
  }
  const vault = vaults[0];
  const ctx = await wikiContextFor(vault, req);
  if (!ctx.wikiGate.ok) {
    return denyWikiGate(res, ctx.wikiGate.reason);
  }

  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL`,
    [req.params.noteId, vault.Id]
  );
  if (!notes.length) {
    return res.status(404).json({ success: false, message: 'Note not found' });
  }
  const note = notes[0];
  const visibility = effectiveVisibility(note.Visibility, vault.DefaultVisibility);
  const access = canOpenNoteOnWiki(visibility, ctx.isAuthed, ctx.canEditVault);
  if (!access.ok) {
    if (access.reason === 'auth') {
      return res.status(401).json({
        success: false,
        message: 'Sign in required to view this note',
        requiresAuth: true,
      });
    }
    return res.status(404).json({ success: false, message: 'Note not found' });
  }

  const [allNotes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, Visibility FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL',
    [vault.Id]
  );
  const noteIndex = allNotes
    .filter((n) => {
      const v = effectiveVisibility(n.Visibility, vault.DefaultVisibility);
      return canOpenNoteOnWiki(v, ctx.isAuthed, ctx.canEditVault).ok;
    })
    .map((n) => ({
      id: Number(n.Id),
      title: String(n.Title),
      path: String(n.Path || ''),
    }));

  const linkableVaults = await listLinkableVaultNotesForWikiViewer({
    pmUserId: req.user?.userId ?? null,
    isAuthed: ctx.isAuthed,
  });

  const html = markdownToSafeHtml(
    String(note.BodyMarkdown || ''),
    noteIndex,
    linkableVaults
  ).replace(
    new RegExp(`/api/vaults/${Number(vault.Id)}/media/(\\d+)`, 'g'),
    `/api/public/${String(vault.slug)}/media/$1`
  );

  let checkboxTasks: Array<{
    markerId: string | null;
    pmTaskId: number | null;
    openUrl: string | null;
  }> = [];
  if (ctx.isAuthed) {
    const noteId = Number(note.Id);
    const [linkRows] = await pool.execute<RowDataPacket[]>(
      `SELECT MarkerId, PmTaskId, PmProjectId FROM NoteCheckboxTasks
       WHERE NoteId = ? AND PmTaskId IS NOT NULL`,
      [noteId]
    );
    checkboxTasks = linkRows.map((l) => {
      const pmTaskId = l.PmTaskId != null ? Number(l.PmTaskId) : null;
      const projectId = Number(l.PmProjectId || vault.PmProjectId || 0);
      return {
        markerId: l.MarkerId ? String(l.MarkerId) : null,
        pmTaskId,
        openUrl:
          pmTaskId && projectId
            ? buildPmTaskOpenUrl(projectId, pmTaskId)
            : null,
      };
    });
  }

  const [incoming] = await pool.execute<RowDataPacket[]>(
    `SELECT n.Id, n.Title, n.Path, l.Kind
     FROM NoteLinks l
     INNER JOIN Notes n ON n.Id = l.FromNoteId
     WHERE l.ToNoteId = ? AND n.VaultId = ? AND n.DeletedAt IS NULL`,
    [note.Id, vault.Id]
  );
  const [outgoing] = await pool.execute<RowDataPacket[]>(
    `SELECT n.Id, n.Title, n.Path, l.Kind
     FROM NoteLinks l
     INNER JOIN Notes n ON n.Id = l.ToNoteId
     WHERE l.FromNoteId = ? AND n.VaultId = ? AND n.DeletedAt IS NULL`,
    [note.Id, vault.Id]
  );

  const visibleIds = new Set(noteIndex.map((n) => n.id));
  const prefer = (rows: RowDataPacket[]) => {
    const byId = new Map<number, RowDataPacket>();
    for (const row of rows) {
      const id = Number(row.Id);
      if (!visibleIds.has(id)) continue;
      const existing = byId.get(id);
      if (!existing || (String(row.Kind) === 'wikilink' && String(existing.Kind) !== 'wikilink')) {
        byId.set(id, row);
      }
    }
    return [...byId.values()].map((r) => ({
      Id: Number(r.Id),
      Title: String(r.Title),
      Path: String(r.Path || ''),
      Kind: String(r.Kind),
    }));
  };

  res.json({
    success: true,
    data: {
      id: Number(note.Id),
      title: note.Title,
      path: note.Path,
      html,
      robots: access.robots,
      visibility,
      backlinks: prefer(incoming),
      references: prefer(outgoing),
      checkboxTasks: ctx.isAuthed ? checkboxTasks : [],
    },
  });
});

router.get('/:slug/search', async (req: AuthRequest, res: Response) => {
  const [vaults] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Vaults WHERE slug = ? AND AllowPublicPages = 1',
    [req.params.slug]
  );
  if (!vaults.length) {
    return res.status(404).json({ success: false, message: 'Public vault not found' });
  }
  const vault = vaults[0];
  const ctx = await wikiContextFor(vault, req);
  if (!ctx.wikiGate.ok) {
    return denyWikiGate(res, ctx.wikiGate.reason);
  }

  const q = String(req.query.q || '').trim();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  if (q.length < 1) {
    return res.json({ success: true, data: [] });
  }
  const like = `%${q}%`;
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT n.Id, n.Path, n.Title, n.BodyMarkdown, n.Visibility,
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
     LIMIT 200`,
    [like, like, like, vault.Id, like, like, like, like, like, like, like]
  );

  const qLower = q.toLowerCase();
  const data = rows
    .filter((r) =>
      canListNoteOnWiki(
        effectiveVisibility(r.Visibility, vault.DefaultVisibility),
        ctx.isAuthed,
        ctx.canEditVault
      )
    )
    .slice(0, limit)
    .map((r) => {
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

router.get('/:slug/graph', async (req: AuthRequest, res: Response) => {
  const [vaults] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Vaults WHERE slug = ? AND AllowPublicPages = 1',
    [req.params.slug]
  );
  if (!vaults.length) {
    return res.status(404).json({ success: false, message: 'Public vault not found' });
  }
  const vault = vaults[0];
  const ctx = await wikiContextFor(vault, req);
  if (!ctx.wikiGate.ok) {
    return denyWikiGate(res, ctx.wikiGate.reason);
  }

  const [nodes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Title, Path, Visibility FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL`,
    [vault.Id]
  );
  const visible = nodes.filter((n) =>
    canListNoteOnWiki(
      effectiveVisibility(n.Visibility, vault.DefaultVisibility),
      ctx.isAuthed,
      ctx.canEditVault
    )
  );
  const ids = new Set(visible.map((n) => Number(n.Id)));
  const [edges] = await pool.execute<RowDataPacket[]>(
    `SELECT l.FromNoteId, l.ToNoteId, l.Kind
     FROM NoteLinks l
     INNER JOIN Notes n ON n.Id = l.FromNoteId
     WHERE n.VaultId = ?`,
    [vault.Id]
  );
  res.json({
    success: true,
    data: {
      nodes: visible.map(({ Id, Title, Path }) => ({ Id, Title, Path })),
      edges: (() => {
        const map = new Map<string, RowDataPacket>();
        for (const e of edges) {
          if (!ids.has(Number(e.FromNoteId)) || !ids.has(Number(e.ToNoteId))) continue;
          const key = `${e.FromNoteId}->${e.ToNoteId}`;
          const existing = map.get(key);
          if (!existing || (String(e.Kind) === 'wikilink' && String(existing.Kind) !== 'wikilink')) {
            map.set(key, e);
          }
        }
        return [...map.values()];
      })(),
      robots: 'noindex,nofollow',
    },
  });
});

export default router;
