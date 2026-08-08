/**
 * Associate / disassociate note checkboxes (and YAML todos) with existing PM tasks.
 */
import { pool, RowDataPacket } from '../config/database';
import { ensureCheckboxMarker } from './checkboxes';
import { ensureFrontmatterTodoIds } from './frontmatter';
import { listNoteTaskCandidates } from './noteTasks';
import {
  buildPmTaskOpenUrl,
  buildSynapseNoteUrl,
  fetchPmProjectTasks,
  fetchPmProjects,
  isPmTaskSynapseLinked,
  listLinkablePmTasks,
  normalizePmProjectList,
  normalizePmProjectTasks,
  updatePmTask,
  type PmTaskSummary,
} from './pmClient';
import {
  clearCheckboxPmLink,
  persistCheckboxLink,
} from './pushCheckboxTasks';
import {
  loadNoteCheckboxLinks,
  syncNoteCheckboxesFromPm,
} from './pmCheckboxSync';
import logger from '../utils/logger';

export type LinkablePmTaskRow = {
  id: number;
  taskName: string;
  statusName: string | null;
  projectId: number;
  projectName: string;
  openUrl: string;
};

export type LinkablePmProjectRow = {
  id: number;
  name: string;
};

/** Any PM task id already linked in Synapse (any vault/project). */
async function linkedPmTaskIdsInSynapse(): Promise<Set<number>> {
  const ids = new Set<number>();
  const [cb] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT PmTaskId FROM NoteCheckboxTasks WHERE PmTaskId IS NOT NULL`
  );
  for (const row of cb) {
    const id = Number(row.PmTaskId);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT PmTaskId FROM Notes WHERE PmTaskId IS NOT NULL AND DeletedAt IS NULL`
  );
  for (const row of notes) {
    const id = Number(row.PmTaskId);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return ids;
}

export async function listLinkablePmTasksForVault(params: {
  pmUserId: number;
  /** Vault default project (preferred / first in project list). */
  defaultProjectId: number;
  organizationId: number;
  /** When set, only return tasks from this project. */
  projectId?: number | null;
}): Promise<{
  projects: LinkablePmProjectRow[];
  tasks: LinkablePmTaskRow[];
  defaultProjectId: number;
}> {
  const projectsRes = await fetchPmProjects(params.pmUserId, params.organizationId);
  if (!projectsRes.ok) {
    throw Object.assign(new Error(projectsRes.data.message || 'Failed to fetch PM projects'), {
      status: projectsRes.status || 502,
    });
  }
  const projects = normalizePmProjectList(projectsRes.data);
  const projectRows: LinkablePmProjectRow[] = projects.map((p) => ({
    id: Number(p.Id),
    name: String(p.ProjectName || p.Name || `Project #${p.Id}`).trim() || `Project #${p.Id}`,
  }));

  projectRows.sort((a, b) => {
    if (a.id === params.defaultProjectId) return -1;
    if (b.id === params.defaultProjectId) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const filterProjectId =
    params.projectId != null && Number(params.projectId) > 0 ? Number(params.projectId) : null;
  const targets = filterProjectId
    ? projectRows.filter((p) => p.id === filterProjectId)
    : projectRows;

  if (filterProjectId && targets.length === 0) {
    throw Object.assign(new Error('Project not found in this organization'), { status: 404 });
  }

  const exclude = await linkedPmTaskIdsInSynapse();
  const tasks: LinkablePmTaskRow[] = [];
  const concurrency = 4;
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (proj) => {
        const res = await fetchPmProjectTasks(params.pmUserId, proj.id);
        if (!res.ok) {
          logger.warn('Could not fetch tasks for linkable list', {
            projectId: proj.id,
            message: res.data.message,
          });
          return [] as LinkablePmTaskRow[];
        }
        const list = listLinkablePmTasks(normalizePmProjectTasks(res.data), exclude);
        return list.map((t) => ({
          id: Number(t.Id),
          taskName: String(t.TaskName || `Task #${t.Id}`).trim() || `Task #${t.Id}`,
          statusName: t.StatusName != null ? String(t.StatusName) : null,
          projectId: proj.id,
          projectName: proj.name,
          openUrl: buildPmTaskOpenUrl(proj.id, Number(t.Id)),
        }));
      })
    );
    for (const rows of results) tasks.push(...rows);
  }

  return {
    projects: projectRows,
    tasks,
    defaultProjectId: params.defaultProjectId,
  };
}

async function prepareCheckboxForLink(params: {
  vaultId: number;
  noteId: number;
  checkboxIndex: number;
}): Promise<{
  body: string;
  markerId: string;
  text: string;
  checked: boolean;
  alreadyPmTaskId: number | null;
}> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
    [params.noteId, params.vaultId]
  );
  if (!notes.length) {
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }
  let body = String(notes[0].BodyMarkdown || '');
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
  }

  candidates = listNoteTaskCandidates(body);
  const target = candidates[params.checkboxIndex];
  if (!target?.markerId) {
    throw Object.assign(new Error('Task not found after marker'), { status: 404 });
  }

  if (body !== String(notes[0].BodyMarkdown || '')) {
    await pool.execute('UPDATE Notes SET BodyMarkdown = ? WHERE Id = ?', [body, params.noteId]);
  }

  const [linkRows] = await pool.execute<RowDataPacket[]>(
    'SELECT PmTaskId FROM NoteCheckboxTasks WHERE NoteId = ? AND MarkerId = ?',
    [params.noteId, target.markerId]
  );
  const already =
    linkRows.length && linkRows[0].PmTaskId != null ? Number(linkRows[0].PmTaskId) : null;

  return {
    body,
    markerId: target.markerId,
    text: target.text,
    checked: target.checked,
    alreadyPmTaskId: already != null && Number.isFinite(already) && already > 0 ? already : null,
  };
}

function findTaskById(tasks: PmTaskSummary[], pmTaskId: number): PmTaskSummary | null {
  return tasks.find((t) => Number(t.Id) === pmTaskId) || null;
}

export async function linkCheckboxToPmTask(params: {
  vaultId: number;
  noteId: number;
  checkboxIndex: number;
  pmTaskId: number;
  /** Project that owns the PM task (may differ from the vault’s linked project). */
  pmProjectId: number;
  pmUserId: number;
  /** Vault default project — used for pull-sync fallback / note nesting context. */
  defaultProjectId: number;
  organizationId: number | null;
}): Promise<{
  markerId: string;
  pmTaskId: number;
  pmProjectId: number;
  openUrl: string;
  bodyMarkdown: string;
}> {
  const prepared = await prepareCheckboxForLink({
    vaultId: params.vaultId,
    noteId: params.noteId,
    checkboxIndex: params.checkboxIndex,
  });
  if (prepared.alreadyPmTaskId) {
    throw Object.assign(new Error('Checkbox already linked to a PM task'), {
      status: 409,
      data: {
        pmTaskId: prepared.alreadyPmTaskId,
        openUrl: buildPmTaskOpenUrl(params.pmProjectId, prepared.alreadyPmTaskId),
      },
    });
  }

  const res = await fetchPmProjectTasks(params.pmUserId, params.pmProjectId);
  if (!res.ok) {
    throw Object.assign(new Error(res.data.message || 'Failed to fetch PM tasks'), {
      status: res.status || 502,
    });
  }
  const tasks = normalizePmProjectTasks(res.data);
  const task = findTaskById(tasks, params.pmTaskId);
  if (!task) {
    throw Object.assign(new Error('PM task not found in the selected project'), { status: 404 });
  }
  if (isPmTaskSynapseLinked(task)) {
    throw Object.assign(new Error('PM task already has a Synapse reference'), { status: 409 });
  }

  const exclude = await linkedPmTaskIdsInSynapse();
  if (exclude.has(params.pmTaskId)) {
    throw Object.assign(new Error('PM task is already linked in Synapse'), { status: 409 });
  }

  const synapseNoteUrl = buildSynapseNoteUrl(params.vaultId, params.noteId);
  const upd = await updatePmTask(params.pmUserId, params.pmTaskId, {
    synapseVaultId: params.vaultId,
    synapseNoteId: params.noteId,
    synapseMarkerId: prepared.markerId,
    synapseNoteUrl,
  });
  if (!upd.ok) {
    throw Object.assign(new Error(upd.data.message || 'Failed to set Synapse refs on PM task'), {
      status: upd.status || 502,
    });
  }

  await persistCheckboxLink({
    noteId: params.noteId,
    markerId: prepared.markerId,
    text: prepared.text,
    checked: prepared.checked,
    taskId: params.pmTaskId,
    projectId: params.pmProjectId,
  });

  let body = prepared.body;
  const links = await loadNoteCheckboxLinks(params.noteId);
  const synced = await syncNoteCheckboxesFromPm({
    pmUserId: params.pmUserId,
    noteId: params.noteId,
    bodyMarkdown: body,
    links,
    defaultProjectId: params.defaultProjectId,
    organizationId: params.organizationId,
  });
  body = synced.bodyMarkdown;

  logger.info('Linked checkbox to existing PM task', {
    noteId: params.noteId,
    markerId: prepared.markerId,
    pmTaskId: params.pmTaskId,
    pmProjectId: params.pmProjectId,
  });

  return {
    markerId: prepared.markerId,
    pmTaskId: params.pmTaskId,
    pmProjectId: params.pmProjectId,
    openUrl: buildPmTaskOpenUrl(params.pmProjectId, params.pmTaskId),
    bodyMarkdown: body,
  };
}

export async function unlinkCheckboxFromPmTask(params: {
  vaultId: number;
  noteId: number;
  checkboxIndex?: number;
  markerId?: string;
  pmUserId: number;
  projectId: number;
}): Promise<{ clearedPmTaskId: number; markerId: string }> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
    [params.noteId, params.vaultId]
  );
  if (!notes.length) {
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }

  let markerId = params.markerId ? String(params.markerId) : '';
  if (!markerId) {
    if (params.checkboxIndex == null) {
      throw Object.assign(new Error('index or markerId required'), { status: 400 });
    }
    const candidates = listNoteTaskCandidates(String(notes[0].BodyMarkdown || ''));
    const target = candidates[params.checkboxIndex];
    if (!target?.markerId) {
      throw Object.assign(new Error('Checkbox not found'), { status: 404 });
    }
    markerId = target.markerId;
  }

  const [linkRows] = await pool.execute<RowDataPacket[]>(
    'SELECT PmTaskId FROM NoteCheckboxTasks WHERE NoteId = ? AND MarkerId = ?',
    [params.noteId, markerId]
  );
  const pmTaskId =
    linkRows.length && linkRows[0].PmTaskId != null ? Number(linkRows[0].PmTaskId) : null;
  if (pmTaskId == null || !Number.isFinite(pmTaskId) || pmTaskId <= 0) {
    throw Object.assign(new Error('Checkbox is not linked to a PM task'), { status: 400 });
  }

  await clearCheckboxPmLink(params.noteId, markerId);

  const cleared = await updatePmTask(params.pmUserId, pmTaskId, { clearSynapseLink: true });
  if (!cleared.ok) {
    logger.warn('Cleared Synapse link but failed to clear PM Synapse refs', {
      noteId: params.noteId,
      markerId,
      pmTaskId,
      message: cleared.data.message,
    });
    throw Object.assign(
      new Error(cleared.data.message || 'Unlinked locally but failed to clear PM Synapse refs'),
      { status: cleared.status || 502 }
    );
  }

  logger.info('Unlinked checkbox from PM task', {
    noteId: params.noteId,
    markerId,
    pmTaskId,
  });

  return { clearedPmTaskId: pmTaskId, markerId };
}
