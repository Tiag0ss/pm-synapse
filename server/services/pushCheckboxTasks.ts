import { pool, RowDataPacket } from '../config/database';
import {
  ensureCheckboxMarker,
  parseCheckboxes,
} from './checkboxes';
import {
  ensureFrontmatterTodoIds,
} from './frontmatter';
import { listNoteTaskCandidates, type NoteTaskCandidate } from './noteTasks';
import {
  buildPmTaskOpenUrl,
  buildSynapseNoteUrl,
  createPmTask,
  fetchPmProjectTasks,
  fetchPmTaskPriorities,
  fetchPmTaskStatuses,
  normalizePmTaskStatusList,
  resolvePmTaskStatusId,
  type PmTaskStatusValue,
} from './pmClient';
import { markdownToPmDescriptionHtml, type MarkdownNoteRef } from './markdown';
import { snapshotRevision } from './notesGraph';
import { stripMarkdownToPlainText } from './plainText';
import logger from '../utils/logger';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function vaultNoteRefs(vaultId: number): Promise<MarkdownNoteRef[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL',
    [vaultId]
  );
  return rows.map((n) => ({
    id: Number(n.Id),
    title: String(n.Title),
    path: String(n.Path || ''),
  }));
}

/** HTML description for a note-level Planner task (full note body). */
async function noteLevelTaskDescription(
  vaultId: number,
  noteId: number,
  title: string,
  bodyMarkdown: string
): Promise<string> {
  const notes = await vaultNoteRefs(vaultId);
  const contentHtml = markdownToPmDescriptionHtml(bodyMarkdown, notes, noteId);
  if (contentHtml) return contentHtml;
  return `<p>Synapse note task for <strong>${escapeHtml(title)}</strong></p>`;
}

type PrioRow = { Id: number; IsDefault?: number };

function pickPriorityId(prioList: PrioRow[]): number | null {
  if (!prioList.length) return null;
  return Number((prioList.find((s) => Number(s.IsDefault) === 1) || prioList[0])?.Id) || null;
}

export function checkboxTextKey(noteId: number, text: string): string {
  return `${noteId}:${String(text || '').slice(0, 512).trim().toLowerCase()}`;
}

async function loadStatusAndPriority(
  pmUserId: number,
  organizationId: number
): Promise<{ statusList: PmTaskStatusValue[]; priorityId: number }> {
  const [statusRes, prioRes] = await Promise.all([
    fetchPmTaskStatuses(pmUserId, organizationId),
    fetchPmTaskPriorities(pmUserId, organizationId),
  ]);
  const statusList = normalizePmTaskStatusList(statusRes.data);
  const prioList =
    (prioRes.data as { priorities?: PrioRow[] }).priorities ||
    (Array.isArray(prioRes.data) ? (prioRes.data as PrioRow[]) : []);
  const priorityId = pickPriorityId(prioList);
  if (!priorityId) {
    throw Object.assign(new Error('Could not resolve PM task priority'), { status: 400 });
  }
  return { statusList, priorityId };
}

function taskNameForPm(box: NoteTaskCandidate, fallback: string): string {
  const raw = box.taskText ?? box.text;
  return (stripMarkdownToPlainText(raw) || fallback).slice(0, 512);
}

function estimateCreateFields(box: NoteTaskCandidate): {
  estimatedHours?: number;
  unscheduledWork?: boolean;
} {
  const out: { estimatedHours?: number; unscheduledWork?: boolean } = {};
  if (box.estimate?.estimatedHours != null && Number.isFinite(box.estimate.estimatedHours)) {
    out.estimatedHours = box.estimate.estimatedHours;
  }
  if (box.estimate?.unscheduledWork === true) out.unscheduledWork = true;
  return out;
}

function statusIdForCandidate(
  statusList: PmTaskStatusValue[],
  box: NoteTaskCandidate
): number | null {
  return resolvePmTaskStatusId(statusList, {
    statusText: box.source === 'frontmatter' ? box.statusText : null,
    checked: box.checked,
  });
}

function pickTaskId(data: {
  taskId?: number;
  id?: number;
  data?: { Id?: number };
}): number | null {
  const id = data.taskId || data.id || data.data?.Id;
  return id != null ? Number(id) : null;
}

type IndentStackEntry = { indent: number; pmTaskId: number | null };

/** Nearest linked ancestor in the indent stack, else the note-level task. */
export function resolveParentTaskId(
  stack: IndentStackEntry[],
  notePmTaskId: number | null
): number | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].pmTaskId) return stack[i].pmTaskId;
  }
  return notePmTaskId;
}

export function pushIndentStack(stack: IndentStackEntry[], indent: number, pmTaskId: number | null) {
  while (stack.length && stack[stack.length - 1].indent >= indent) {
    stack.pop();
  }
  stack.push({ indent, pmTaskId });
}

export type PushMissingResult = {
  created: number;
  skipped: number;
  failed: number;
  errors: Array<{ noteId: number; noteTitle: string; index: number; message: string }>;
  createdTaskIds: number[];
  /** Present when a single note was processed — editor should apply markers. */
  bodyMarkdown?: string;
};

export type PushProgress = {
  phase: 'prepare' | 'create';
  done: number;
  total: number;
  created: number;
  failed: number;
  skipped: number;
  label?: string;
};

export type PushNoteTaskResult = {
  pmTaskId: number;
  openUrl: string;
  alreadyLinked: boolean;
};

/** Create (or return existing) PM task for the whole note. */
export async function pushNoteAsPmTask(params: {
  vaultId: number;
  noteId: number;
  pmUserId: number;
  projectId: number;
  organizationId: number;
}): Promise<PushNoteTaskResult> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, Title, Path, BodyMarkdown, Visibility, PmTaskId FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
    [params.noteId, params.vaultId]
  );
  if (!notes.length) {
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }
  const note = notes[0];
  const existing = note.PmTaskId != null ? Number(note.PmTaskId) : null;
  if (existing) {
    const projectTaskIds = await loadProjectTaskIdSet(params.pmUserId, params.projectId);
    if (projectTaskIds == null || projectTaskIds.has(existing)) {
      return {
        pmTaskId: existing,
        openUrl: buildPmTaskOpenUrl(params.projectId, existing),
        alreadyLinked: true,
      };
    }
    await pool.execute(
      `UPDATE Notes SET PmTaskId = NULL, PmProjectId = NULL, PmTaskLinkedAt = NULL
       WHERE Id = ?`,
      [params.noteId]
    );
    logger.info('Cleared stale note-level PM link before recreate', {
      noteId: params.noteId,
      pmTaskId: existing,
    });
  }

  const { statusList, priorityId } = await loadStatusAndPriority(
    params.pmUserId,
    params.organizationId
  );
  const statusId = resolvePmTaskStatusId(statusList, { checked: false });
  if (!statusId) {
    throw Object.assign(new Error('Could not resolve PM task status'), { status: 400 });
  }

  const title = stripMarkdownToPlainText(String(note.Title)) || String(note.Title);
  const synapseNoteUrl = buildSynapseNoteUrl(params.vaultId, params.noteId);
  const description = await noteLevelTaskDescription(
    params.vaultId,
    params.noteId,
    String(note.Title),
    String(note.BodyMarkdown || '')
  );
  const created = await createPmTask(params.pmUserId, {
    projectId: params.projectId,
    taskName: title.slice(0, 512),
    description,
    status: statusId,
    priority: priorityId,
    synapseVaultId: params.vaultId,
    synapseNoteId: params.noteId,
    synapseNoteUrl,
  });
  if (!created.ok) {
    throw Object.assign(new Error(created.data.message || 'Failed to create PM task'), {
      status: created.status,
    });
  }
  const taskId = pickTaskId(created.data);
  if (!taskId) {
    throw Object.assign(new Error('PM did not return task id'), { status: 500 });
  }

  await pool.execute(
    `UPDATE Notes SET PmTaskId = ?, PmProjectId = ?, PmTaskLinkedAt = CURRENT_TIMESTAMP
     WHERE Id = ? AND VaultId = ?`,
    [taskId, params.projectId, params.noteId, params.vaultId]
  );

  return {
    pmTaskId: taskId,
    openUrl: buildPmTaskOpenUrl(params.projectId, taskId),
    alreadyLinked: false,
  };
}

type LinkedRow = { MarkerId: string; Text: string; PmTaskId: number };

async function linkRowsForNote(noteId: number): Promise<LinkedRow[]> {
  const [links] = await pool.execute<RowDataPacket[]>(
    `SELECT MarkerId, Text, PmTaskId FROM NoteCheckboxTasks
     WHERE NoteId = ? AND PmTaskId IS NOT NULL`,
    [noteId]
  );
  return links.map((l) => ({
    MarkerId: String(l.MarkerId),
    Text: String(l.Text || ''),
    PmTaskId: Number(l.PmTaskId),
  }));
}

async function loadProjectTaskIdSet(
  userId: number,
  projectId: number
): Promise<Set<number> | null> {
  const res = await fetchPmProjectTasks(userId, projectId);
  if (!res.ok) return null;
  const tasks =
    (res.data as { tasks?: Array<{ Id?: number }> }).tasks ||
    (Array.isArray(res.data) ? (res.data as Array<{ Id?: number }>) : []);
  const ids = new Set<number>();
  for (const t of tasks) {
    const id = Number(t.Id);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return ids;
}

export async function clearCheckboxPmLink(noteId: number, markerId: string): Promise<void> {
  await pool.execute(
    `UPDATE NoteCheckboxTasks
     SET PmTaskId = NULL, PmProjectId = NULL, PmTaskLinkedAt = NULL
     WHERE NoteId = ? AND MarkerId = ?`,
    [noteId, markerId]
  );
}

function findExistingLink(
  noteId: number,
  box: { markerId: string | null; text: string },
  links: LinkedRow[]
): LinkedRow | null {
  if (box.markerId) {
    const byMarker = links.find((l) => l.MarkerId === box.markerId);
    if (byMarker) return byMarker;
  }
  const key = checkboxTextKey(noteId, box.text);
  return links.find((l) => checkboxTextKey(noteId, l.Text) === key) || null;
}

export async function persistCheckboxLink(params: {
  noteId: number;
  markerId: string;
  text: string;
  checked: boolean;
  taskId: number;
  projectId: number;
}) {
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
      params.noteId,
      params.markerId,
      params.text.slice(0, 512),
      params.checked ? 1 : 0,
      params.taskId,
      params.projectId,
    ]
  );
}

/**
 * Ensure markers, then create missing PM tasks for one note in document order
 * so nested checkboxes become Planner subtasks (parentTaskId).
 */
export async function pushMissingCheckboxTasksForNote(params: {
  vaultId: number;
  noteId: number;
  noteTitle: string;
  notePath: string;
  noteVisibility: string | null;
  bodyMarkdown: string;
  notePmTaskId: number | null;
  pmUserId: number;
  projectId: number;
  statusList: PmTaskStatusValue[];
  priorityId: number;
  /** When set, stale Synapse links (PM task deleted) are cleared and recreated. */
  projectTaskIds?: Set<number> | null;
  onItem?: (label: string) => void | Promise<void>;
}): Promise<PushMissingResult & { bodyMarkdown: string }> {
  const result: PushMissingResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    createdTaskIds: [],
  };

  let body = params.bodyMarkdown;
  let bodyChanged = false;

  const ensuredFm = ensureFrontmatterTodoIds(body);
  if (ensuredFm.changed) {
    body = ensuredFm.markdown;
    bodyChanged = true;
  }

  let boxes = parseCheckboxes(body);
  for (const box of boxes) {
    if (box.markerId) continue;
    const ensured = ensureCheckboxMarker(body, box.index);
    if (!ensured) {
      result.failed += 1;
      result.errors.push({
        noteId: params.noteId,
        noteTitle: params.noteTitle,
        index: box.index,
        message: 'Could not attach checkbox marker',
      });
      continue;
    }
    body = ensured.markdown;
    bodyChanged = true;
  }
  if (bodyChanged) {
    await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, params.noteId]);
    await snapshotRevision(params.noteId, params.pmUserId, {
      title: params.noteTitle,
      path: params.notePath,
      bodyMarkdown: body,
      frontmatterJson: null,
      visibility: params.noteVisibility,
    });
  }

  const candidates = listNoteTaskCandidates(body);
  const links = await linkRowsForNote(params.noteId);
  const synapseNoteUrl = buildSynapseNoteUrl(params.vaultId, params.noteId);
  const stack: IndentStackEntry[] = [];
  const projectTaskIds = params.projectTaskIds;

  for (const box of candidates) {
    const markerId = box.markerId;
    if (!markerId) {
      result.failed += 1;
      result.errors.push({
        noteId: params.noteId,
        noteTitle: params.noteTitle,
        index: box.index,
        message:
          box.source === 'frontmatter'
            ? 'Frontmatter todo missing id'
            : 'Checkbox missing marker',
      });
      continue;
    }

    while (stack.length && stack[stack.length - 1].indent >= box.indent) {
      stack.pop();
    }
    const parentTaskId = resolveParentTaskId(stack, params.notePmTaskId);

    const existing = findExistingLink(params.noteId, box, links);
    if (existing) {
      const stale =
        projectTaskIds != null && !projectTaskIds.has(existing.PmTaskId);
      if (stale) {
        await clearCheckboxPmLink(params.noteId, existing.MarkerId);
        const idx = links.findIndex((l) => l.MarkerId === existing.MarkerId);
        if (idx >= 0) links.splice(idx, 1);
      } else {
        if (existing.MarkerId !== markerId) {
          await persistCheckboxLink({
            noteId: params.noteId,
            markerId,
            text: box.text,
            checked: box.checked,
            taskId: existing.PmTaskId,
            projectId: params.projectId,
          });
          await clearCheckboxPmLink(params.noteId, existing.MarkerId);
          const idx = links.findIndex((l) => l.MarkerId === existing.MarkerId);
          if (idx >= 0) links.splice(idx, 1);
          links.push({
            MarkerId: markerId,
            Text: box.text,
            PmTaskId: existing.PmTaskId,
          });
        }
        result.skipped += 1;
        stack.push({ indent: box.indent, pmTaskId: existing.PmTaskId });
        continue;
      }
    }

    const statusId = statusIdForCandidate(params.statusList, box);
    if (!statusId) {
      result.failed += 1;
      result.errors.push({
        noteId: params.noteId,
        noteTitle: params.noteTitle,
        index: box.index,
        message: 'Could not resolve PM task status',
      });
      stack.push({ indent: box.indent, pmTaskId: null });
      continue;
    }

    await params.onItem?.(box.text.slice(0, 80) || params.noteTitle);

    const created = await createPmTask(params.pmUserId, {
      projectId: params.projectId,
      taskName: taskNameForPm(box, params.noteTitle),
      description:
        box.source === 'frontmatter'
          ? `<p>From Synapse note <strong>${params.noteTitle}</strong> (YAML todo)</p>`
          : `<p>From Synapse note <strong>${params.noteTitle}</strong></p>`,
      status: statusId,
      priority: params.priorityId,
      parentTaskId: parentTaskId || undefined,
      ...estimateCreateFields(box),
      synapseVaultId: params.vaultId,
      synapseNoteId: params.noteId,
      synapseMarkerId: markerId,
      synapseNoteUrl,
    });

    if (!created.ok) {
      result.failed += 1;
      result.errors.push({
        noteId: params.noteId,
        noteTitle: params.noteTitle,
        index: box.index,
        message: created.data.message || 'Failed to create PM task',
      });
      logger.warn('Checkbox push failed', {
        noteId: params.noteId,
        message: created.data.message,
      });
      stack.push({ indent: box.indent, pmTaskId: null });
      continue;
    }

    const taskId = pickTaskId(created.data);
    if (!taskId) {
      result.failed += 1;
      result.errors.push({
        noteId: params.noteId,
        noteTitle: params.noteTitle,
        index: box.index,
        message: 'PM did not return task id',
      });
      stack.push({ indent: box.indent, pmTaskId: null });
      continue;
    }

    await persistCheckboxLink({
      noteId: params.noteId,
      markerId,
      text: box.text,
      checked: box.checked,
      taskId,
      projectId: params.projectId,
    });
    links.push({ MarkerId: markerId, Text: box.text, PmTaskId: taskId });
    result.created += 1;
    result.createdTaskIds.push(taskId);
    stack.push({ indent: box.indent, pmTaskId: taskId });
  }

  return { ...result, bodyMarkdown: body };
}

/**
 * Create PM tasks for every vault checkbox that is not yet linked.
 * Nested checkboxes become subtasks; top-level checkboxes nest under the note task when linked.
 */
export async function pushMissingCheckboxTasks(params: {
  vaultId: number;
  pmUserId: number;
  projectId: number;
  organizationId: number;
  /** When set, only this note is processed */
  noteId?: number;
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

  const { statusList, priorityId } = await loadStatusAndPriority(
    params.pmUserId,
    params.organizationId
  );

  const noteSql = params.noteId
    ? 'SELECT Id, Title, Path, BodyMarkdown, Visibility, PmTaskId FROM Notes WHERE VaultId = ? AND Id = ? AND DeletedAt IS NULL'
    : 'SELECT Id, Title, Path, BodyMarkdown, Visibility, PmTaskId FROM Notes WHERE VaultId = ? AND DeletedAt IS NULL ORDER BY Path ASC';
  const noteParams = params.noteId ? [params.vaultId, params.noteId] : [params.vaultId];
  const [notes] = await pool.execute<RowDataPacket[]>(noteSql, noteParams);

  const result: PushMissingResult = {
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    createdTaskIds: [],
  };

  const noteTotal = notes.length;
  await report({
    phase: 'prepare',
    done: 0,
    total: noteTotal,
    created: 0,
    failed: 0,
    skipped: 0,
    label: `Scanning ${noteTotal} note${noteTotal === 1 ? '' : 's'}…`,
  });

  // Approximate create total for progress (unlinked checkboxes + YAML todos)
  let createTotal = 0;
  for (const note of notes) {
    const noteId = Number(note.Id);
    const links = await linkRowsForNote(noteId);
    const linkedMarkers = new Set(links.map((l) => l.MarkerId));
    const linkedText = new Set(links.map((l) => checkboxTextKey(noteId, l.Text)));
    for (const box of listNoteTaskCandidates(String(note.BodyMarkdown || ''))) {
      if (
        (box.markerId && linkedMarkers.has(box.markerId)) ||
        linkedText.has(checkboxTextKey(noteId, box.text))
      ) {
        continue;
      }
      createTotal += 1;
    }
  }

  await report({
    phase: 'create',
    done: 0,
    total: createTotal,
    created: 0,
    failed: 0,
    skipped: 0,
    label: createTotal
      ? `Creating ${createTotal} task${createTotal === 1 ? '' : 's'}…`
      : 'Nothing to create',
  });

  let createDone = 0;
  const projectTaskIds = await loadProjectTaskIdSet(params.pmUserId, params.projectId);

  for (let ni = 0; ni < notes.length; ni++) {
    const note = notes[ni];
    const noteId = Number(note.Id);
    const noteResult = await pushMissingCheckboxTasksForNote({
      vaultId: params.vaultId,
      noteId,
      noteTitle: String(note.Title),
      notePath: String(note.Path),
      noteVisibility: note.Visibility ? String(note.Visibility) : null,
      bodyMarkdown: String(note.BodyMarkdown || ''),
      notePmTaskId: note.PmTaskId != null ? Number(note.PmTaskId) : null,
      pmUserId: params.pmUserId,
      projectId: params.projectId,
      statusList,
      priorityId,
      projectTaskIds,
      onItem: async (label) => {
        createDone += 1;
        await report({
          phase: 'create',
          done: Math.min(createDone, createTotal || createDone),
          total: createTotal || createDone,
          created: result.created,
          failed: result.failed,
          skipped: result.skipped,
          label,
        });
      },
    });

    result.created += noteResult.created;
    result.skipped += noteResult.skipped;
    result.failed += noteResult.failed;
    result.errors.push(...noteResult.errors);
    result.createdTaskIds.push(...noteResult.createdTaskIds);
    if (params.noteId != null) {
      result.bodyMarkdown = noteResult.bodyMarkdown;
    }

    await report({
      phase: 'create',
      done: Math.min(createDone, createTotal || createDone),
      total: createTotal || createDone,
      created: result.created,
      failed: result.failed,
      skipped: result.skipped,
      label: String(note.Title),
    });
  }

  return result;
}

/** Create one checkbox PM task (and missing ancestors for nesting). */
export async function pushSingleCheckboxTask(params: {
  vaultId: number;
  noteId: number;
  checkboxIndex: number;
  pmUserId: number;
  projectId: number;
  organizationId: number;
}): Promise<{
  markerId: string;
  pmTaskId: number;
  pmProjectId: number;
  bodyMarkdown?: string;
  openUrl: string;
  alreadyLinked?: boolean;
}> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
    [params.noteId, params.vaultId]
  );
  if (!notes.length) {
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }
  const note = notes[0];
  let body = String(note.BodyMarkdown || '');
  const originalBody = body;
  const noteTitle = String(note.Title);
  const notePmTaskId = note.PmTaskId != null ? Number(note.PmTaskId) : null;

  const ensuredFm = ensureFrontmatterTodoIds(body);
  if (ensuredFm.changed) body = ensuredFm.markdown;

  let candidates = listNoteTaskCandidates(body);
  const peek = candidates[params.checkboxIndex];
  if (!peek) {
    throw Object.assign(new Error('Checkbox not found'), { status: 404 });
  }

  if (peek.source === 'checkbox') {
    const ensured = ensureCheckboxMarker(body, params.checkboxIndex);
    if (!ensured) {
      throw Object.assign(new Error('Checkbox not found'), { status: 404 });
    }
    body = ensured.markdown;

    // Ensure markers for all checkboxes before/at target (needed for stable ancestor ids)
    let boxes = parseCheckboxes(body);
    const targetBox = boxes[params.checkboxIndex];
    if (!targetBox) {
      throw Object.assign(new Error('Checkbox not found'), { status: 404 });
    }
    for (let i = 0; i <= targetBox.index; i++) {
      boxes = parseCheckboxes(body);
      if (!boxes[i]?.markerId) {
        const e = ensureCheckboxMarker(body, i);
        if (e) body = e.markdown;
      }
    }
  }

  candidates = listNoteTaskCandidates(body);
  const target = candidates[params.checkboxIndex];
  if (!target?.markerId) {
    throw Object.assign(new Error('Task not found after marker'), { status: 404 });
  }

  // Ancestor chain: walk preceding tasks with a strict indent stack
  const stackBoxes: NoteTaskCandidate[] = [];
  for (const box of candidates) {
    if (box.index > target.index) break;
    while (stackBoxes.length && stackBoxes[stackBoxes.length - 1].indent >= box.indent) {
      stackBoxes.pop();
    }
    stackBoxes.push(box);
  }

  const { statusList, priorityId } = await loadStatusAndPriority(
    params.pmUserId,
    params.organizationId
  );
  const links = await linkRowsForNote(params.noteId);
  const projectTaskIds = await loadProjectTaskIdSet(params.pmUserId, params.projectId);
  const synapseNoteUrl = buildSynapseNoteUrl(params.vaultId, params.noteId);
  let parentTaskId: number | null = notePmTaskId;
  let createdAny = false;
  let targetTaskId: number | null = null;

  for (const box of stackBoxes) {
    const markerId = box.markerId!;
    const existing = findExistingLink(params.noteId, box, links);
    if (existing) {
      const stale =
        projectTaskIds != null && !projectTaskIds.has(existing.PmTaskId);
      if (stale) {
        await clearCheckboxPmLink(params.noteId, existing.MarkerId);
        const idx = links.findIndex((l) => l.MarkerId === existing.MarkerId);
        if (idx >= 0) links.splice(idx, 1);
        logger.info('Stale checkbox PM link cleared before recreate', {
          noteId: params.noteId,
          markerId: existing.MarkerId,
          pmTaskId: existing.PmTaskId,
        });
      } else {
        // Heal marker mismatch so the UI can resolve the openUrl on reload
        if (existing.MarkerId !== markerId || existing.Text !== box.text) {
          await persistCheckboxLink({
            noteId: params.noteId,
            markerId,
            text: box.text,
            checked: box.checked,
            taskId: existing.PmTaskId,
            projectId: params.projectId,
          });
          if (existing.MarkerId !== markerId) {
            await clearCheckboxPmLink(params.noteId, existing.MarkerId);
            const idx = links.findIndex((l) => l.MarkerId === existing.MarkerId);
            if (idx >= 0) links.splice(idx, 1);
          }
          links.push({
            MarkerId: markerId,
            Text: box.text,
            PmTaskId: existing.PmTaskId,
          });
        }
        parentTaskId = existing.PmTaskId;
        if (box.index === target.index) targetTaskId = existing.PmTaskId;
        continue;
      }
    }

    const statusId = statusIdForCandidate(statusList, box);
    if (!statusId) {
      throw Object.assign(new Error('Could not resolve PM task status'), { status: 400 });
    }

    const created = await createPmTask(params.pmUserId, {
      projectId: params.projectId,
      taskName: taskNameForPm(box, noteTitle),
      description:
        box.source === 'frontmatter'
          ? `<p>From Synapse note <strong>${noteTitle}</strong> (YAML todo)</p>`
          : `<p>From Synapse note <strong>${noteTitle}</strong></p>`,
      status: statusId,
      priority: priorityId,
      parentTaskId: parentTaskId || undefined,
      ...estimateCreateFields(box),
      synapseVaultId: params.vaultId,
      synapseNoteId: params.noteId,
      synapseMarkerId: markerId,
      synapseNoteUrl,
    });
    if (!created.ok) {
      throw Object.assign(new Error(created.data.message || 'Failed to create PM task'), {
        status: created.status,
      });
    }
    const taskId = pickTaskId(created.data);
    if (!taskId) {
      throw Object.assign(new Error('PM did not return task id'), { status: 500 });
    }
    await persistCheckboxLink({
      noteId: params.noteId,
      markerId,
      text: box.text,
      checked: box.checked,
      taskId,
      projectId: params.projectId,
    });
    links.push({ MarkerId: markerId, Text: box.text, PmTaskId: taskId });
    parentTaskId = taskId;
    createdAny = true;
    if (box.index === target.index) targetTaskId = taskId;
  }

  if (!targetTaskId) {
    throw Object.assign(new Error('Failed to create PM task'), { status: 500 });
  }

  if (body !== originalBody) {
    await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, params.noteId]);
    await snapshotRevision(params.noteId, params.pmUserId, {
      title: noteTitle,
      path: String(note.Path),
      bodyMarkdown: body,
      frontmatterJson: null,
      visibility: note.Visibility ? String(note.Visibility) : null,
    });
  }

  return {
    markerId: target.markerId,
    pmTaskId: targetTaskId,
    pmProjectId: params.projectId,
    /** Always return current body so the editor can pick up markers. */
    bodyMarkdown: body,
    openUrl: buildPmTaskOpenUrl(params.projectId, targetTaskId),
    alreadyLinked: !createdAny,
  };
}

export { buildPmTaskOpenUrl };
