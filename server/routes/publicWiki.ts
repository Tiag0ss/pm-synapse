import { Router, Response, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { markdownToSafeHtml } from '../services/markdown';
import { readVaultMedia } from '../services/vaultMedia';
import { pool, RowDataPacket } from '../config/database';
import { optionalAuthenticateSession, AuthRequest } from '../middleware/auth';
import { accessibleVault } from '../services/vaultAccess';

const router = Router();

const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(publicLimiter);
router.use(optionalAuthenticateSession);

function effectiveVis(noteVis: unknown, vaultDefault: unknown): string {
  return String(noteVis || vaultDefault || 'private').toLowerCase();
}

/**
 * List in wiki index / sidebar / search:
 * - vault members/owners see all notes
 * - public → everyone
 * - authenticated → signed-in users
 * - unlisted / private → not listed (open by URL only for unlisted)
 */
function canListNote(visibility: string, isAuthed: boolean, hasVaultAccess: boolean): boolean {
  if (hasVaultAccess) return true;
  if (visibility === 'public') return true;
  if (visibility === 'authenticated' && isAuthed) return true;
  return false;
}

/**
 * Open a note on the public wiki:
 * - vault access → always
 * - public / unlisted / authenticated (if signed in)
 */
function canOpenNote(
  visibility: string,
  isAuthed: boolean,
  hasVaultAccess: boolean
): { ok: boolean; robots: string; reason?: 'auth' | 'private' } {
  if (hasVaultAccess) return { ok: true, robots: 'noindex,nofollow' };
  if (visibility === 'public') return { ok: true, robots: 'index,follow' };
  if (visibility === 'unlisted') return { ok: true, robots: 'noindex,nofollow' };
  if (visibility === 'authenticated') {
    if (isAuthed) return { ok: true, robots: 'noindex,nofollow' };
    return { ok: false, robots: 'noindex,nofollow', reason: 'auth' };
  }
  return { ok: false, robots: 'noindex,nofollow', reason: 'private' };
}

async function vaultAccessFor(
  vaultId: number,
  pmUserId: number | undefined
): Promise<boolean> {
  if (!pmUserId) return false;
  const access = await accessibleVault(vaultId, pmUserId, 'read');
  return Boolean(access);
}

/** Directory of public wikis visible to the current viewer. */
router.get('/', async (req: AuthRequest, res: Response) => {
  const isAuthed = Boolean(req.user?.pmUserId);
  const pmUserId = req.user?.pmUserId;
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
    visibilityHint: 'public' | 'authenticated' | 'access';
  }> = [];

  for (const vault of vaults) {
    const vaultId = Number(vault.Id);
    const hasAccess = await vaultAccessFor(vaultId, pmUserId);
    const [notes] = await pool.execute<RowDataPacket[]>(
      `SELECT Visibility FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL`,
      [vaultId]
    );
    const listable = notes.filter((n) =>
      canListNote(effectiveVis(n.Visibility, vault.DefaultVisibility), isAuthed, hasAccess)
    );
    if (!listable.length) continue;

    let visibilityHint: 'public' | 'authenticated' | 'access' = 'public';
    if (hasAccess) {
      visibilityHint = 'access';
    } else if (
      listable.every(
        (n) => effectiveVis(n.Visibility, vault.DefaultVisibility) === 'authenticated'
      )
    ) {
      visibilityHint = 'authenticated';
    } else if (
      listable.some((n) => effectiveVis(n.Visibility, vault.DefaultVisibility) === 'public')
    ) {
      visibilityHint = 'public';
    } else {
      visibilityHint = 'authenticated';
    }

    items.push({
      id: vaultId,
      name: String(vault.Name),
      slug: String(vault.slug),
      description: vault.Description ? String(vault.Description) : null,
      defaultVisibility: String(vault.DefaultVisibility || 'private').toLowerCase(),
      noteCount: listable.length,
      hasAccess,
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

/** Public media when vault allows public pages. */
router.get('/:slug/media/:mediaId', async (req: Request, res: Response) => {
  const [vaults] = await pool.execute<RowDataPacket[]>(
    'SELECT Id FROM Vaults WHERE slug = ? AND AllowPublicPages = 1',
    [req.params.slug]
  );
  if (!vaults.length) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  const media = await readVaultMedia(Number(vaults[0].Id), Number(req.params.mediaId));
  if (!media) return res.status(404).json({ success: false, message: 'Not found' });
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Cache-Control', 'public, max-age=86400');
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
  const isAuthed = Boolean(req.user?.pmUserId);
  const hasVaultAccess = await vaultAccessFor(Number(vault.Id), req.user?.pmUserId);
  const [allNotes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Path, Title, Visibility, UpdatedAt
     FROM Notes
     WHERE VaultId = ? AND DeletedAt IS NULL
     ORDER BY Path ASC`,
    [vault.Id]
  );
  const notes = allNotes.filter((n) =>
    canListNote(effectiveVis(n.Visibility, vault.DefaultVisibility), isAuthed, hasVaultAccess)
  );
  res.json({
    success: true,
    data: {
      vault: {
        id: Number(vault.Id),
        name: vault.Name,
        slug: vault.slug,
        description: vault.Description,
      },
      notes,
      authenticated: isAuthed,
      canOpenVault: hasVaultAccess,
      robots: 'index,follow',
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
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL`,
    [req.params.noteId, vault.Id]
  );
  if (!notes.length) {
    return res.status(404).json({ success: false, message: 'Note not found' });
  }
  const note = notes[0];
  const visibility = effectiveVis(note.Visibility, vault.DefaultVisibility);
  const isAuthed = Boolean(req.user?.pmUserId);
  const hasVaultAccess = await vaultAccessFor(Number(vault.Id), req.user?.pmUserId);
  const access = canOpenNote(visibility, isAuthed, hasVaultAccess);
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
      const v = effectiveVis(n.Visibility, vault.DefaultVisibility);
      return canOpenNote(v, isAuthed, hasVaultAccess).ok;
    })
    .map((n) => ({
      id: Number(n.Id),
      title: String(n.Title),
      path: String(n.Path || ''),
    }));

  const html = markdownToSafeHtml(String(note.BodyMarkdown || ''), noteIndex).replace(
    new RegExp(`/api/vaults/${Number(vault.Id)}/media/(\\d+)`, 'g'),
    `/api/public/${String(vault.slug)}/media/$1`
  );

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
  const isAuthed = Boolean(req.user?.pmUserId);
  const hasVaultAccess = await vaultAccessFor(Number(vault.Id), req.user?.pmUserId);
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
      canListNote(effectiveVis(r.Visibility, vault.DefaultVisibility), isAuthed, hasVaultAccess)
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
  const isAuthed = Boolean(req.user?.pmUserId);
  const hasVaultAccess = await vaultAccessFor(Number(vault.Id), req.user?.pmUserId);
  const [nodes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Title, Path, Visibility FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL`,
    [vault.Id]
  );
  const visible = nodes.filter((n) =>
    canListNote(effectiveVis(n.Visibility, vault.DefaultVisibility), isAuthed, hasVaultAccess)
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
      robots: 'index,follow',
    },
  });
});

export default router;
