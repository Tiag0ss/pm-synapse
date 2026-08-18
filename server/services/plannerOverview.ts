import { pool, RowDataPacket } from '../config/database';
import { withStruckMarkdownText } from './checkboxes';
import { parseFrontmatter } from './frontmatter';
import { rebuildNoteGraph } from './notesGraph';
import {
  fetchPmOrganizations,
  fetchPmProjectTasks,
  fetchPmProjects,
  isPmTaskCancelled,
  isPmTaskHiddenFromPlanning,
  isPmTaskClosed,
  isPmTaskInProgress,
  normalizeOrganizationList,
  normalizePmProjectList,
  normalizePmProjectTasks,
  resolveLinkedPmUserId,
  type PmTaskSummary,
} from './pmClient';
import {
  HUB_NOTE_PATH,
  HUB_SEED_BODY,
  ensureHubNote,
  isPersonalWorkVault,
  isPlannerOverviewNote,
} from './personalWorkVault';
import logger from '../utils/logger';

const TASKS_START = '<!--synapse:planner-tasks-->';
const TASKS_END = '<!--/synapse:planner-tasks-->';
const LINKED_HEADING = '## Linked notes';

export { isPlannerOverviewNote };

function markerForTask(pmTaskId: number, existing?: string | null): string {
  const cur = String(existing || '').trim();
  if (cur) return cur.slice(0, 64);
  return `pm-${pmTaskId}`.slice(0, 64);
}

function sanitizeTaskLabel(name: string, fallbackId: number): string {
  const t = String(name || '')
    .replace(/\s+/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return t || `Task #${fallbackId}`;
}

function checkboxLine(task: PmTaskSummary, markerId: string): string {
  const cancelled = isPmTaskCancelled(task);
  const closed = isPmTaskClosed(task) || cancelled;
  const progress = isPmTaskInProgress(task);
  const mark = closed ? 'x' : progress ? '-' : ' ';
  const label = withStruckMarkdownText(sanitizeTaskLabel(String(task.TaskName || ''), task.Id), cancelled);
  return `- [${mark}] ${label} <!--synapse:cb:${markerId}-->`;
}

function replaceTasksBlock(markdown: string, inner: string): string {
  const source = markdown.includes(TASKS_START) ? markdown : HUB_SEED_BODY;
  const block = `${TASKS_START}\n${inner.trim()}\n${TASKS_END}`;
  if (source.includes(TASKS_START) && source.includes(TASKS_END)) {
    return source.replace(/<!--synapse:planner-tasks-->[\s\S]*?<!--\/synapse:planner-tasks-->/, block);
  }
  return `${source.replace(/\s*$/, '')}\n\n${block}\n`;
}

function ensureLinkedNotesHeading(markdown: string): string {
  if (/^## Linked notes\s*$/m.test(markdown)) return markdown;
  return `${markdown.replace(/\s*$/, '')}\n\n${LINKED_HEADING}\n`;
}

export function listLinkedNoteTitles(markdown: string): string[] {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Linked notes\s*$/.test(l));
  if (start < 0) return [];
  const titles: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) break;
    const m = lines[i].match(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}

export function addHubLinkedNote(markdown: string, title: string): string {
  const name = String(title || '').trim();
  if (!name) return markdown;
  const existing = listLinkedNoteTitles(markdown);
  if (existing.some((t) => t.toLowerCase() === name.toLowerCase())) return markdown;
  let next = ensureLinkedNotesHeading(markdown);
  const lines = next.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Linked notes\s*$/.test(l));
  let insertAt = start + 1;
  while (insertAt < lines.length && !/^#{1,6}\s+/.test(lines[insertAt])) insertAt += 1;
  lines.splice(insertAt, 0, `- [[${name}]]`);
  return lines.join('\n');
}

export function removeHubLinkedNote(markdown: string, title: string): string {
  const name = String(title || '').trim().toLowerCase();
  if (!name) return markdown;
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Linked notes\s*$/.test(l));
  if (start < 0) return markdown;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > start && !/^#{1,6}\s+/.test(lines[i])) {
      const m = lines[i].match(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/);
      if (m && m[1].trim().toLowerCase() === name) continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

type AssignedTask = PmTaskSummary & { projectId: number; projectName: string };

async function loadAssignedTasks(synapseUserId: number, pmUserId: number): Promise<AssignedTask[]> {
  const orgsRes = await fetchPmOrganizations(synapseUserId);
  if (!orgsRes.ok) {
    const err = new Error(orgsRes.data.message || 'Failed to load Planner organizations');
    (err as { status?: number }).status = orgsRes.status;
    throw err;
  }
  const orgs = normalizeOrganizationList(orgsRes.data);
  const seenProjects = new Set<number>();
  const out: AssignedTask[] = [];

  const orgIds = orgs.length ? orgs.map((o) => o.Id) : [null];
  for (const orgId of orgIds) {
    const projRes = await fetchPmProjects(synapseUserId, orgId);
    if (!projRes.ok) {
      logger.warn('Planner overview: project list failed', {
        orgId,
        status: projRes.status,
        message: projRes.data.message,
      });
      continue;
    }
    for (const project of normalizePmProjectList(projRes.data)) {
      if (seenProjects.has(project.Id)) continue;
      seenProjects.add(project.Id);
      const taskRes = await fetchPmProjectTasks(synapseUserId, project.Id);
      if (!taskRes.ok) {
        logger.warn('Planner overview: task list failed', {
          projectId: project.Id,
          status: taskRes.status,
          message: taskRes.data.message,
        });
        continue;
      }
      const projectName =
        String(project.ProjectName || project.Name || '').trim() || `Project #${project.Id}`;
      for (const task of normalizePmProjectTasks(taskRes.data)) {
        if (Number(task.AssignedTo || 0) !== pmUserId) continue;
        if (isPmTaskHiddenFromPlanning(task)) continue;
        out.push({ ...task, projectId: project.Id, projectName });
      }
    }
  }
  return out;
}

function isTaskDone(task: PmTaskSummary): boolean {
  return isPmTaskClosed(task) || isPmTaskCancelled(task);
}

function taskCompletionRank(task: PmTaskSummary): number {
  if (isTaskDone(task)) return 0;
  if (isPmTaskInProgress(task)) return 1;
  return 2;
}

function buildTasksMarkdown(
  tasks: AssignedTask[],
  markerByTaskId: Map<number, string>
): { markdown: string; rows: Array<{ markerId: string; text: string; checked: number; pmTaskId: number; pmProjectId: number }> } {
  const byProject = new Map<string, AssignedTask[]>();
  for (const t of tasks) {
    const key = t.projectName;
    const list = byProject.get(key) || [];
    list.push(t);
    byProject.set(key, list);
  }
  const names = [...byProject.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parts: string[] = [];
  const rows: Array<{
    markerId: string;
    text: string;
    checked: number;
    pmTaskId: number;
    pmProjectId: number;
  }> = [];
  for (const name of names) {
    const list = (byProject.get(name) || []).sort((a, b) => {
      const rankDiff = taskCompletionRank(a) - taskCompletionRank(b);
      if (rankDiff !== 0) return rankDiff;
      return sanitizeTaskLabel(String(a.TaskName || ''), a.Id).localeCompare(
        sanitizeTaskLabel(String(b.TaskName || ''), b.Id),
        undefined,
        { sensitivity: 'base' }
      );
    });
    if (!list.some((task) => !isTaskDone(task))) continue;
    parts.push(`## ${name}`);
    for (const task of list) {
      const markerId = markerForTask(task.Id, markerByTaskId.get(task.Id));
      const line = checkboxLine(task, markerId);
      parts.push(line);
      rows.push({
        markerId,
        text: sanitizeTaskLabel(String(task.TaskName || ''), task.Id).slice(0, 512),
        checked: isTaskDone(task) ? 1 : 0,
        pmTaskId: task.Id,
        pmProjectId: task.projectId,
      });
    }
    parts.push('');
  }
  if (!parts.length) {
    parts.push('_No Planner tasks are currently assigned to you._');
    parts.push('');
  }
  return { markdown: parts.join('\n').trim(), rows };
}

export async function refreshPlannerOverview(params: {
  vault: RowDataPacket;
  synapseUserId: number;
}): Promise<{
  noteId: number;
  bodyMarkdown: string;
  added: number;
  removed: number;
  updated: number;
}> {
  if (!isPersonalWorkVault(params.vault as Record<string, unknown>)) {
    const err = new Error('Planner overview is only available in your My work vault');
    (err as { status?: number }).status = 400;
    throw err;
  }
  const pmUserId = await resolveLinkedPmUserId(params.synapseUserId);
  if (!pmUserId) {
    const err = new Error('Connect Planner (SSO) so Synapse can match tasks assigned to you');
    (err as { status?: number }).status = 400;
    throw err;
  }

  const vaultId = Number(params.vault.Id);
  const noteId = await ensureHubNote(vaultId);
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ?',
    [noteId, vaultId]
  );
  if (!notes.length) {
    const err = new Error('Overview note not found');
    (err as { status?: number }).status = 404;
    throw err;
  }
  const body = String(notes[0].BodyMarkdown || HUB_SEED_BODY);

  const [linkRows] = await pool.execute<RowDataPacket[]>(
    'SELECT MarkerId, PmTaskId FROM NoteCheckboxTasks WHERE NoteId = ? AND PmTaskId IS NOT NULL',
    [noteId]
  );
  const markerByTaskId = new Map<number, string>();
  const previousIds = new Set<number>();
  for (const row of linkRows) {
    const tid = Number(row.PmTaskId);
    if (!Number.isFinite(tid) || tid <= 0) continue;
    previousIds.add(tid);
    markerByTaskId.set(tid, String(row.MarkerId));
  }

  const tasks = await loadAssignedTasks(params.synapseUserId, pmUserId);
  const nextIds = new Set(tasks.map((t) => t.Id));
  let added = 0;
  let removed = 0;
  let updated = 0;
  for (const id of nextIds) {
    if (previousIds.has(id)) updated += 1;
    else added += 1;
  }
  for (const id of previousIds) {
    if (!nextIds.has(id)) removed += 1;
  }

  const built = buildTasksMarkdown(tasks, markerByTaskId);
  const nextBody = replaceTasksBlock(body, built.markdown);
  const fmJson = JSON.stringify(parseFrontmatter(nextBody).data);

  await pool.execute(
    `UPDATE Notes SET BodyMarkdown = ?, FrontmatterJson = ?, Path = ?, Title = ?
     WHERE Id = ? AND VaultId = ?`,
    [nextBody, fmJson, HUB_NOTE_PATH, 'planner/overview', noteId, vaultId]
  );

  await pool.execute('DELETE FROM NoteCheckboxTasks WHERE NoteId = ?', [noteId]);
  for (const row of built.rows) {
    await pool.execute(
      `INSERT INTO NoteCheckboxTasks (NoteId, MarkerId, Text, Checked, PmTaskId, PmProjectId, PmTaskLinkedAt)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [noteId, row.markerId, row.text, row.checked, row.pmTaskId, row.pmProjectId]
    );
  }

  await rebuildNoteGraph(noteId, vaultId);
  logger.info('Planner overview refreshed', {
    vaultId,
    noteId,
    added,
    removed,
    updated,
    total: built.rows.length,
  });
  return { noteId, bodyMarkdown: nextBody, added, removed, updated };
}

export async function linkNoteToHub(params: {
  vaultId: number;
  hubNoteId: number;
  childTitle: string;
}): Promise<string> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ?',
    [params.hubNoteId, params.vaultId]
  );
  if (!notes.length) {
    const err = new Error('Overview note not found');
    (err as { status?: number }).status = 404;
    throw err;
  }
  const next = addHubLinkedNote(String(notes[0].BodyMarkdown || ''), params.childTitle);
  await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [next, params.hubNoteId]);
  await rebuildNoteGraph(params.hubNoteId, params.vaultId);
  return next;
}

export async function unlinkNoteFromHub(params: {
  vaultId: number;
  hubNoteId: number;
  childTitle: string;
}): Promise<string> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ?',
    [params.hubNoteId, params.vaultId]
  );
  if (!notes.length) {
    const err = new Error('Overview note not found');
    (err as { status?: number }).status = 404;
    throw err;
  }
  const next = removeHubLinkedNote(String(notes[0].BodyMarkdown || ''), params.childTitle);
  await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [next, params.hubNoteId]);
  await rebuildNoteGraph(params.hubNoteId, params.vaultId);
  return next;
}
