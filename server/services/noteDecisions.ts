/** Shared decision state + append-only audit events. */
import { pool, ResultSetHeader, RowDataPacket } from '../config/database';
import { getDecisionBlockByMarker, noteHasDecisionMarker } from './decisionBlocks';

export type DecisionChoiceKind = 'option' | 'custom';
export type DecisionEventType = 'chose' | 'cleared' | 'locked' | 'unlocked';
export type DecisionActorKind = 'share_guest' | 'owner';

export type DecisionRow = {
  id: number;
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  choiceKind: DecisionChoiceKind | null;
  optionIndex: number | null;
  choiceLabel: string | null;
  locked: boolean;
  authorName: string | null;
  shareLinkId: number | null;
  actorPmUserId: number | null;
  lockedAt: string | null;
  lockedByPmUserId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DecisionEventRow = {
  id: number;
  decisionId: number;
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  eventType: DecisionEventType;
  actorKind: DecisionActorKind;
  actorLabel: string;
  actorPmUserId: number | null;
  shareLinkId: number | null;
  payload: DecisionEventPayload;
  createdAt: string;
};

export type DecisionEventPayload = {
  choiceKind?: DecisionChoiceKind | null;
  optionIndex?: number | null;
  choiceLabel?: string | null;
  previousChoiceKind?: DecisionChoiceKind | null;
  previousOptionIndex?: number | null;
  previousChoiceLabel?: string | null;
  locked?: boolean;
};

export type DecisionPublicView = {
  choiceKind: DecisionChoiceKind | null;
  optionIndex: number | null;
  choiceLabel: string | null;
  locked: boolean;
  authorName: string | null;
  updatedAt: string;
};

export function buildDecisionEventPayload(parts: DecisionEventPayload): string {
  return JSON.stringify({
    ...(parts.choiceKind !== undefined ? { choiceKind: parts.choiceKind } : {}),
    ...(parts.optionIndex !== undefined ? { optionIndex: parts.optionIndex } : {}),
    ...(parts.choiceLabel !== undefined ? { choiceLabel: parts.choiceLabel } : {}),
    ...(parts.previousChoiceKind !== undefined
      ? { previousChoiceKind: parts.previousChoiceKind }
      : {}),
    ...(parts.previousOptionIndex !== undefined
      ? { previousOptionIndex: parts.previousOptionIndex }
      : {}),
    ...(parts.previousChoiceLabel !== undefined
      ? { previousChoiceLabel: parts.previousChoiceLabel }
      : {}),
    ...(parts.locked !== undefined ? { locked: parts.locked } : {}),
  });
}

export function parseDecisionEventPayload(raw: unknown): DecisionEventPayload {
  if (raw == null || raw === '') return {};
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return {};
    const o = obj as Record<string, unknown>;
    const out: DecisionEventPayload = {};
    if (o.choiceKind === 'option' || o.choiceKind === 'custom' || o.choiceKind === null) {
      out.choiceKind = o.choiceKind;
    }
    if (typeof o.optionIndex === 'number' || o.optionIndex === null) {
      out.optionIndex = o.optionIndex as number | null;
    }
    if (typeof o.choiceLabel === 'string' || o.choiceLabel === null) {
      out.choiceLabel = o.choiceLabel as string | null;
    }
    if (
      o.previousChoiceKind === 'option' ||
      o.previousChoiceKind === 'custom' ||
      o.previousChoiceKind === null
    ) {
      out.previousChoiceKind = o.previousChoiceKind;
    }
    if (typeof o.previousOptionIndex === 'number' || o.previousOptionIndex === null) {
      out.previousOptionIndex = o.previousOptionIndex as number | null;
    }
    if (typeof o.previousChoiceLabel === 'string' || o.previousChoiceLabel === null) {
      out.previousChoiceLabel = o.previousChoiceLabel as string | null;
    }
    if (typeof o.locked === 'boolean') out.locked = o.locked;
    return out;
  } catch {
    return {};
  }
}

export function decisionCanBeChanged(row: { locked?: boolean } | null | undefined): boolean {
  return !row?.locked;
}

export function resolveDecisionChoice(params: {
  options: string[];
  optionIndex?: number | null;
  customText?: string | null;
}):
  | { ok: true; choiceKind: DecisionChoiceKind; optionIndex: number | null; choiceLabel: string }
  | { ok: false; reason: 'invalid_option' | 'empty_custom' | 'missing_choice' } {
  const hasIndex = params.optionIndex != null && Number.isFinite(params.optionIndex);
  const custom = String(params.customText || '').trim();
  if (hasIndex && custom) {
    return { ok: false, reason: 'missing_choice' };
  }
  if (hasIndex) {
    const idx = Math.trunc(Number(params.optionIndex));
    if (idx < 0 || idx >= params.options.length) {
      return { ok: false, reason: 'invalid_option' };
    }
    return {
      ok: true,
      choiceKind: 'option',
      optionIndex: idx,
      choiceLabel: params.options[idx],
    };
  }
  if (custom) {
    return {
      ok: true,
      choiceKind: 'custom',
      optionIndex: null,
      choiceLabel: custom.slice(0, 8000),
    };
  }
  return { ok: false, reason: 'missing_choice' };
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return String(v || '');
}

function mapDecision(row: RowDataPacket): DecisionRow {
  const kindRaw = row.ChoiceKind == null ? null : String(row.ChoiceKind);
  const choiceKind: DecisionChoiceKind | null =
    kindRaw === 'option' || kindRaw === 'custom' ? kindRaw : null;
  return {
    id: Number(row.Id),
    noteId: Number(row.NoteId),
    vaultId: Number(row.VaultId),
    decisionMarkerId: String(row.DecisionMarkerId),
    choiceKind,
    optionIndex: row.OptionIndex != null ? Number(row.OptionIndex) : null,
    choiceLabel: row.ChoiceLabel != null ? String(row.ChoiceLabel) : null,
    locked: Boolean(Number(row.Locked)),
    authorName: row.AuthorName != null ? String(row.AuthorName) : null,
    shareLinkId: row.ShareLinkId != null ? Number(row.ShareLinkId) : null,
    actorPmUserId: row.ActorPmUserId != null ? Number(row.ActorPmUserId) : null,
    lockedAt: row.LockedAt != null ? toIso(row.LockedAt) : null,
    lockedByPmUserId: row.LockedByPmUserId != null ? Number(row.LockedByPmUserId) : null,
    createdAt: toIso(row.CreatedAt),
    updatedAt: toIso(row.UpdatedAt),
  };
}

function mapEvent(row: RowDataPacket): DecisionEventRow {
  const eventType = String(row.EventType) as DecisionEventType;
  const actorKind = String(row.ActorKind) === 'owner' ? 'owner' : 'share_guest';
  return {
    id: Number(row.Id),
    decisionId: Number(row.DecisionId),
    noteId: Number(row.NoteId),
    vaultId: Number(row.VaultId),
    decisionMarkerId: String(row.DecisionMarkerId),
    eventType,
    actorKind,
    actorLabel: String(row.ActorLabel || ''),
    actorPmUserId: row.ActorPmUserId != null ? Number(row.ActorPmUserId) : null,
    shareLinkId: row.ShareLinkId != null ? Number(row.ShareLinkId) : null,
    payload: parseDecisionEventPayload(row.PayloadJson),
    createdAt: toIso(row.CreatedAt),
  };
}

function toPublicView(row: DecisionRow): DecisionPublicView {
  return {
    choiceKind: row.choiceKind,
    optionIndex: row.optionIndex,
    choiceLabel: row.choiceLabel,
    locked: row.locked,
    authorName: row.authorName,
    updatedAt: row.updatedAt,
  };
}

async function insertEvent(params: {
  decisionId: number;
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  eventType: DecisionEventType;
  actorKind: DecisionActorKind;
  actorLabel: string;
  actorPmUserId?: number | null;
  shareLinkId?: number | null;
  payload: DecisionEventPayload;
}): Promise<void> {
  await pool.execute(
    `INSERT INTO NoteDecisionEvents
      (DecisionId, NoteId, VaultId, DecisionMarkerId, EventType, ActorKind, ActorLabel, ActorPmUserId, ShareLinkId, PayloadJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.decisionId,
      params.noteId,
      params.vaultId,
      params.decisionMarkerId,
      params.eventType,
      params.actorKind,
      params.actorLabel.slice(0, 255),
      params.actorPmUserId ?? null,
      params.shareLinkId ?? null,
      buildDecisionEventPayload(params.payload),
    ]
  );
}

export async function getDecisionForMarker(params: {
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
}): Promise<DecisionRow | null> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteDecisions
     WHERE NoteId = ? AND VaultId = ? AND DecisionMarkerId = ?
     LIMIT 1`,
    [params.noteId, params.vaultId, params.decisionMarkerId]
  );
  if (!rows.length) return null;
  return mapDecision(rows[0]);
}

export async function listDecisionsForNote(params: {
  noteId: number;
  vaultId: number;
}): Promise<DecisionRow[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteDecisions WHERE NoteId = ? AND VaultId = ? ORDER BY UpdatedAt ASC`,
    [params.noteId, params.vaultId]
  );
  return rows.map(mapDecision);
}

export function groupDecisionsByMarker(
  rows: DecisionRow[]
): Record<string, DecisionPublicView> {
  const out: Record<string, DecisionPublicView> = {};
  for (const row of rows) {
    out[row.decisionMarkerId] = toPublicView(row);
  }
  return out;
}

export async function listDecisionsGroupedForShare(params: {
  noteId: number;
  vaultId: number;
}): Promise<Record<string, DecisionPublicView>> {
  const rows = await listDecisionsForNote(params);
  return groupDecisionsByMarker(rows);
}

export async function listDecisionsGroupedForWiki(params: {
  noteId: number;
  vaultId: number;
}): Promise<Record<string, DecisionPublicView>> {
  return listDecisionsGroupedForShare(params);
}

export async function listDecisionsWithHistory(params: {
  noteId: number;
  vaultId: number;
}): Promise<{
  decisions: DecisionRow[];
  eventsByMarkerId: Record<string, DecisionEventRow[]>;
}> {
  const decisions = await listDecisionsForNote(params);
  const [eventRows] = await pool.execute<RowDataPacket[]>(
    `SELECT * FROM NoteDecisionEvents
     WHERE NoteId = ? AND VaultId = ?
     ORDER BY CreatedAt ASC, Id ASC`,
    [params.noteId, params.vaultId]
  );
  const eventsByMarkerId: Record<string, DecisionEventRow[]> = {};
  for (const row of eventRows) {
    const ev = mapEvent(row);
    if (!eventsByMarkerId[ev.decisionMarkerId]) eventsByMarkerId[ev.decisionMarkerId] = [];
    eventsByMarkerId[ev.decisionMarkerId].push(ev);
  }
  return { decisions, eventsByMarkerId };
}

async function upsertChoice(params: {
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  noteBodyMarkdown: string;
  optionIndex?: number | null;
  customText?: string | null;
  authorName: string;
  actorKind: DecisionActorKind;
  actorPmUserId?: number | null;
  shareLinkId?: number | null;
}): Promise<
  | { ok: true; decision: DecisionRow }
  | {
      ok: false;
      reason:
        | 'invalid_decision'
        | 'locked'
        | 'invalid_option'
        | 'empty_custom'
        | 'missing_choice';
    }
> {
  const markerId = String(params.decisionMarkerId || '').trim();
  if (!markerId || !noteHasDecisionMarker(params.noteBodyMarkdown, markerId)) {
    return { ok: false, reason: 'invalid_decision' };
  }
  const block = getDecisionBlockByMarker(params.noteBodyMarkdown, markerId);
  if (!block) return { ok: false, reason: 'invalid_decision' };

  const resolved = resolveDecisionChoice({
    options: block.options,
    optionIndex: params.optionIndex,
    customText: params.customText,
  });
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const existing = await getDecisionForMarker({
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: markerId,
  });
  if (existing && !decisionCanBeChanged(existing)) {
    return { ok: false, reason: 'locked' };
  }

  const authorName = String(params.authorName || '').trim().slice(0, 128) || 'Anonymous';

  if (!existing) {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO NoteDecisions
        (NoteId, VaultId, DecisionMarkerId, ChoiceKind, OptionIndex, ChoiceLabel, Locked,
         AuthorName, ShareLinkId, ActorPmUserId)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        params.noteId,
        params.vaultId,
        markerId,
        resolved.choiceKind,
        resolved.optionIndex,
        resolved.choiceLabel,
        authorName,
        params.shareLinkId ?? null,
        params.actorPmUserId ?? null,
      ]
    );
    const decisionId = Number(result.insertId);
    await insertEvent({
      decisionId,
      noteId: params.noteId,
      vaultId: params.vaultId,
      decisionMarkerId: markerId,
      eventType: 'chose',
      actorKind: params.actorKind,
      actorLabel: authorName,
      actorPmUserId: params.actorPmUserId,
      shareLinkId: params.shareLinkId,
      payload: {
        choiceKind: resolved.choiceKind,
        optionIndex: resolved.optionIndex,
        choiceLabel: resolved.choiceLabel,
        previousChoiceKind: null,
        previousOptionIndex: null,
        previousChoiceLabel: null,
      },
    });
    const created = await getDecisionForMarker({
      noteId: params.noteId,
      vaultId: params.vaultId,
      decisionMarkerId: markerId,
    });
    if (!created) throw new Error('decision insert missing');
    return { ok: true, decision: created };
  }

  await pool.execute(
    `UPDATE NoteDecisions
     SET ChoiceKind = ?, OptionIndex = ?, ChoiceLabel = ?,
         AuthorName = ?, ShareLinkId = ?, ActorPmUserId = ?
     WHERE Id = ? AND NoteId = ? AND VaultId = ? AND Locked = 0`,
    [
      resolved.choiceKind,
      resolved.optionIndex,
      resolved.choiceLabel,
      authorName,
      params.shareLinkId ?? null,
      params.actorPmUserId ?? null,
      existing.id,
      params.noteId,
      params.vaultId,
    ]
  );

  await insertEvent({
    decisionId: existing.id,
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: markerId,
    eventType: 'chose',
    actorKind: params.actorKind,
    actorLabel: authorName,
    actorPmUserId: params.actorPmUserId,
    shareLinkId: params.shareLinkId,
    payload: {
      choiceKind: resolved.choiceKind,
      optionIndex: resolved.optionIndex,
      choiceLabel: resolved.choiceLabel,
      previousChoiceKind: existing.choiceKind,
      previousOptionIndex: existing.optionIndex,
      previousChoiceLabel: existing.choiceLabel,
    },
  });

  const updated = await getDecisionForMarker({
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: markerId,
  });
  if (!updated) throw new Error('decision update missing');
  if (updated.locked) return { ok: false, reason: 'locked' };
  return { ok: true, decision: updated };
}

export async function setShareDecision(params: {
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  noteBodyMarkdown: string;
  optionIndex?: number | null;
  customText?: string | null;
  authorName?: string;
  shareLinkId: number;
}): Promise<
  | { ok: true; decision: DecisionRow }
  | {
      ok: false;
      reason:
        | 'invalid_decision'
        | 'locked'
        | 'invalid_option'
        | 'empty_custom'
        | 'missing_choice';
    }
> {
  return upsertChoice({
    ...params,
    authorName: params.authorName || '',
    actorKind: 'share_guest',
    shareLinkId: params.shareLinkId,
  });
}

export async function setOwnerDecision(params: {
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  noteBodyMarkdown: string;
  optionIndex?: number | null;
  customText?: string | null;
  actorLabel: string;
  actorPmUserId: number;
}): Promise<
  | { ok: true; decision: DecisionRow }
  | {
      ok: false;
      reason:
        | 'invalid_decision'
        | 'locked'
        | 'invalid_option'
        | 'empty_custom'
        | 'missing_choice';
    }
> {
  return upsertChoice({
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: params.decisionMarkerId,
    noteBodyMarkdown: params.noteBodyMarkdown,
    optionIndex: params.optionIndex,
    customText: params.customText,
    authorName: params.actorLabel,
    actorKind: 'owner',
    actorPmUserId: params.actorPmUserId,
  });
}

export async function setDecisionLocked(params: {
  noteId: number;
  vaultId: number;
  decisionMarkerId: string;
  noteBodyMarkdown: string;
  locked: boolean;
  actorLabel: string;
  actorPmUserId: number;
}): Promise<
  | { ok: true; decision: DecisionRow }
  | { ok: false; reason: 'invalid_decision' | 'not_found' | 'unchanged' }
> {
  const markerId = String(params.decisionMarkerId || '').trim();
  if (!markerId || !noteHasDecisionMarker(params.noteBodyMarkdown, markerId)) {
    return { ok: false, reason: 'invalid_decision' };
  }

  let existing = await getDecisionForMarker({
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: markerId,
  });

  if (!existing) {
    if (!params.locked) return { ok: false, reason: 'not_found' };
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO NoteDecisions
        (NoteId, VaultId, DecisionMarkerId, ChoiceKind, OptionIndex, ChoiceLabel, Locked,
         AuthorName, ActorPmUserId, LockedAt, LockedByPmUserId)
       VALUES (?, ?, ?, NULL, NULL, NULL, 1, ?, ?, CURRENT_TIMESTAMP, ?)`,
      [
        params.noteId,
        params.vaultId,
        markerId,
        params.actorLabel.slice(0, 128) || 'owner',
        params.actorPmUserId,
        params.actorPmUserId,
      ]
    );
    const decisionId = Number(result.insertId);
    await insertEvent({
      decisionId,
      noteId: params.noteId,
      vaultId: params.vaultId,
      decisionMarkerId: markerId,
      eventType: 'locked',
      actorKind: 'owner',
      actorLabel: params.actorLabel,
      actorPmUserId: params.actorPmUserId,
      payload: { locked: true },
    });
    existing = await getDecisionForMarker({
      noteId: params.noteId,
      vaultId: params.vaultId,
      decisionMarkerId: markerId,
    });
    if (!existing) throw new Error('decision lock insert missing');
    return { ok: true, decision: existing };
  }

  if (existing.locked === params.locked) {
    return { ok: false, reason: 'unchanged' };
  }

  if (params.locked) {
    await pool.execute(
      `UPDATE NoteDecisions
       SET Locked = 1, LockedAt = CURRENT_TIMESTAMP, LockedByPmUserId = ?
       WHERE Id = ? AND NoteId = ? AND VaultId = ?`,
      [params.actorPmUserId, existing.id, params.noteId, params.vaultId]
    );
  } else {
    await pool.execute(
      `UPDATE NoteDecisions
       SET Locked = 0, LockedAt = NULL, LockedByPmUserId = NULL
       WHERE Id = ? AND NoteId = ? AND VaultId = ?`,
      [existing.id, params.noteId, params.vaultId]
    );
  }

  await insertEvent({
    decisionId: existing.id,
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: markerId,
    eventType: params.locked ? 'locked' : 'unlocked',
    actorKind: 'owner',
    actorLabel: params.actorLabel,
    actorPmUserId: params.actorPmUserId,
    payload: { locked: params.locked },
  });

  const updated = await getDecisionForMarker({
    noteId: params.noteId,
    vaultId: params.vaultId,
    decisionMarkerId: markerId,
  });
  if (!updated) throw new Error('decision lock update missing');
  return { ok: true, decision: updated };
}
