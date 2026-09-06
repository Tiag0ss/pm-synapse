import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, RowDataPacket, ResultSetHeader } from '../config/database';
import { jwtSecret } from './secrets';
import { markdownToSafeHtml } from './markdown';
import { isPlannerOverviewNote } from './personalWorkVault';

const BCRYPT_ROUNDS = 10;
const SHARE_COOKIE = 'synapse_share';
const MIN_EXPIRES_SEC = 15 * 60;
const MAX_EXPIRES_SEC = 90 * 24 * 60 * 60;

export { SHARE_COOKIE, MIN_EXPIRES_SEC, MAX_EXPIRES_SEC };

export type NoteShareRow = {
  Id: number;
  NoteId: number;
  VaultId: number;
  CreatedByPmUserId: number;
  TokenHash: string;
  PasswordHash: string;
  ExpiresAt: Date;
  RevokedAt: Date | null;
  CreatedAt: Date;
};

export type NoteShareListItem = {
  id: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'expired' | 'revoked';
};

export type ShareAccessState = 'ok' | 'not_found' | 'expired' | 'revoked';

function appBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3010}`
  ).replace(/\/+$/, '');
}

export function hashShareToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function clampExpiresInSeconds(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_EXPIRES_SEC;
  return Math.min(MAX_EXPIRES_SEC, Math.max(MIN_EXPIRES_SEC, Math.floor(raw)));
}

function toIso(d: Date | string): string {
  return new Date(d).toISOString();
}

function boardJsonToString(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  const s = String(raw);
  return s.trim() ? s : null;
}

function shareStatus(row: {
  ExpiresAt: Date | string;
  RevokedAt: Date | string | null;
}): 'active' | 'expired' | 'revoked' {
  if (row.RevokedAt) return 'revoked';
  if (new Date(row.ExpiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

export async function findActiveShareByToken(
  rawToken: string
): Promise<{ state: ShareAccessState; share: NoteShareRow | null }> {
  const tokenHash = hashShareToken(rawToken);
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, NoteId, VaultId, CreatedByPmUserId, TokenHash, PasswordHash,
            ExpiresAt, RevokedAt, CreatedAt
     FROM NoteShareLinks WHERE TokenHash = ? LIMIT 1`,
    [tokenHash]
  );
  if (!rows.length) return { state: 'not_found', share: null };
  const share = rows[0] as unknown as NoteShareRow;
  const status = shareStatus(share);
  if (status === 'revoked') return { state: 'revoked', share };
  if (status === 'expired') return { state: 'expired', share };
  return { state: 'ok', share };
}

export async function createNoteShare(params: {
  vaultId: number;
  noteId: number;
  createdByPmUserId: number;
  expiresInSeconds: number;
}): Promise<
  | { ok: true; id: number; url: string; password: string; expiresAt: string }
  | { ok: false; reason: 'not_found' | 'hub_note' }
> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Path, BodyMarkdown, Kind FROM Notes
     WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL LIMIT 1`,
    [params.noteId, params.vaultId]
  );
  if (!notes.length) return { ok: false, reason: 'not_found' };
  const note = notes[0];
  if (isPlannerOverviewNote(String(note.Path || ''), String(note.BodyMarkdown || ''))) {
    return { ok: false, reason: 'hub_note' };
  }

  const expiresIn = clampExpiresInSeconds(params.expiresInSeconds);
  const rawToken = randomBase64Url(32);
  const password = randomBase64Url(9);
  const tokenHash = hashShareToken(rawToken);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO NoteShareLinks
      (NoteId, VaultId, CreatedByPmUserId, TokenHash, PasswordHash, ExpiresAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.noteId,
      params.vaultId,
      params.createdByPmUserId,
      tokenHash,
      passwordHash,
      expiresAt,
    ]
  );

  return {
    ok: true,
    id: Number(result.insertId),
    url: `${appBaseUrl()}/s/${rawToken}`,
    password,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function listNoteShares(
  vaultId: number,
  noteId: number
): Promise<NoteShareListItem[] | null> {
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL LIMIT 1`,
    [noteId, vaultId]
  );
  if (!notes.length) return null;

  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, ExpiresAt, RevokedAt, CreatedAt
     FROM NoteShareLinks
     WHERE NoteId = ? AND VaultId = ?
     ORDER BY CreatedAt DESC
     LIMIT 50`,
    [noteId, vaultId]
  );

  return rows.map((r) => ({
    id: Number(r.Id),
    expiresAt: toIso(r.ExpiresAt),
    revokedAt: r.RevokedAt ? toIso(r.RevokedAt) : null,
    createdAt: toIso(r.CreatedAt),
    status: shareStatus(r as { ExpiresAt: Date; RevokedAt: Date | null }),
  }));
}

export async function revokeNoteShare(params: {
  vaultId: number;
  noteId: number;
  shareId: number;
}): Promise<'ok' | 'not_found'> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE NoteShareLinks
     SET RevokedAt = CURRENT_TIMESTAMP
     WHERE Id = ? AND NoteId = ? AND VaultId = ? AND RevokedAt IS NULL`,
    [params.shareId, params.noteId, params.vaultId]
  );
  if (result.affectedRows === 0) {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT Id FROM NoteShareLinks WHERE Id = ? AND NoteId = ? AND VaultId = ? LIMIT 1`,
      [params.shareId, params.noteId, params.vaultId]
    );
    return rows.length ? 'ok' : 'not_found'; // already revoked counts as ok
  }
  return 'ok';
}

export async function verifySharePassword(
  share: NoteShareRow,
  password: string
): Promise<boolean> {
  return bcrypt.compare(password, share.PasswordHash);
}

type ShareCookiePayload = {
  typ: 'note_share';
  shareId: number;
  noteId: number;
  th: string;
};

export function signShareCookie(share: NoteShareRow): { token: string; maxAgeMs: number } {
  const expMs = new Date(share.ExpiresAt).getTime();
  const maxAgeMs = Math.max(1000, expMs - Date.now());
  const token = jwt.sign(
    {
      typ: 'note_share',
      shareId: Number(share.Id),
      noteId: Number(share.NoteId),
      th: share.TokenHash,
    } satisfies ShareCookiePayload,
    jwtSecret(),
    { expiresIn: Math.ceil(maxAgeMs / 1000) }
  );
  return { token, maxAgeMs };
}

export function readShareCookie(
  cookieHeader: string | undefined,
  expected: NoteShareRow
): boolean {
  if (!cookieHeader) return false;
  try {
    const decoded = jwt.verify(cookieHeader, jwtSecret()) as ShareCookiePayload;
    if (decoded.typ !== 'note_share') return false;
    if (Number(decoded.shareId) !== Number(expected.Id)) return false;
    if (Number(decoded.noteId) !== Number(expected.NoteId)) return false;
    if (String(decoded.th) !== String(expected.TokenHash)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function getShareMeta(rawToken: string): Promise<
  | { ok: false; state: 'not_found' | 'expired' | 'revoked' }
  | {
      ok: true;
      state: 'ok';
      title: string;
      kind: 'note' | 'whiteboard';
      expiresAt: string;
    }
> {
  const found = await findActiveShareByToken(rawToken);
  if (found.state === 'not_found' || !found.share) {
    return { ok: false, state: 'not_found' };
  }
  if (found.state === 'expired' || found.state === 'revoked') {
    return { ok: false, state: found.state };
  }

  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT Title, Kind FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL LIMIT 1`,
    [found.share.NoteId, found.share.VaultId]
  );
  if (!notes.length) return { ok: false, state: 'not_found' };

  return {
    ok: true,
    state: 'ok',
    title: String(notes[0].Title || 'Note'),
    kind: String(notes[0].Kind || 'note') === 'whiteboard' ? 'whiteboard' : 'note',
    expiresAt: toIso(found.share.ExpiresAt),
  };
}

export async function getShareContent(params: {
  rawToken: string;
  shareCookie?: string;
}): Promise<
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'locked' }
  | {
      ok: true;
      title: string;
      kind: 'note' | 'whiteboard';
      noteId: number;
      html: string;
      boardJson: string | null;
      expiresAt: string;
    }
> {
  const found = await findActiveShareByToken(params.rawToken);
  if (found.state === 'not_found' || !found.share) {
    return { ok: false, reason: 'not_found' };
  }
  if (found.state === 'expired') return { ok: false, reason: 'expired' };
  if (found.state === 'revoked') return { ok: false, reason: 'revoked' };

  if (!readShareCookie(params.shareCookie, found.share)) {
    return { ok: false, reason: 'locked' };
  }

  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT Id, Title, Path, BodyMarkdown, Kind, BoardJson
     FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL LIMIT 1`,
    [found.share.NoteId, found.share.VaultId]
  );
  if (!notes.length) return { ok: false, reason: 'not_found' };
  const note = notes[0];
  const noteId = Number(note.Id);
  const kind = String(note.Kind || 'note') === 'whiteboard' ? 'whiteboard' : 'note';
  const token = params.rawToken;

  if (kind === 'whiteboard') {
    return {
      ok: true,
      title: String(note.Title || 'Whiteboard'),
      kind,
      noteId,
      html: '',
      boardJson: boardJsonToString(note.BoardJson),
      expiresAt: toIso(found.share.ExpiresAt),
    };
  }

  const html = markdownToSafeHtml(String(note.BodyMarkdown || ''), [], [], noteId)
    .replace(
      new RegExp(`/api/vaults/${Number(found.share.VaultId)}/media/(\\d+)`, 'g'),
      `/api/shares/${encodeURIComponent(token)}/media/$1`
    )
    .replace(
      new RegExp(`/api/public/[^/"'\\s]+/media/(\\d+)`, 'g'),
      `/api/shares/${encodeURIComponent(token)}/media/$1`
    );

  return {
    ok: true,
    title: String(note.Title || 'Note'),
    kind,
    noteId,
    html,
    boardJson: null,
    expiresAt: toIso(found.share.ExpiresAt),
  };
}

/** Allow media only if referenced by the shared note body. */
export async function shareMediaAllowed(params: {
  rawToken: string;
  shareCookie?: string;
  mediaId: number;
}): Promise<{ ok: true; vaultId: number } | { ok: false }> {
  const found = await findActiveShareByToken(params.rawToken);
  if (found.state !== 'ok' || !found.share) return { ok: false };
  if (!readShareCookie(params.shareCookie, found.share)) return { ok: false };

  const vaultId = Number(found.share.VaultId);
  const mediaId = params.mediaId;
  const needles = [
    `/api/vaults/${vaultId}/media/${mediaId}`,
    `/api/shares/`,
  ];
  const [notes] = await pool.execute<RowDataPacket[]>(
    `SELECT BodyMarkdown FROM Notes WHERE Id = ? AND VaultId = ? AND DeletedAt IS NULL LIMIT 1`,
    [found.share.NoteId, vaultId]
  );
  if (!notes.length) return { ok: false };
  const body = String(notes[0].BodyMarkdown || '');
  if (
    body.includes(needles[0]) ||
    body.includes(`/media/${mediaId}`) ||
    new RegExp(`/api/shares/[^/"'\\s]+/media/${mediaId}`).test(body) ||
    new RegExp(`/api/public/[^/"'\\s]+/media/${mediaId}`).test(body)
  ) {
    return { ok: true, vaultId };
  }
  return { ok: false };
}
