import { pool, RowDataPacket } from '../config/database';
import {
  setCheckboxLineByMarker,
  withStruckMarkdownText,
  type CheckboxMark,
} from './checkboxes';
import {
  frontmatterTodoIdFromMarker,
  isFrontmatterTodoMarker,
  setFrontmatterTodoContent,
  setFrontmatterTodoStatus,
  setFrontmatterTodoStatusLabel,
} from './frontmatter';
import { listNoteTaskCandidates } from './noteTasks';
import {
  fetchPmProjectTasks,
  fetchPmTaskStatuses,
  isPmTaskCancelled,
  isPmTaskDone,
  isPmTaskInProgress,
  normalizePmTaskStatusList,
  statusNameFromId,
  type PmTaskStatusValue,
  type PmTaskSummary,
} from './pmClient';
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
 * For YAML todos, writes the Planner status Name when organizationId is available.
 * Clears Synapse links when the PM task no longer exists in the project.
 */
export async function syncNoteCheckboxesFromPm(params: {
  pmUserId: number;
  noteId: number;
  bodyMarkdown: string;
  links: CheckboxLinkRow[];
  defaultProjectId?: number | null;
  organizationId?: number | null;
  /** Pre-fetched tasks by id (when syncing many notes against one project). */
  taskById?: Map<number, PmTaskSummary>;
  /** Projects already successfully fetched into taskById. */
  loadedProjects?: Set<number>;
  /** Pre-fetched org status catalog (optional). */
  statusList?: PmTaskStatusValue[];
}): Promise<{
  bodyMarkdown: string;
  updated: number;
  cleared: number;
  taskById: Map<number, PmTaskSummary>;
  /** Projects whose task lists were successfully fetched (safe to treat missing ids as deleted). */
  loadedProjects: Set<number>;
  statusList?: PmTaskStatusValue[];
}> {
  const linked = params.links.filter((l) => l.PmTaskId && l.MarkerId);
  if (!linked.length) {
    return {
      bodyMarkdown: params.bodyMarkdown,
      updated: 0,
      cleared: 0,
      taskById: params.taskById || new Map(),
      loadedProjects: params.loadedProjects || new Set(),
      statusList: params.statusList,
    };
  }

  let taskById = params.taskById;
  const loadedProjects = params.loadedProjects ? new Set(params.loadedProjects) : new Set<number>();
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
      loadedProjects.add(projectId);
      const tasks =
        (res.data as { tasks?: PmTaskSummary[] }).tasks ||
        (Array.isArray(res.data) ? (res.data as PmTaskSummary[]) : []);
      for (const t of tasks) {
        const id = Number(t.Id);
        if (Number.isFinite(id) && id > 0) taskById.set(id, t);
      }
    }
  } else if (!params.loadedProjects) {
    // Pre-fetched map without provenance — fetch any missing project lists once.
    const projectIds = new Set<number>();
    for (const link of linked) {
      const pid = Number(link.PmProjectId || params.defaultProjectId || 0);
      if (pid > 0 && !loadedProjects.has(pid)) projectIds.add(pid);
    }
    for (const projectId of projectIds) {
      const res = await fetchPmProjectTasks(params.pmUserId, projectId);
      if (!res.ok) continue;
      loadedProjects.add(projectId);
      const tasks =
        (res.data as { tasks?: PmTaskSummary[] }).tasks ||
        (Array.isArray(res.data) ? (res.data as PmTaskSummary[]) : []);
      for (const t of tasks) {
        const id = Number(t.Id);
        if (Number.isFinite(id) && id > 0) taskById.set(id, t);
      }
    }
  }

  let statusList = params.statusList;
  const orgId = Number(params.organizationId || 0);
  if (!statusList && orgId > 0) {
    const statusRes = await fetchPmTaskStatuses(params.pmUserId, orgId);
    statusList = normalizePmTaskStatusList(statusRes.data);
  }

  let body = params.bodyMarkdown;
  let updated = 0;
  let cleared = 0;

  for (const link of linked) {
    const taskId = Number(link.PmTaskId);
    const markerId = String(link.MarkerId);
    const projectId = Number(link.PmProjectId || params.defaultProjectId || 0);
    const task = taskById.get(taskId);

    if (!task) {
      if (projectId > 0 && loadedProjects.has(projectId)) {
        await pool.execute(
          `UPDATE NoteCheckboxTasks
           SET PmTaskId = NULL, PmProjectId = NULL, PmTaskLinkedAt = NULL
           WHERE NoteId = ? AND MarkerId = ?`,
          [params.noteId, markerId]
        );
        link.PmTaskId = null;
        link.PmProjectId = null;
        cleared += 1;
        logger.info('Cleared stale checkbox→PM link (task missing in Planner)', {
          noteId: params.noteId,
          markerId,
          taskId,
          projectId,
        });
      }
      continue;
    }

    const wantChecked = isPmTaskDone(task);
    const wantStruck = isPmTaskCancelled(task, statusList);
    const statusName =
      String(task.StatusName || '').trim() ||
      (statusList && task.Status != null
        ? statusNameFromId(statusList, Number(task.Status))
        : null);
    const wantMark: CheckboxMark = wantChecked
      ? 'x'
      : isPmTaskInProgress(task, statusList)
        ? '-'
        : ' ';

    const candidates = listNoteTaskCandidates(body);
    const local = candidates.find((b) => b.markerId === markerId);
    const localMark: CheckboxMark = local
      ? local.partial
        ? '-'
        : local.checked
          ? 'x'
          : ' '
      : Number(link.Checked)
        ? 'x'
        : ' ';
    const baseText = withStruckMarkdownText(String(local?.text || ''), false);
    const wantText = withStruckMarkdownText(baseText, wantStruck);
    const needsStrikeUpdate = Boolean(local?.text != null && local.text.trim() !== wantText);

    const needsCheckedUpdate = localMark !== wantMark || needsStrikeUpdate;
    const needsLabelUpdate =
      isFrontmatterTodoMarker(markerId) &&
      Boolean(statusName) &&
      local?.statusText?.trim().toLowerCase() !== statusName!.trim().toLowerCase();

    if (!needsCheckedUpdate && !needsLabelUpdate) {
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
      if (todoId) {
        if (statusName) {
          next = setFrontmatterTodoStatusLabel(body, todoId, statusName);
        } else {
          next = setFrontmatterTodoStatus(body, todoId, wantChecked);
        }
        if (next != null && needsStrikeUpdate) {
          const struck = setFrontmatterTodoContent(next, todoId, wantText);
          if (struck != null) next = struck;
        }
      }
    } else if (needsCheckedUpdate) {
      next = setCheckboxLineByMarker(body, markerId, {
        mark: wantMark,
        ...(local ? { text: wantText } : {}),
      });
    }

    if (next == null) {
      if (!needsCheckedUpdate) continue;
      continue;
    }
    // Even label-only updates count
    if (next !== body || needsCheckedUpdate) {
      body = next;
      updated += 1;
    }
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

  return { bodyMarkdown: body, updated, cleared, taskById, loadedProjects, statusList };
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
