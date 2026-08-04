import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { extractTags, extractWikiLinks, findMentions } from './markdown';
import { rewriteFrontmatterTodoNoteTargets } from './frontmatter';
import { parseCrossVaultWikilinkTarget, pathStem, resolveNoteId } from './notePaths';

const MAX_REVISIONS = 50;

export type RevisionSource = 'manual' | 'auto';

function sameNullable(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

export async function snapshotRevision(
  noteId: number,
  pmUserId: number,
  snapshot: {
    title: string;
    path: string;
    bodyMarkdown: string;
    frontmatterJson: string | null;
    visibility: string | null;
    source?: RevisionSource;
  }
): Promise<boolean> {
  const source: RevisionSource = snapshot.source === 'auto' ? 'auto' : 'manual';

  const [latestRows] = await pool.execute<RowDataPacket[]>(
    `SELECT Title, Path, BodyMarkdown, FrontmatterJson, Visibility
     FROM NoteRevisions
     WHERE NoteId = ?
     ORDER BY RevisionNumber DESC
     LIMIT 1`,
    [noteId]
  );
  if (latestRows.length) {
    const prev = latestRows[0];
    const identical =
      String(prev.Title) === snapshot.title &&
      String(prev.Path) === snapshot.path &&
      String(prev.BodyMarkdown || '') === snapshot.bodyMarkdown &&
      sameNullable(
        prev.FrontmatterJson != null ? String(prev.FrontmatterJson) : null,
        snapshot.frontmatterJson
      ) &&
      sameNullable(prev.Visibility != null ? String(prev.Visibility) : null, snapshot.visibility);
    if (identical) return false;
  }

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT COALESCE(MAX(RevisionNumber), 0) AS MaxRev FROM NoteRevisions WHERE NoteId = ?',
    [noteId]
  );
  const next = Number(rows[0]?.MaxRev || 0) + 1;
  await pool.execute(
    `INSERT INTO NoteRevisions
      (NoteId, RevisionNumber, Title, Path, BodyMarkdown, FrontmatterJson, Visibility, Source, CreatedByPmUserId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      noteId,
      next,
      snapshot.title,
      snapshot.path,
      snapshot.bodyMarkdown,
      snapshot.frontmatterJson,
      snapshot.visibility,
      source,
      pmUserId,
    ]
  );

  await pool.execute(
    `DELETE FROM NoteRevisions
     WHERE NoteId = ?
       AND RevisionNumber <= (
         SELECT MaxRev FROM (
           SELECT COALESCE(MAX(RevisionNumber), 0) - ? AS MaxRev FROM NoteRevisions WHERE NoteId = ?
         ) t
       )`,
    [noteId, MAX_REVISIONS, noteId]
  );
  return true;
}

export async function rebuildNoteGraph(noteId: number, vaultId: number): Promise<void> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, BodyMarkdown, AliasesJson FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL',
    [vaultId]
  );
  const self = notes.find((n) => Number(n.Id) === noteId);
  if (!self) return;

  const dictionary = notes.map((n) => ({
    id: Number(n.Id),
    title: String(n.Title),
    aliases: safeJsonArray(n.AliasesJson),
  }));

  const resolveIndex = notes.map((n) => ({
    id: Number(n.Id),
    title: String(n.Title),
    path: String(n.Path || ''),
  }));

  const body = String(self.BodyMarkdown || '');
  const wikiTargets = extractWikiLinks(body);
  const mentionIds = findMentions(body, dictionary, noteId);
  const tags = extractTags(body);

  await pool.execute('DELETE FROM NoteLinks WHERE FromNoteId = ?', [noteId]);
  await pool.execute('DELETE FROM NoteTags WHERE NoteId = ?', [noteId]);

  const wikiLinkedIds = new Set<number>();
  for (const target of wikiTargets) {
    const cross = parseCrossVaultWikilinkTarget(target);
    let toId: number | null = null;
    if (cross) {
      const [vaultRows] = await pool.execute<RowDataPacket[]>(
        'SELECT Id FROM Vaults WHERE LOWER(slug) = LOWER(?) LIMIT 1',
        [cross.vaultSlug]
      );
      if (vaultRows.length) {
        const targetVaultId = Number(vaultRows[0].Id);
        const [remoteNotes] = await pool.execute<RowDataPacket[]>(
          'SELECT Id, Title, Path FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL',
          [targetVaultId]
        );
        toId = resolveNoteId(
          cross.noteTarget,
          remoteNotes.map((n) => ({
            id: Number(n.Id),
            title: String(n.Title),
            path: String(n.Path || ''),
          }))
        );
      }
    } else {
      toId = resolveNoteId(target, resolveIndex);
    }
    if (toId && toId !== noteId) {
      wikiLinkedIds.add(toId);
      await pool.execute(
        'INSERT IGNORE INTO NoteLinks (FromNoteId, ToNoteId, Kind) VALUES (?, ?, ?)',
        [noteId, toId, 'wikilink']
      );
    }
  }

  for (const toId of mentionIds) {
    // Prefer explicit [[wikilink]] — do not also store a mention edge to the same note
    if (wikiLinkedIds.has(toId)) continue;
    await pool.execute(
      'INSERT IGNORE INTO NoteLinks (FromNoteId, ToNoteId, Kind) VALUES (?, ?, ?)',
      [noteId, toId, 'mention']
    );
  }

  for (const tag of tags) {
    await pool.execute('INSERT IGNORE INTO NoteTags (NoteId, Tag) VALUES (?, ?)', [noteId, tag]);
  }
}

function safeJsonArray(raw: unknown): string[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function rewriteWikiLinksOnRename(
  vaultId: number,
  oldTitle: string,
  newTitle: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, BodyMarkdown FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL',
    [vaultId]
  );
  const oldStem = pathStem(oldPath);
  const newStem = pathStem(newPath);

  const noteFieldReplacements: Array<{ from: string; to: string }> = [];
  if (oldTitle !== newTitle) noteFieldReplacements.push({ from: oldTitle, to: newTitle });
  if (oldStem !== newStem) noteFieldReplacements.push({ from: oldStem, to: newStem });

  for (const note of notes) {
    let body = String(note.BodyMarkdown || '');
    const before = body;
    body = body.split(`[[${oldTitle}]]`).join(`[[${newTitle}]]`);
    body = body.split(`[[${oldStem}]]`).join(`[[${newStem}]]`);
    if (oldTitle !== newTitle) {
      body = body.replace(
        new RegExp(`\\[\\[${escapeRegExp(oldTitle)}\\|([^\\]]+)\\]\\]`, 'g'),
        `[[${newTitle}|$1]]`
      );
    }
    if (oldStem !== newStem) {
      body = body.replace(
        new RegExp(`\\[\\[${escapeRegExp(oldStem)}\\|([^\\]]+)\\]\\]`, 'g'),
        `[[${newStem}|$1]]`
      );
    }
    const rewrittenFm = rewriteFrontmatterTodoNoteTargets(body, noteFieldReplacements);
    if (rewrittenFm) body = rewrittenFm;

    if (body !== before) {
      await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, note.Id]);
      await rebuildNoteGraph(Number(note.Id), vaultId);
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type { ResultSetHeader };
