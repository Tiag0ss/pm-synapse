/**
 * Associate / disassociate note checkboxes (and YAML todos) with existing PM tasks.
 */
import { pool, RowDataPacket } from '../config/database';
import { ensureCheckboxMarker } from './checkboxes';
import { ensureFrontmatterTodoIds } from './frontmatter';
import { listNoteTaskCandidates } from './noteTasks';
import { stripTrailingEstimateMeta, parseEstimateFromParenGroup } from './taskEstimate';
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
  description: string | null;
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

/** PM task ids linked on any note/checkbox in one vault (reuse allowed across notes). */
export async function linkedPmTaskIdsInVault(vaultId: number): Promise<Set<number>> {
  const ids = new Set<number>();
  const [cb] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT nct.PmTaskId
     FROM NoteCheckboxTasks nct
     INNER JOIN Notes n ON n.Id = nct.NoteId AND n.DeletedAt IS NULL
     WHERE n.VaultId = ? AND nct.PmTaskId IS NOT NULL`,
    [vaultId]
  );
  for (const row of cb) {
    const id = Number(row.PmTaskId);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT DISTINCT PmTaskId FROM Notes
     WHERE VaultId = ? AND PmTaskId IS NOT NULL AND DeletedAt IS NULL`,
    [vaultId]
  );
  for (const row of notes) {
    const id = Number(row.PmTaskId);
    if (Number.isFinite(id) && id > 0) ids.add(id);
  }
  return ids;
}

export async function listLinkablePmTasksForVault(params: {
  vaultId: number;
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
  const vaultLinked = await linkedPmTaskIdsInVault(params.vaultId);
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
        const list = listLinkablePmTasks(normalizePmProjectTasks(res.data), exclude, {
          vaultId: params.vaultId,
          vaultLinkedPmTaskIds: vaultLinked,
        });
        return list.map((t) => ({
          id: Number(t.Id),
          taskName: String(t.TaskName || `Task #${t.Id}`).trim() || `Task #${t.Id}`,
          description: t.Description != null ? String(t.Description) : null,
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

async function resolvePmTaskForLink(params: {
  pmUserId: number;
  pmTaskId: number;
  pmProjectId: number;
  defaultProjectId: number;
}): Promise<{ task: PmTaskSummary; projectId: number } | null> {
  const projectIds = [
    params.pmProjectId,
    params.defaultProjectId,
  ].filter((id, i, arr) => Number.isFinite(id) && id > 0 && arr.indexOf(id) === i);

  for (const projectId of projectIds) {
    const res = await fetchPmProjectTasks(params.pmUserId, projectId);
    if (!res.ok) continue;
    const task = findTaskById(normalizePmProjectTasks(res.data), params.pmTaskId);
    if (task) return { task, projectId };
  }
  return null;
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

  const resolved = await resolvePmTaskForLink({
    pmUserId: params.pmUserId,
    pmTaskId: params.pmTaskId,
    pmProjectId: params.pmProjectId,
    defaultProjectId: params.defaultProjectId,
  });
  if (!resolved) {
    throw Object.assign(new Error('PM task not found in the selected project'), { status: 404 });
  }
  const task = resolved.task;
  const linkedProjectId = resolved.projectId;

  const vaultLinked = await linkedPmTaskIdsInVault(params.vaultId);
  const reuseInVault = vaultLinked.has(params.pmTaskId);

  if (!reuseInVault) {
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
  }

  await persistCheckboxLink({
    noteId: params.noteId,
    markerId: prepared.markerId,
    text: prepared.text,
    checked: prepared.checked,
    taskId: params.pmTaskId,
    projectId: linkedProjectId,
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
    pmProjectId: linkedProjectId,
    reuseInVault,
  });

  return {
    markerId: prepared.markerId,
    pmTaskId: params.pmTaskId,
    pmProjectId: linkedProjectId,
    openUrl: buildPmTaskOpenUrl(linkedProjectId, params.pmTaskId),
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

function stripHtmlText(raw: string): string {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/** Normalize checkbox / PM task text for description matching. */
export function normalizePmMatchKey(raw: string): string {
  let s = stripHtmlText(raw);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g, '$1');
  s = s.replace(/[*_~`>#]/g, ' ');
  try {
    s = s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  } catch {
    /* older runtimes without \p{M} */
  }
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s;
}

function tokenSet(key: string): Set<string> {
  return new Set(
    key
      .split(' ')
      .map((t) => t.trim())
      .filter((t) => t.length >= 2)
  );
}

function tokenOverlapScore(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) {
    if (tb.has(t)) inter += 1;
  }
  const union = ta.size + tb.size - inter;
  if (union <= 0) return 0;
  const jaccard = inter / union;
  if (jaccard >= 0.92) return 95;
  if (jaccard >= 0.8) return 88;
  if (jaccard >= 0.65) return 76;
  if (jaccard >= 0.5) return 68;
  return 0;
}

function checkboxMatchKey(text: string): string {
  let plain = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/~~([\s\S]*?)~~/g, '$1')
    .trim();
  const trailing = plain.match(/^(.*?)(\s*)\(([^)]*)\)\s*$/);
  if (trailing) {
    const meta = parseEstimateFromParenGroup(trailing[3]);
    if (meta.estimatedHours != null || meta.unscheduledWork === true) {
      plain = stripTrailingEstimateMeta(plain).text;
    } else if (meta.category) {
      plain = trailing[1].trim();
    } else {
      plain = stripTrailingEstimateMeta(plain).text;
    }
  } else {
    plain = stripTrailingEstimateMeta(plain).text;
  }
  return normalizePmMatchKey(plain);
}

function scorePmTaskMatch(checkboxKey: string, task: LinkablePmTaskRow): number {
  if (!checkboxKey || checkboxKey.length < 2) return 0;
  const nameKey = normalizePmMatchKey(task.taskName);
  const descKey = normalizePmMatchKey(task.description || '');
  let best = 0;
  if (nameKey && nameKey === checkboxKey) best = Math.max(best, 100);
  if (nameKey && nameKey.includes(checkboxKey) && checkboxKey.length >= 3) best = Math.max(best, 85);
  if (nameKey && checkboxKey.includes(nameKey) && nameKey.length >= 3) best = Math.max(best, 82);
  if (descKey && descKey.includes(checkboxKey) && checkboxKey.length >= 4) best = Math.max(best, 78);
  if (descKey && checkboxKey.includes(descKey) && descKey.length >= 6) best = Math.max(best, 74);
  if (nameKey) best = Math.max(best, tokenOverlapScore(checkboxKey, nameKey));
  if (descKey) best = Math.max(best, tokenOverlapScore(checkboxKey, descKey));
  return best;
}

type ScoredPmTask = { task: LinkablePmTaskRow; score: number; nameKey: string };

function rankPmTaskMatches(
  checkboxKey: string,
  tasks: LinkablePmTaskRow[],
  defaultProjectId: number
): ScoredPmTask[] {
  const scored: ScoredPmTask[] = [];
  for (const task of tasks) {
    const score = scorePmTaskMatch(checkboxKey, task);
    if (score <= 0) continue;
    scored.push({
      task,
      score,
      nameKey: normalizePmMatchKey(task.taskName),
    });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.task.projectId === defaultProjectId && b.task.projectId !== defaultProjectId) return -1;
    if (b.task.projectId === defaultProjectId && a.task.projectId !== defaultProjectId) return 1;
    return a.task.id - b.task.id;
  });
  return scored;
}

function pickPmTaskMatch(
  checkboxKey: string,
  tasks: LinkablePmTaskRow[],
  defaultProjectId: number,
  options?: { usedTaskIds?: Set<number>; reuseAllowed?: Set<number> }
): { task: LinkablePmTaskRow | null; ambiguous: boolean } {
  const usedTaskIds = options?.usedTaskIds ?? new Set<number>();
  const reuseAllowed = options?.reuseAllowed ?? new Set<number>();
  const available = (row: ScoredPmTask) => reuseAllowed.has(row.task.id) || !usedTaskIds.has(row.task.id);

  const ranked = rankPmTaskMatches(checkboxKey, tasks, defaultProjectId).filter(available);
  if (!ranked.length) return { task: null, ambiguous: false };
  const bestScore = ranked[0].score;
  if (bestScore < 65) return { task: null, ambiguous: false };

  const topTier = ranked.filter((r) => r.score >= bestScore - (bestScore >= 95 ? 0 : 4));
  const bestName = topTier[0].nameKey;
  const sameNamePool = topTier.filter((r) => r.nameKey === bestName);

  if (bestScore >= 95 || sameNamePool.length === topTier.length) {
    return { task: sameNamePool[0]?.task ?? topTier[0].task, ambiguous: false };
  }

  if (topTier.length > 1) {
    return { task: null, ambiguous: true };
  }
  return { task: topTier[0].task, ambiguous: false };
}

type VaultCheckboxRef = {
  pmTaskId: number;
  pmProjectId: number;
  textKey: string;
  noteId: number;
};

/** Linked checkboxes on other notes in the same vault (match source for auto-link). */
async function listVaultCheckboxRefsFromOtherNotes(
  vaultId: number,
  noteId: number
): Promise<VaultCheckboxRef[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT nct.PmTaskId, nct.PmProjectId, nct.Text, n.Id AS NoteId
     FROM NoteCheckboxTasks nct
     INNER JOIN Notes n ON n.Id = nct.NoteId AND n.DeletedAt IS NULL
     WHERE n.VaultId = ? AND n.Id != ? AND nct.PmTaskId IS NOT NULL`,
    [vaultId, noteId]
  );
  const out: VaultCheckboxRef[] = [];
  for (const row of rows) {
    const pmTaskId = Number(row.PmTaskId);
    const pmProjectId = Number(row.PmProjectId);
    if (!Number.isFinite(pmTaskId) || pmTaskId <= 0) continue;
    const textKey = checkboxMatchKey(String(row.Text || ''));
    if (!textKey) continue;
    out.push({
      pmTaskId,
      pmProjectId: Number.isFinite(pmProjectId) && pmProjectId > 0 ? pmProjectId : 0,
      textKey,
      noteId: Number(row.NoteId),
    });
  }
  return out;
}

/** PM task ids that may link to more than one checkbox (single link per text/name key in vault). */
function computeReuseAllowedPmTaskIds(
  vaultRefs: VaultCheckboxRef[],
  linkableTasks: LinkablePmTaskRow[],
  vaultLinkedIds: Set<number>
): Set<number> {
  const byTextKey = new Map<string, Set<number>>();
  for (const ref of vaultRefs) {
    if (!byTextKey.has(ref.textKey)) byTextKey.set(ref.textKey, new Set());
    byTextKey.get(ref.textKey)!.add(ref.pmTaskId);
  }
  const reuse = new Set<number>();
  for (const ids of byTextKey.values()) {
    if (ids.size === 1) reuse.add([...ids][0]);
  }
  const byNameKey = new Map<string, Set<number>>();
  for (const t of linkableTasks) {
    if (!vaultLinkedIds.has(t.id)) continue;
    const nameKey = normalizePmMatchKey(t.taskName);
    if (!nameKey) continue;
    if (!byNameKey.has(nameKey)) byNameKey.set(nameKey, new Set());
    byNameKey.get(nameKey)!.add(t.id);
  }
  for (const ids of byNameKey.values()) {
    if (ids.size === 1) reuse.add([...ids][0]);
  }
  return reuse;
}

function pickVaultCheckboxRef(
  key: string,
  vaultRefs: VaultCheckboxRef[],
  usedTaskIds: Set<number>,
  reuseAllowed: Set<number>
): VaultCheckboxRef | null {
  const matches = vaultRefs.filter((r) => r.textKey === key);
  if (!matches.length) return null;

  const distinctIds = new Set(matches.map((m) => m.pmTaskId));
  if (distinctIds.size === 1) {
    return matches[0];
  }

  const unused = matches.filter((m) => !usedTaskIds.has(m.pmTaskId));
  if (!unused.length) return null;

  unused.sort((a, b) => {
    if (reuseAllowed.has(a.pmTaskId) && !reuseAllowed.has(b.pmTaskId)) return -1;
    if (reuseAllowed.has(b.pmTaskId) && !reuseAllowed.has(a.pmTaskId)) return 1;
    return a.pmTaskId - b.pmTaskId;
  });
  return unused[0];
}

function pickVaultLinkedTaskByName(
  key: string,
  linkableTasks: LinkablePmTaskRow[],
  vaultLinkedIds: Set<number>,
  usedTaskIds: Set<number>,
  reuseAllowed: Set<number>,
  defaultProjectId: number
): LinkablePmTaskRow | null {
  const matches = linkableTasks.filter(
    (t) =>
      vaultLinkedIds.has(t.id) &&
      normalizePmMatchKey(t.taskName) === key &&
      (reuseAllowed.has(t.id) || !usedTaskIds.has(t.id))
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    if (a.projectId === defaultProjectId && b.projectId !== defaultProjectId) return -1;
    if (b.projectId === defaultProjectId && a.projectId !== defaultProjectId) return 1;
    return a.id - b.id;
  });
  return matches[0];
}

function resolveLinkableTaskRow(
  ref: VaultCheckboxRef,
  linkableById: Map<number, LinkablePmTaskRow>
): LinkablePmTaskRow {
  const row = linkableById.get(ref.pmTaskId);
  if (row) return row;
  const projectId = ref.pmProjectId > 0 ? ref.pmProjectId : 0;
  return {
    id: ref.pmTaskId,
    taskName: `Task #${ref.pmTaskId}`,
    description: null,
    statusName: null,
    projectId,
    projectName: '',
    openUrl: projectId > 0 ? buildPmTaskOpenUrl(projectId, ref.pmTaskId) : '',
  };
}

function notePmTaskIdAfterLink(
  pick: LinkablePmTaskRow,
  usedTaskIds: Set<number>,
  reuseAllowed: Set<number>
): void {
  if (!reuseAllowed.has(pick.id)) {
    usedTaskIds.add(pick.id);
  }
}

export function suggestPmTaskForCheckbox(
  checkboxText: string,
  tasks: LinkablePmTaskRow[],
  defaultProjectId = 0
): LinkablePmTaskRow | null {
  const key = checkboxMatchKey(checkboxText);
  if (!key) return null;
  const { task } = pickPmTaskMatch(key, tasks, defaultProjectId);
  return task;
}

export async function autoLinkCheckboxesByDescription(params: {
  vaultId: number;
  noteId: number;
  pmUserId: number;
  defaultProjectId: number;
  organizationId: number;
}): Promise<{
  linked: Array<{ index: number; pmTaskId: number; taskName: string }>;
  unmatched: Array<{ index: number; text: string }>;
  ambiguous: Array<{ index: number; text: string }>;
  failed: Array<{ index: number; text: string; message: string }>;
}> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    'SELECT Id, BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL',
    [params.noteId, params.vaultId]
  );
  if (!notes.length) {
    throw Object.assign(new Error('Note not found'), { status: 404 });
  }

  const body = String(notes[0].BodyMarkdown || '');
  const candidates = listNoteTaskCandidates(body);
  const [linkRows] = await pool.execute<RowDataPacket[]>(
    'SELECT MarkerId, PmTaskId FROM NoteCheckboxTasks WHERE NoteId = ?',
    [params.noteId]
  );
  const linkedMarkers = new Set(
    linkRows
      .filter((r) => r.PmTaskId != null && Number(r.PmTaskId) > 0)
      .map((r) => String(r.MarkerId))
  );

  const vaultLinkedIds = await linkedPmTaskIdsInVault(params.vaultId);
  const vaultRefs = await listVaultCheckboxRefsFromOtherNotes(params.vaultId, params.noteId);
  const { tasks: linkableTasks } = await listLinkablePmTasksForVault({
    vaultId: params.vaultId,
    pmUserId: params.pmUserId,
    defaultProjectId: params.defaultProjectId,
    organizationId: params.organizationId,
  });
  const reuseAllowed = computeReuseAllowedPmTaskIds(vaultRefs, linkableTasks, vaultLinkedIds);
  const linkableById = new Map(linkableTasks.map((t) => [t.id, t]));

  const linked: Array<{ index: number; pmTaskId: number; taskName: string }> = [];
  const unmatched: Array<{ index: number; text: string }> = [];
  const ambiguous: Array<{ index: number; text: string }> = [];
  const failed: Array<{ index: number; text: string; message: string }> = [];
  const usedTaskIds = new Set<number>();

  for (const box of candidates) {
    if (box.markerId && linkedMarkers.has(box.markerId)) continue;
    const key = checkboxMatchKey(box.taskText || box.text);
    if (!key) {
      unmatched.push({ index: box.index, text: box.text });
      continue;
    }

    let resolved: LinkablePmTaskRow | null = null;
    let isAmbiguous = false;

    const vaultRef = pickVaultCheckboxRef(key, vaultRefs, usedTaskIds, reuseAllowed);
    if (vaultRef) {
      resolved = resolveLinkableTaskRow(vaultRef, linkableById);
    }

    if (!resolved) {
      resolved = pickVaultLinkedTaskByName(
        key,
        linkableTasks,
        vaultLinkedIds,
        usedTaskIds,
        reuseAllowed,
        params.defaultProjectId
      );
    }

    if (!resolved) {
      const pick = pickPmTaskMatch(key, linkableTasks, params.defaultProjectId, {
        usedTaskIds,
        reuseAllowed,
      });
      resolved = pick.task;
      isAmbiguous = pick.ambiguous;
    }

    if (!resolved) {
      if (isAmbiguous) ambiguous.push({ index: box.index, text: box.text });
      else unmatched.push({ index: box.index, text: box.text });
      continue;
    }

    const pmProjectId =
      resolved.projectId > 0 ? resolved.projectId : params.defaultProjectId;

    try {
      await linkCheckboxToPmTask({
        vaultId: params.vaultId,
        noteId: params.noteId,
        checkboxIndex: box.index,
        pmTaskId: resolved.id,
        pmProjectId,
        pmUserId: params.pmUserId,
        defaultProjectId: params.defaultProjectId,
        organizationId: params.organizationId,
      });
      notePmTaskIdAfterLink(resolved, usedTaskIds, reuseAllowed);
      linked.push({ index: box.index, pmTaskId: resolved.id, taskName: resolved.taskName });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Link failed';
      logger.warn('Auto-link checkbox failed', {
        noteId: params.noteId,
        checkboxIndex: box.index,
        pmTaskId: resolved.id,
        message,
      });
      failed.push({ index: box.index, text: box.text, message });
    }
  }

  if (failed.length) {
    logger.info('Auto-link completed with failures', {
      noteId: params.noteId,
      linked: linked.length,
      failed: failed.length,
    });
  }

  return { linked, unmatched, ambiguous, failed };
}
