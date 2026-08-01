import { Router, Response, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { markdownToSafeHtml } from '../services/markdown';
import { readVaultMedia } from '../services/vaultMedia';
import { pool, RowDataPacket } from '../config/database';
import { optionalAuthenticateSession, AuthRequest } from '../middleware/auth';

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

function canListNote(visibility: string, isAuthed: boolean): boolean {
  if (visibility === 'public') return true;
  if (visibility === 'authenticated' && isAuthed) return true;
  return false;
}

function canOpenNote(visibility: string, isAuthed: boolean): { ok: boolean; robots: string } {
  if (visibility === 'public') return { ok: true, robots: 'index,follow' };
  if (visibility === 'unlisted') return { ok: true, robots: 'noindex,nofollow' };
  if (visibility === 'authenticated' && isAuthed) {
    return { ok: true, robots: 'noindex,nofollow' };
  }
  return { ok: false, robots: 'noindex,nofollow' };
}

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
  const [allNotes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Path, Title, Visibility, UpdatedAt
     FROM Notes
     WHERE VaultId = ?
     ORDER BY Path ASC`,
    [vault.Id]
  );
  const notes = allNotes.filter((n) =>
    canListNote(effectiveVis(n.Visibility, vault.DefaultVisibility), isAuthed)
  );
  res.json({
    success: true,
    data: {
      vault: { name: vault.Name, slug: vault.slug, description: vault.Description },
      notes,
      authenticated: isAuthed,
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
    `SELECT * FROM Notes WHERE Id = ? AND VaultId = ?`,
    [req.params.noteId, vault.Id]
  );
  if (!notes.length) {
    return res.status(404).json({ success: false, message: 'Note not found' });
  }
  const note = notes[0];
  const visibility = effectiveVis(note.Visibility, vault.DefaultVisibility);
  const isAuthed = Boolean(req.user?.pmUserId);
  const access = canOpenNote(visibility, isAuthed);
  if (!access.ok) {
    if (visibility === 'authenticated' && !isAuthed) {
      return res.status(401).json({
        success: false,
        message: 'Sign in required to view this note',
        requiresAuth: true,
      });
    }
    return res.status(404).json({ success: false, message: 'Note not found' });
  }

  const [allNotes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, Visibility FROM Notes WHERE VaultId = ?',
    [vault.Id]
  );
  const noteIndex = allNotes
    .filter((n) => {
      const v = effectiveVis(n.Visibility, vault.DefaultVisibility);
      return canOpenNote(v, isAuthed).ok;
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

  res.json({
    success: true,
    data: {
      id: Number(note.Id),
      title: note.Title,
      path: note.Path,
      html,
      robots: access.robots,
      visibility,
    },
  });
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
  const [nodes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Title, Path, Visibility FROM Notes WHERE VaultId = ?`,
    [vault.Id]
  );
  const visible = nodes.filter((n) =>
    canListNote(effectiveVis(n.Visibility, vault.DefaultVisibility), isAuthed)
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
      edges: edges.filter((e) => ids.has(Number(e.FromNoteId)) && ids.has(Number(e.ToNoteId))),
      robots: 'index,follow',
    },
  });
});

export default router;
