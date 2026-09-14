/** Browser-only tokens allowing guests to edit/delete their pending share answers. */

const STORAGE_PREFIX = 'synapse-ask-edit:';

function storageKey(shareToken: string): string {
  return `${STORAGE_PREFIX}${shareToken}`;
}

function readMap(shareToken: string): Record<string, string> {
  if (typeof window === 'undefined' || !shareToken) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(shareToken));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[String(k)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(shareToken: string, map: Record<string, string>): void {
  if (typeof window === 'undefined' || !shareToken) return;
  try {
    window.localStorage.setItem(storageKey(shareToken), JSON.stringify(map));
  } catch {
    /* quota / private mode */
  }
}

export function getAskGuestEditToken(shareToken: string, answerId: number): string | null {
  const map = readMap(shareToken);
  const token = map[String(answerId)];
  return token || null;
}

export function setAskGuestEditToken(
  shareToken: string,
  answerId: number,
  guestEditToken: string
): void {
  if (!shareToken || !answerId || !guestEditToken) return;
  const map = readMap(shareToken);
  map[String(answerId)] = guestEditToken;
  writeMap(shareToken, map);
}

export function clearAskGuestEditToken(shareToken: string, answerId: number): void {
  if (!shareToken || !answerId) return;
  const map = readMap(shareToken);
  if (!(String(answerId) in map)) return;
  delete map[String(answerId)];
  writeMap(shareToken, map);
}

export function listOwnedAskAnswerIds(shareToken: string): number[] {
  return Object.keys(readMap(shareToken))
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0);
}
