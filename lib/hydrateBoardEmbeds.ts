'use client';

/** Vault note API → board JSON (or null if not a whiteboard). */
export async function fetchVaultBoardJson(
  vaultId: number,
  noteId: number
): Promise<string | null> {
  const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}`, {
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const row = data.data || {};
  const kind = String(row.Kind || row.kind || 'note');
  if (kind !== 'whiteboard') return null;
  const bj = row.BoardJson ?? row.boardJson;
  return bj != null ? String(bj) : '';
}

/** Public wiki note API → board JSON. */
export async function fetchWikiBoardJson(
  wikiSlug: string,
  noteId: number
): Promise<string | null> {
  const res = await fetch(`/api/public/${encodeURIComponent(wikiSlug)}/notes/${noteId}`, {
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const row = data.data || {};
  const kind = String(row.kind || row.Kind || 'note');
  if (kind !== 'whiteboard') return null;
  const bj = row.boardJson ?? row.BoardJson;
  return bj != null ? String(bj) : '';
}
