/** Password-share Q&A answers + append-only audit events. */
import crypto from 'crypto';
import { pool, ResultSetHeader, RowDataPacket } from '../config/database';
import { noteHasAskMarker } from './askBlocks';

export type AskAnswerStatus = 'pending' | 'approved' | 'rejected';
export type AskEventType = 'submitted' | 'approved' | 'unapproved' | 'rejected' | 'deleted' | 'edited';
export type AskActorKind = 'share_guest' | 'owner';

export type AskAnswerRow = {
  id: number;
  noteId: number;
  vaultId: number;
  askMarkerId: string;
  body: string;
  authorName: string;
  status: AskAnswerStatus;
  shareLinkId: number | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AskAnswerEventRow = {
  id: number;
  answerId: number;
  noteId: number;
  vaultId: number;
  askMarkerId: string;
  eventType: AskEventType;
  actorKind: AskActorKind;
  actorLabel: string;
  actorPmUserId: number | null;
  shareLinkId: number | null;
  payload: AskEventPayload;
  createdAt: string;
};

export type AskEventPayload = {
  body?: string;
  authorName?: string;
  fromStatus?: AskAnswerStatus;
  toStatus?: AskAnswerStatus;
  previousBody?: string;
  previousAuthorName?: string;
};

export function buildAskEventPayload(parts: AskEventPayload): string {
  return JSON.stringify({
    ...(parts.body !== undefined ? { body: parts.body } : {}),
    ...(parts.authorName !== undefined ? { authorName: parts.authorName } : {}),
    ...(parts.fromStatus !== undefined ? { fromStatus: parts.fromStatus } : {}),
    ...(parts.toStatus !== undefined ? { toStatus: parts.toStatus } : {}),
    ...(parts.previousBody !== undefined ? { previousBody: parts.previousBody } : {}),
    ...(parts.previousAuthorName !== undefined
      ? { previousAuthorName: parts.previousAuthorName }
      : {}),
  });
}

export function parseAskEventPayload(raw: unknown): AskEventPayload {
  if (raw == null || raw === '') return {};
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return {};
    const o = obj as Record<string, unknown>;
    const out: AskEventPayload = {};
    if (typeof o.body === 'string') out.body = o.body;
    if (typeof o.authorName === 'string') out.authorName = o.authorName;
    if (o.fromStatus === 'pending' || o.fromStatus === 'approved' || o.fromStatus === 'rejected') {
      out.fromStatus = o.fromStatus;
    }
    if (o.toStatus === 'pending' || o.toStatus === 'approved' || o.toStatus === 'rejected') {
      out.toStatus = o.toStatus;
    }
    if (typeof o.previousBody === 'string') out.previousBody = o.previousBody;
    if (typeof o.previousAuthorName === 'string') out.previousAuthorName = o.previousAuthorName;
    return out;
  } catch {
    return {};
  }
}

export function hashGuestEditToken(raw: string): string {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

export function newGuestEditToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Share viewer: non-deleted answers, any status. */
export function filterAskAnswersForShare<T extends { deletedAt?: string | null; DeletedAt?: unknown }>(
  answers: T[]
): T[] {
  return answers.filter((a) => {
    const deleted = a.deletedAt ?? a.DeletedAt ?? null;
    return deleted == null || deleted === '';
  });
}

/** Wiki / read-only preview: approved + non-deleted only. */
export function filterAskAnswersForWikiPreview<
  T extends { status?: string; Status?: unknown; deletedAt?: string | null; DeletedAt?: unknown },
>(answers: T[]): T[] {
  return filterAskAnswersForShare(answers).filter((a) => {
    const status = String(a.status ?? a.Status ?? '');
    return status === 'approved';
  });
}

/** Guest may mutate only while pending and non-deleted. */
export function guestCanMutateAskAnswer(answer: {
  status?: string;
  deletedAt?: string | null;
}): boolean {
  return String(answer.status || '') === 'pending' && !answer.deletedAt;
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return String(v || '');
}

function mapAnswer(row: RowDataPacket): AskAnswerRow {
  const raw = String(row.Status || '');
  const status: AskAnswerStatus =
    raw === 'approved' ? 'approved' : raw === 'rejected' ? 'rejected' : 'pending';
  return {
    id: Number(row.Id),
    noteId: Number(row.NoteId),
    vaultId: Number(row.VaultId),
    askMarkerId: String(row.AskMarkerId),
    body: String(row.Body || ''),
    authorName: String(row.AuthorName || 'Anonymous'),
    status,
    shareLinkId: row.ShareLinkId != null ? Number(row.ShareLinkId) : null,
    deletedAt: row.DeletedAt != null ? toIso(row.DeletedAt) : null,
    createdAt: toIso(row.CreatedAt),
    updatedAt: toIso(row.UpdatedAt),
  };
}

function mapEvent(row: RowDataPacket): AskAnswerEventRow {
  const eventType = String(row.EventType) as AskEventType;
  const actorKind = String(row.ActorKind) === 'owner' ? 'owner' : 'share_guest';
  return {
    id: Number(row.Id),
    answerId: Number(row.AnswerId),
    noteId: Number(row.NoteId),
    vaultId: Number(row.VaultId),
    askMarkerId: String(row.AskMarkerId),
    eventType,
    actorKind,
    actorLabel: String(row.ActorLabel || ''),
    actorPmUserId: row.ActorPmUserId != null ? Number(row.ActorPmUserId) : null,
    shareLinkId: row.ShareLinkId != null ? Number(row.ShareLinkId) : null,
    payload: parseAskEventPayload(row.PayloadJson),
    createdAt: toIso(row.CreatedAt),
  };
}

async function insertEvent(params: {
  answerId: number;
  noteId: number;
  vaultId: number;
  askMarkerId: string;
  eventType: AskEventType;
  actorKind: AskActorKind;
  actorLabel: string;
  actorPmUserId?: number | null;
  shareLinkId?: number | null;
  payload: AskEventPayload;
}): Promise<void> {
  await pool.execute(
    `INSERT INTO NoteAskAnswerEvents
      (AnswerId, NoteId, VaultId, AskMarkerId, EventType, ActorKind, ActorLabel, ActorPmUserId, ShareLinkId, PayloadJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.answerId,
      params.noteId,
      params.vaultId,
      params.askMarkerId,
      params.eventType,
      params.actorKind,
      params.actorLabel.slice(0, 255),
      params.actorPmUserId ?? null,
      params.shareLinkId ?? null,
      buildAskEventPayload(params.payload),
    ]
  );
}

export function groupAnswersByAskId(answers: AskAnswerRow[]): Record<string, AskAnswerRow[]> {
  const out: Record<string, AskAnswerRow[]> = {};
  for (const a of answers) {
    const key = a.askMarkerId;
    if (!out[key]) out[key] = [];
    out[key].push(a);
  }
  return out;
}

/** Non-deleted answers for a note, optionally filtered to approved-only. */
export async function listAskAnswersForNote(params: {
  noteId: number;
  vaultId: number;
  approvedOnly?: boolean;
}): Promise<AskAnswerRow[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteAskAnswers
     WHERE NoteId = ? AND VaultId = ? AND DeletedAt IS NULL
     ${params.approvedOnly ? "AND Status = 'approved'" : ''}
     ORDER BY CreatedAt ASC, Id ASC`,
    [params.noteId, params.vaultId]
  );
  return rows.map(mapAnswer);
}

export async function listAskAnswersGroupedForShare(params: {
  noteId: number;
  vaultId: number;
}): Promise<Record<string, AskAnswerRow[]>> {
  const answers = await listAskAnswersForNote(params);
  return groupAnswersByAskId(answers);
}

export async function listAskAnswersGroupedForWiki(params: {
  noteId: number;
  vaultId: number;
}): Promise<Record<string, AskAnswerRow[]>> {
  const answers = await listAskAnswersForNote({ ...params, approvedOnly: true });
  return groupAnswersByAskId(answers);
}

/** Owner: active answers + full history (including events for soft-deleted answers). */
export async function listAskAnswersWithHistory(params: {
  noteId: number;
  vaultId: number;
}): Promise<{
  answers: AskAnswerRow[];
  deletedAnswers: AskAnswerRow[];
  eventsByAnswerId: Record<string, AskAnswerEventRow[]>;
}> {
  const [answerRows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteAskAnswers
     WHERE NoteId = ? AND VaultId = ?
     ORDER BY CreatedAt ASC, Id ASC`,
    [params.noteId, params.vaultId]
  );
  const all = answerRows.map(mapAnswer);
  const answers = all.filter((a) => !a.deletedAt);
  const deletedAnswers = all.filter((a) => Boolean(a.deletedAt));

  const [eventRows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteAskAnswerEvents
     WHERE NoteId = ? AND VaultId = ?
     ORDER BY CreatedAt ASC, Id ASC`,
    [params.noteId, params.vaultId]
  );
  const eventsByAnswerId: Record<string, AskAnswerEventRow[]> = {};
  for (const ev of eventRows.map(mapEvent)) {
    const key = String(ev.answerId);
    if (!eventsByAnswerId[key]) eventsByAnswerId[key] = [];
    eventsByAnswerId[key].push(ev);
  }

  return { answers, deletedAnswers, eventsByAnswerId };
}

export async function submitShareAskAnswer(params: {
  noteId: number;
  vaultId: number;
  askMarkerId: string;
  body: string;
  authorName: string;
  shareLinkId: number;
  noteBodyMarkdown: string;
}): Promise<
  | { ok: true; answer: AskAnswerRow; guestEditToken: string }
  | { ok: false; reason: 'invalid_ask' | 'empty_body' }
> {
  const askId = String(params.askMarkerId || '').trim();
  const body = String(params.body || '').trim();
  if (!body) return { ok: false, reason: 'empty_body' };
  if (!askId || !noteHasAskMarker(params.noteBodyMarkdown, askId)) {
    return { ok: false, reason: 'invalid_ask' };
  }
  const authorName = String(params.authorName || '').trim() || 'Anonymous';
  const guestEditToken = newGuestEditToken();
  const guestEditTokenHash = hashGuestEditToken(guestEditToken);

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO NoteAskAnswers
      (NoteId, VaultId, AskMarkerId, Body, AuthorName, Status, ShareLinkId, GuestEditTokenHash)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      params.noteId,
      params.vaultId,
      askId,
      body,
      authorName.slice(0, 128),
      params.shareLinkId,
      guestEditTokenHash,
    ]
  );
  const answerId = result.insertId;
  await insertEvent({
    answerId,
    noteId: params.noteId,
    vaultId: params.vaultId,
    askMarkerId: askId,
    eventType: 'submitted',
    actorKind: 'share_guest',
    actorLabel: authorName,
    shareLinkId: params.shareLinkId,
    payload: { body, authorName, toStatus: 'pending' },
  });

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM NoteAskAnswers WHERE Id = ? LIMIT 1',
    [answerId]
  );
  return { ok: true, answer: mapAnswer(rows[0]), guestEditToken };
}

async function loadAnswerForGuestMutation(params: {
  answerId: number;
  askMarkerId: string;
  noteId: number;
  vaultId: number;
  shareLinkId: number;
  guestEditToken: string;
}): Promise<
  | { ok: true; row: RowDataPacket; answer: AskAnswerRow }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'not_pending' | 'deleted' }
> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteAskAnswers
     WHERE Id = ? AND NoteId = ? AND VaultId = ? AND AskMarkerId = ? AND ShareLinkId = ?
     LIMIT 1`,
    [params.answerId, params.noteId, params.vaultId, params.askMarkerId, params.shareLinkId]
  );
  if (!rows.length) return { ok: false, reason: 'not_found' };
  const row = rows[0];
  const storedHash = String(row.GuestEditTokenHash || '');
  const providedHash = hashGuestEditToken(params.guestEditToken);
  if (!storedHash || storedHash !== providedHash) {
    return { ok: false, reason: 'forbidden' };
  }
  const answer = mapAnswer(row);
  if (answer.deletedAt) return { ok: false, reason: 'deleted' };
  if (!guestCanMutateAskAnswer(answer)) return { ok: false, reason: 'not_pending' };
  return { ok: true, row, answer };
}

export async function updateShareAskAnswer(params: {
  answerId: number;
  askMarkerId: string;
  noteId: number;
  vaultId: number;
  shareLinkId: number;
  guestEditToken: string;
  body: string;
  authorName?: string;
}): Promise<
  | { ok: true; answer: AskAnswerRow }
  | {
      ok: false;
      reason: 'not_found' | 'forbidden' | 'not_pending' | 'deleted' | 'empty_body' | 'unchanged';
    }
> {
  const body = String(params.body || '').trim();
  if (!body) return { ok: false, reason: 'empty_body' };

  const loaded = await loadAnswerForGuestMutation(params);
  if (!loaded.ok) return loaded;

  const authorName =
    params.authorName !== undefined
      ? String(params.authorName || '').trim() || 'Anonymous'
      : loaded.answer.authorName;

  if (body === loaded.answer.body && authorName === loaded.answer.authorName) {
    return { ok: false, reason: 'unchanged' };
  }

  await pool.execute(
    `UPDATE NoteAskAnswers SET Body = ?, AuthorName = ?
     WHERE Id = ? AND NoteId = ? AND VaultId = ? AND DeletedAt IS NULL AND Status = 'pending'`,
    [body, authorName.slice(0, 128), params.answerId, params.noteId, params.vaultId]
  );
  await insertEvent({
    answerId: params.answerId,
    noteId: params.noteId,
    vaultId: params.vaultId,
    askMarkerId: loaded.answer.askMarkerId,
    eventType: 'edited',
    actorKind: 'share_guest',
    actorLabel: authorName,
    shareLinkId: params.shareLinkId,
    payload: {
      body,
      authorName,
      previousBody: loaded.answer.body,
      previousAuthorName: loaded.answer.authorName,
      fromStatus: 'pending',
      toStatus: 'pending',
    },
  });

  const [updated] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM NoteAskAnswers WHERE Id = ? LIMIT 1',
    [params.answerId]
  );
  return { ok: true, answer: mapAnswer(updated[0]) };
}

export async function softDeleteShareAskAnswer(params: {
  answerId: number;
  askMarkerId: string;
  noteId: number;
  vaultId: number;
  shareLinkId: number;
  guestEditToken: string;
}): Promise<
  | { ok: true; answer: AskAnswerRow }
  | {
      ok: false;
      reason: 'not_found' | 'forbidden' | 'not_pending' | 'deleted' | 'already_deleted';
    }
> {
  const loaded = await loadAnswerForGuestMutation(params);
  if (!loaded.ok) {
    if (loaded.reason === 'deleted') return { ok: false, reason: 'already_deleted' };
    return loaded;
  }

  await pool.execute(
    `UPDATE NoteAskAnswers SET DeletedAt = CURRENT_TIMESTAMP, GuestEditTokenHash = NULL
     WHERE Id = ? AND NoteId = ? AND VaultId = ? AND DeletedAt IS NULL AND Status = 'pending'`,
    [params.answerId, params.noteId, params.vaultId]
  );
  await insertEvent({
    answerId: params.answerId,
    noteId: params.noteId,
    vaultId: params.vaultId,
    askMarkerId: loaded.answer.askMarkerId,
    eventType: 'deleted',
    actorKind: 'share_guest',
    actorLabel: loaded.answer.authorName,
    shareLinkId: params.shareLinkId,
    payload: {
      body: loaded.answer.body,
      authorName: loaded.answer.authorName,
      fromStatus: loaded.answer.status,
    },
  });

  const [updated] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM NoteAskAnswers WHERE Id = ? LIMIT 1',
    [params.answerId]
  );
  return { ok: true, answer: mapAnswer(updated[0]) };
}

export async function setAskAnswerStatus(params: {
  answerId: number;
  noteId: number;
  vaultId: number;
  status: AskAnswerStatus;
  actorLabel: string;
  actorPmUserId: number;
}): Promise<
  | { ok: true; answer: AskAnswerRow }
  | { ok: false; reason: 'not_found' | 'deleted' | 'unchanged' }
> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteAskAnswers WHERE Id = ? AND NoteId = ? AND VaultId = ? LIMIT 1`,
    [params.answerId, params.noteId, params.vaultId]
  );
  if (!rows.length) return { ok: false, reason: 'not_found' };
  const current = mapAnswer(rows[0]);
  if (current.deletedAt) return { ok: false, reason: 'deleted' };
  if (current.status === params.status) return { ok: false, reason: 'unchanged' };

  await pool.execute(
    `UPDATE NoteAskAnswers SET Status = ? WHERE Id = ? AND NoteId = ? AND VaultId = ? AND DeletedAt IS NULL`,
    [params.status, params.answerId, params.noteId, params.vaultId]
  );
  await insertEvent({
    answerId: params.answerId,
    noteId: params.noteId,
    vaultId: params.vaultId,
    askMarkerId: current.askMarkerId,
    eventType:
      params.status === 'approved'
        ? 'approved'
        : params.status === 'rejected'
          ? 'rejected'
          : 'unapproved',
    actorKind: 'owner',
    actorLabel: params.actorLabel,
    actorPmUserId: params.actorPmUserId,
    payload: {
      body: current.body,
      authorName: current.authorName,
      fromStatus: current.status,
      toStatus: params.status,
    },
  });

  const [updated] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM NoteAskAnswers WHERE Id = ? LIMIT 1',
    [params.answerId]
  );
  return { ok: true, answer: mapAnswer(updated[0]) };
}

export async function softDeleteAskAnswer(params: {
  answerId: number;
  noteId: number;
  vaultId: number;
  actorLabel: string;
  actorPmUserId: number;
}): Promise<{ ok: true; answer: AskAnswerRow } | { ok: false; reason: 'not_found' | 'already_deleted' }> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteAskAnswers WHERE Id = ? AND NoteId = ? AND VaultId = ? LIMIT 1`,
    [params.answerId, params.noteId, params.vaultId]
  );
  if (!rows.length) return { ok: false, reason: 'not_found' };
  const current = mapAnswer(rows[0]);
  if (current.deletedAt) return { ok: false, reason: 'already_deleted' };

  await pool.execute(
    `UPDATE NoteAskAnswers SET DeletedAt = CURRENT_TIMESTAMP
     WHERE Id = ? AND NoteId = ? AND VaultId = ? AND DeletedAt IS NULL`,
    [params.answerId, params.noteId, params.vaultId]
  );
  await insertEvent({
    answerId: params.answerId,
    noteId: params.noteId,
    vaultId: params.vaultId,
    askMarkerId: current.askMarkerId,
    eventType: 'deleted',
    actorKind: 'owner',
    actorLabel: params.actorLabel,
    actorPmUserId: params.actorPmUserId,
    payload: {
      body: current.body,
      authorName: current.authorName,
      fromStatus: current.status,
    },
  });

  const [updated] = await pool.execute<RowDataPacket[]>(
    'SELECT * FROM NoteAskAnswers WHERE Id = ? LIMIT 1',
    [params.answerId]
  );
  return { ok: true, answer: mapAnswer(updated[0]) };
}
