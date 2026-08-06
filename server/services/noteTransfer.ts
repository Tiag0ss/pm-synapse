/**
 * Copy / move a single note (with referenced media) into another vault.
 */
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { frontmatterJsonString, parseFrontmatter } from './frontmatter';
import { titleToPath } from './checkboxes';
import { sanitizeNotePath } from './notePaths';
import { readVaultMedia, saveVaultMedia, mediaPublicUrl } from './vaultMedia';
import { snapshotRevision, rebuildNoteGraph } from './notesGraph';
import { listNoteTaskCandidates } from './noteTasks';
import logger from '../utils/logger';

const ACTIVE_NOTE = 'DeletedAt IS NULL';
/** Matches both `![alt](.../media/id)` and `[label](.../media/id)`. */
const MEDIA_URL_RE = /(!?)\[([^\]]*)\]\(\/api\/vaults\/(\d+)\/media\/(\d+)\)/g;

export type NoteTransferMode = 'copy' | 'move';

export type NoteTransferResult = {
  noteId: number;
  vaultId: number;
  path: string;
  title: string;
  mode: NoteTransferMode;
};

async function syncCheckboxRows(noteId: number, bodyMarkdown: string): Promise<void> {
  const boxes = listNoteTaskCandidates(bodyMarkdown);
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

async function uniquePathInVault(
  vaultId: number,
  desiredPath: string,
  desiredTitle: string
): Promise<{ path: string; title: string }> {
  let path = sanitizeNotePath(desiredPath) || titleToPath(desiredTitle);
  let title = desiredTitle;
  for (let n = 1; n < 100; n++) {
    const [hits] = await pool.execute<RowDataPacket[]>(
      `SELECT Id FROM Notes WHERE VaultId = ? AND Path = ? AND ${ACTIVE_NOTE} LIMIT 1`,
      [vaultId, path]
    );
    if (!hits.length) return { path, title };
    const suffix = ` (${n + 1})`;
    const stem = path.replace(/\.md$/i, '');
    title = `${desiredTitle}${suffix}`;
    path = sanitizeNotePath(`${stem}${suffix}.md`) || titleToPath(title);
  }
  throw Object.assign(new Error('Could not find a unique path in the target vault'), {
    status: 409,
  });
}

async function copyReferencedMedia(
  sourceVaultId: number,
  targetVaultId: number,
  pmUserId: number,
  bodyMarkdown: string
): Promise<string> {
  const idMap = new Map<number, number>();
  let m: RegExpExecArray | null;
  const re = new RegExp(MEDIA_URL_RE.source, 'g');
  while ((m = re.exec(bodyMarkdown))) {
    const vId = Number(m[3]);
    const mediaId = Number(m[4]);
    if (vId !== sourceVaultId || idMap.has(mediaId)) continue;
    const file = await readVaultMedia(sourceVaultId, mediaId);
    if (!file) continue;
    try {
      const saved = await saveVaultMedia({
        vaultId: targetVaultId,
        pmUserId,
        mimeType: file.mimeType,
        dataBase64: file.buffer.toString('base64'),
        fileName: file.originalName,
      });
      idMap.set(mediaId, saved.id);
    } catch (error) {
      logger.warn('Failed to copy media during note transfer', {
        error,
        sourceVaultId,
        targetVaultId,
        mediaId,
      });
    }
  }

  if (!idMap.size) return bodyMarkdown;

  return bodyMarkdown.replace(MEDIA_URL_RE, (full, bang: string, alt: string, vId: string, mId: string) => {
    if (Number(vId) !== sourceVaultId) return full;
    const nextId = idMap.get(Number(mId));
    if (!nextId) return full;
    return `${bang}[${alt}](${mediaPublicUrl(targetVaultId, nextId)})`;
  });
}

export async function transferNoteToVault(params: {
  sourceVaultId: number;
  sourceNoteId: number;
  targetVaultId: number;
  pmUserId: number;
  mode: NoteTransferMode;
}): Promise<NoteTransferResult> {
  const { sourceVaultId, sourceNoteId, targetVaultId, pmUserId, mode } = params;
  if (sourceVaultId === targetVaultId) {
    throw Object.assign(new Error('Target vault must be different from the source vault'), {
      status: 400,
    });
  }

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, VaultId, Path, Title, BodyMarkdown, Visibility, AliasesJson, Icon
     FROM Notes WHERE Id = ? AND VaultId = ? AND ${ACTIVE_NOTE}`,
    [sourceNoteId, sourceVaultId]
  );
  if (!rows.length) {
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }
  const source = rows[0];
  const sourceTitle = String(source.Title);
  const sourcePath = String(source.Path || titleToPath(sourceTitle));

  let body = await copyReferencedMedia(
    sourceVaultId,
    targetVaultId,
    pmUserId,
    String(source.BodyMarkdown || '')
  );

  const { path, title } = await uniquePathInVault(targetVaultId, sourcePath, sourceTitle);
  const fmJson = frontmatterJsonString(parseFrontmatter(body).data);
  const visibility = source.Visibility != null ? String(source.Visibility) : null;
  const aliasesJson =
    source.AliasesJson != null ? String(source.AliasesJson) : JSON.stringify([]);
  const icon = source.Icon != null ? String(source.Icon) : null;

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO Notes (VaultId, Path, Title, BodyMarkdown, Visibility, AliasesJson, FrontmatterJson, Icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [targetVaultId, path, title, body, visibility, aliasesJson, fmJson, icon]
  );
  const newNoteId = result.insertId;

  await snapshotRevision(newNoteId, pmUserId, {
    title,
    path,
    bodyMarkdown: body,
    frontmatterJson: fmJson,
    visibility,
  });
  await rebuildNoteGraph(newNoteId, targetVaultId);
  await syncCheckboxRows(newNoteId, body);

  if (mode === 'move') {
    const trashPath = `__trash__/${sourceNoteId}/${sourcePath}`.slice(0, 1024);
    await pool.execute(
      `UPDATE Notes SET DeletedAt = CURRENT_TIMESTAMP, Path = ? WHERE Id = ? AND VaultId = ?`,
      [trashPath, sourceNoteId, sourceVaultId]
    );
    await pool.execute('DELETE FROM NoteLinks WHERE FromNoteId = ? OR ToNoteId = ?', [
      sourceNoteId,
      sourceNoteId,
    ]);
    logger.info('Note moved to trash after transfer', {
      sourceVaultId,
      sourceNoteId,
      targetVaultId,
      newNoteId,
    });
  }

  return {
    noteId: newNoteId,
    vaultId: targetVaultId,
    path,
    title,
    mode,
  };
}
