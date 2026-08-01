import { pool, RowDataPacket } from '../config/database';
import {
  ensureCheckboxMarker,
  parseCheckboxes,
} from './checkboxes';
import {
  buildPmTaskOpenUrl,
  buildSynapseNoteUrl,
  createPmTask,
  fetchPmTaskPriorities,
  fetchPmTaskStatuses,
} from './pmClient';
import { snapshotRevision } from './notesGraph';
import logger from '../utils/logger';

type StatusRow = { Id: number; IsDefault?: number; IsClosed?: number };
type PrioRow = { Id: number; IsDefault?: number };

const CREATE_CONCURRENCY = 6;

function pickStatusId(statusList: StatusRow[], checked: boolean): number | null {
  if (!statusList.length) return null;
  if (checked) {
    return Number((statusList.find((s) => Number(s.IsClosed) === 1) || statusList[0])?.Id) || null;
  }
  return (
    Number(
      (
        statusList.find((s) => Number(s.IsDefault) === 1 && Number(s.IsClosed) !== 1) ||
        statusList.find((s) => Number(s.IsClosed) !== 1) ||
        statusList[0]
      )?.Id
    ) || null
  );
}

function pickPriorityId(prioList: PrioRow[]): number | null {
  if (!prioList.length) return null;
  return Number((prioList.find((s) => Number(s.IsDefault) === 1) || prioList[0])?.Id) || null;
}

export function checkboxTextKey(noteId: number, text: string): string {
  return `${noteId}:${String(text || '').slice(0, 512).trim().toLowerCase()}`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export type PushMissingResult = {
  created: number;
  skipped: number;
  failed: number;
  errors: Array<{ noteId: number; noteTitle: string; index: number; message: string }>;
  createdTaskIds: number[];
};

export type PushProgress = {
  phase: 'prepare' | 'create';
  /** Items completed in the current phase */
  done: number;
  /** Total items in the current phase (0 while unknown) */
  total: number;
  created: number;
  failed: number;
  skipped: number;
  /** Short label for the UI (e.g. current task text) */
  label?: string;
};

type PendingCreate = {
  noteId: number;
  noteTitle: string;
  index: number;
  markerId: string;
  text: string;
  checked: boolean;
  statusId: number;
  synapseNoteUrl: string;
};

/**
 * Create PM tasks for every vault checkbox that is not yet linked.
 */
export async function pushMissingCheckboxTasks(params: {
  vaultId: number;
  pmUserId: number;
  projectId: number;
  organizationId: number;
  onProgress?: (p: PushProgress) => void | Promise<void>;
}): Promise<PushMissingResult> {
  const report = async (p: PushProgress) => {
    await params.onProgress?.(p);
  };

  await report({
    phase: 'prepare',
    done: 0,
    total: 0,
    created: 0,
    failed: 0,
    skipped: 0,
    label: 'Resolving status & priorities…',
  });

  const [statusRes, prioRes] = await Promise.all([
    fetchPmTaskStatuses(params.pmUserId, params.organizationId),
    fetchPmTaskPriorities(params.pmUserId, params.organizationId),
  ]);
  const statusList =
    (statusRes.data as { statuses?: StatusRow[] }).statuses ||
    (Array.isArray(statusRes.data) ? (statusRes.data as StatusRow[]) : []);
  const prioList =
    (prioRes.data as { priorities?: PrioRow[] }).priorities ||
    (Array.isArray(prioRes.data) ? (prioRes.data as PrioRow[]) : []);
  const priorityId = pickPriorityId(prioList);
  if (!priorityId) {
    throw Object.assign(new Error('Could not resolve PM task priority'), { status: 400 });
  }

  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, BodyMarkdown, Visibility FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL ORDER BY Path ASC',
    [params.vaultId]
  );
  const [links] = await pool.execute<RowDataPacket[]>(
    `SELECT c.NoteId, c.MarkerId, c.Text, c.PmTaskId
     FROM NoteCheckboxTasks c
     INNER JOIN Notes n ON n.Id = c.NoteId
     WHERE n.VaultId = ? AND c.PmTaskId IS NOT NULL`,
    [params.vaultId]
  );
  const linkedMarkers = new Set(links.map((l) => `${Number(l.NoteId)}:${String(l.MarkerId)}`));
  const linkedByText = new Set(
    links.map((l) => checkboxTextKey(Number(l.NoteId), String(l.Text || '')))
  );

  const result: PushMissingResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    createdTaskIds: [],
  };

  const pending: PendingCreate[] = [];
  const noteTotal = notes.length;

  for (let ni = 0; ni < notes.length; ni++) {
    const note = notes[ni];
    let body = String(note.BodyMarkdown || '');
    const boxes = parseCheckboxes(body);
    if (!boxes.length) {
      if (ni === notes.length - 1 || ni % 5 === 0) {
        await report({
          phase: 'prepare',
          done: ni + 1,
          total: noteTotal,
          created: 0,
          failed: result.failed,
          skipped: result.skipped,
          label: `Scanning notes… (${ni + 1}/${noteTotal})`,
        });
      }
      continue;
    }

    let bodyChanged = false;
    const noteId = Number(note.Id);
    const noteTitle = String(note.Title);
    const synapseNoteUrl = buildSynapseNoteUrl(params.vaultId, noteId);

    for (const box of boxes) {
      let markerId = box.markerId;
      const workingIndex = box.index;

      if (!markerId) {
        const ensured = ensureCheckboxMarker(body, workingIndex);
        if (!ensured) {
          result.failed += 1;
          result.errors.push({
            noteId,
            noteTitle,
            index: workingIndex,
            message: 'Could not attach checkbox marker',
          });
          continue;
        }
        body = ensured.markdown;
        markerId = ensured.markerId;
        bodyChanged = true;
      }

      const current = parseCheckboxes(body).find((b) => b.markerId === markerId);
      if (!current) {
        result.failed += 1;
        result.errors.push({
          noteId,
          noteTitle,
          index: workingIndex,
          message: 'Checkbox missing after marker',
        });
        continue;
      }

      const textKey = checkboxTextKey(noteId, current.text);
      if (linkedMarkers.has(`${noteId}:${markerId}`) || linkedByText.has(textKey)) {
        result.skipped += 1;
        continue;
      }

      const statusId = pickStatusId(statusList, current.checked);
      if (!statusId) {
        result.failed += 1;
        result.errors.push({
          noteId,
          noteTitle,
          index: workingIndex,
          message: 'Could not resolve PM task status',
        });
        continue;
      }

      // Reserve so parallel siblings with same text don't double-create
      linkedMarkers.add(`${noteId}:${markerId}`);
      linkedByText.add(textKey);
      pending.push({
        noteId,
        noteTitle,
        index: workingIndex,
        markerId,
        text: current.text.slice(0, 512),
        checked: current.checked,
        statusId,
        synapseNoteUrl,
      });
    }

    if (bodyChanged) {
      await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, noteId]);
      await snapshotRevision(noteId, params.pmUserId, {
        title: noteTitle,
        path: String(note.Path),
        bodyMarkdown: body,
        frontmatterJson: null,
        visibility: note.Visibility ? String(note.Visibility) : null,
      });
    }

    if (ni === notes.length - 1 || ni % 5 === 0) {
      await report({
        phase: 'prepare',
        done: ni + 1,
        total: noteTotal,
        created: 0,
        failed: result.failed,
        skipped: result.skipped,
        label: `Scanning notes… (${ni + 1}/${noteTotal})`,
      });
    }
  }

  const createTotal = pending.length;
  await report({
    phase: 'create',
    done: 0,
    total: createTotal,
    created: 0,
    failed: result.failed,
    skipped: result.skipped,
    label: createTotal ? `Creating ${createTotal} task${createTotal === 1 ? '' : 's'}…` : 'Nothing to create',
  });

  let createDone = 0;

  await mapPool(pending, CREATE_CONCURRENCY, async (item) => {
    const created = await createPmTask(params.pmUserId, {
      projectId: params.projectId,
      taskName: item.text || item.noteTitle,
      description: `<p>From Synapse note <strong>${item.noteTitle}</strong></p>`,
      status: item.statusId,
      priority: priorityId,
      synapseVaultId: params.vaultId,
      synapseNoteId: item.noteId,
      synapseMarkerId: item.markerId,
      synapseNoteUrl: item.synapseNoteUrl,
    });

    if (!created.ok) {
      result.failed += 1;
      result.errors.push({
        noteId: item.noteId,
        noteTitle: item.noteTitle,
        index: item.index,
        message: created.data.message || 'Failed to create PM task',
      });
      logger.warn('Bulk checkbox push failed', {
        noteId: item.noteId,
        message: created.data.message,
      });
      createDone += 1;
      await report({
        phase: 'create',
        done: createDone,
        total: createTotal,
        created: result.created,
        failed: result.failed,
        skipped: result.skipped,
        label: item.text.slice(0, 80) || item.noteTitle,
      });
      return;
    }

    const taskId =
      created.data.taskId ||
      created.data.id ||
      (created.data as { data?: { Id?: number } }).data?.Id;
    if (!taskId) {
      result.failed += 1;
      result.errors.push({
        noteId: item.noteId,
        noteTitle: item.noteTitle,
        index: item.index,
        message: 'PM did not return task id',
      });
      createDone += 1;
      await report({
        phase: 'create',
        done: createDone,
        total: createTotal,
        created: result.created,
        failed: result.failed,
        skipped: result.skipped,
        label: item.text.slice(0, 80) || item.noteTitle,
      });
      return;
    }

    await pool.execute(
      `INSERT INTO NoteCheckboxTasks (NoteId, MarkerId, Text, Checked, PmTaskId, PmProjectId, PmTaskLinkedAt)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         Text = VALUES(Text),
         Checked = VALUES(Checked),
         PmTaskId = VALUES(PmTaskId),
         PmProjectId = VALUES(PmProjectId),
         PmTaskLinkedAt = CURRENT_TIMESTAMP`,
      [
        item.noteId,
        item.markerId,
        item.text,
        item.checked ? 1 : 0,
        taskId,
        params.projectId,
      ]
    );
    result.created += 1;
    result.createdTaskIds.push(Number(taskId));
    createDone += 1;
    await report({
      phase: 'create',
      done: createDone,
      total: createTotal,
      created: result.created,
      failed: result.failed,
      skipped: result.skipped,
      label: item.text.slice(0, 80) || item.noteTitle,
    });
  });

  return result;
}

export { buildPmTaskOpenUrl };
