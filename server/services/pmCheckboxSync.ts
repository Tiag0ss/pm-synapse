import { pool, RowDataPacket } from '../config/database';
import { setCheckboxCheckedByMarker } from './checkboxes';
import {
  frontmatterTodoIdFromMarker,
  isFrontmatterTodoMarker,
  setFrontmatterTodoStatus,
} from './frontmatter';
import { listNoteTaskCandidates } from './noteTasks';
import { fetchPmProjectTasks, isPmTaskDone, type PmTaskSummary } from './pmClient';
import logger from '../utils/logger';

export type CheckboxLinkRow = {
  MarkerId: string;
  PmTaskId: number | null;
  PmProjectId?: number | null;
  Checked?: number | boolean | null;
};

/**
 * Pull PM task closed/cancelled state into Synapse checkboxes / YAML todos
 * (markdown or frontmatter + link table). PM stays agnostic.
 */
export async function syncNoteCheckboxesFromPm(params: {
  pmUserId: number;
  noteId: number;
  bodyMarkdown: string;
  links: CheckboxLinkRow[];
  defaultProjectId?: number | null;
  /** Pre-fetched tasks by id (when syncing many notes against one project). */
  taskById?: Map<number, PmTaskSummary>;
}): Promise<{ bodyMarkdown: string; updated: number; taskById: Map<number, PmTaskSummary> }> {
  const linked = params.links.filter((l) => l.PmTaskId && l.MarkerId);
  if (!linked.length) {
    return {
      bodyMarkdown: params.bodyMarkdown,
      updated: 0,
      taskById: params.taskById || new Map(),
    };
  }

  let taskById = params.taskById;
  if (!taskById) {
    taskById = new Map();
    const projectIds = new Set<number>();
    for (const link of linked) {
      const pid = Number(link.PmProjectId || params.defaultProjectId || 0);
      if (pid > 0) projectIds.add(pid);
    }
    for (const projectId of projectIds) {
      const res = await fetchPmProjectTasks(params.pmUserId, projectId);
      if (!res.ok) {
        logger.warn('Could not fetch PM tasks for checkbox sync', {
          projectId,
          message: res.data.message,
        });
        continue;
      }
      const tasks =
        (res.data as { tasks?: PmTaskSummary[] }).tasks ||
        (Array.isArray(res.data) ? (res.data as PmTaskSummary[]) : []);
      for (const t of tasks) {
        const id = Number(t.Id);
        if (Number.isFinite(id) && id > 0) taskById.set(id, t);
      }
    }
  }

  let body = params.bodyMarkdown;
  let updated = 0;

  for (const link of linked) {
    const taskId = Number(link.PmTaskId);
    const markerId = String(link.MarkerId);
    const task = taskById.get(taskId);
    if (!task) continue;

    const wantChecked = isPmTaskDone(task);
    const candidates = listNoteTaskCandidates(body);
    const local = candidates.find((b) => b.markerId === markerId);
    const localChecked = local ? local.checked : Boolean(Number(link.Checked));

    if (localChecked === wantChecked) {
      if (local && Number(link.Checked) !== (wantChecked ? 1 : 0)) {
        await pool.execute(
          'UPDATE NoteCheckboxTasks SET Checked = ? WHERE NoteId = ? AND MarkerId = ?',
          [wantChecked ? 1 : 0, params.noteId, markerId]
        );
      }
      continue;
    }

    let next: string | null = null;
    if (isFrontmatterTodoMarker(markerId)) {
      const todoId = frontmatterTodoIdFromMarker(markerId);
      if (todoId) next = setFrontmatterTodoStatus(body, todoId, wantChecked);
    } else {
      next = setCheckboxCheckedByMarker(body, markerId, wantChecked);
    }
    if (next == null) continue;
    body = next;
    updated += 1;
    await pool.execute(
      'UPDATE NoteCheckboxTasks SET Checked = ? WHERE NoteId = ? AND MarkerId = ?',
      [wantChecked ? 1 : 0, params.noteId, markerId]
    );
  }

  if (updated > 0) {
    await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, params.noteId]);
    logger.info('Synced Synapse checkboxes from PM task status', {
      noteId: params.noteId,
      updated,
    });
  }

  return { bodyMarkdown: body, updated, taskById };
}

export async function loadNoteCheckboxLinks(noteId: number): Promise<CheckboxLinkRow[]> {
  const [links] = await pool.execute<RowDataPacket[]>(
    'SELECT MarkerId, PmTaskId, PmProjectId, Checked FROM NoteCheckboxTasks WHERE NoteId = ?',
    [noteId]
  );
  return links.map((l) => ({
    MarkerId: String(l.MarkerId),
    PmTaskId: l.PmTaskId != null ? Number(l.PmTaskId) : null,
    PmProjectId: l.PmProjectId != null ? Number(l.PmProjectId) : null,
    Checked: l.Checked,
  }));
}
