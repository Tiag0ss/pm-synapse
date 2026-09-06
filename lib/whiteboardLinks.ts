/** Synapse note links stored on Excalidraw elements. */

/** Match `app/globals.css` `--bg` — Excalidraw canvas default must not be white. */
export const SYNAPSE_BOARD_BG = '#0a0e13';

export const SYNAPSE_NOTE_LINK_PREFIX = 'synapse://note/';

export type SynapseNoteLink = {
  noteId: number;
  noteTitle?: string;
};

export function buildSynapseNoteLink(noteId: number): string {
  return `${SYNAPSE_NOTE_LINK_PREFIX}${noteId}`;
}

export function parseSynapseNoteLink(link: string | null | undefined): SynapseNoteLink | null {
  if (!link) return null;
  const trimmed = String(link).trim();
  if (!trimmed.startsWith(SYNAPSE_NOTE_LINK_PREFIX)) return null;
  const rest = trimmed.slice(SYNAPSE_NOTE_LINK_PREFIX.length);
  const idPart = rest.split(/[?#]/)[0] || '';
  const noteId = Number(idPart);
  if (!Number.isFinite(noteId) || noteId <= 0) return null;
  let noteTitle: string | undefined;
  try {
    const qIndex = trimmed.indexOf('?');
    if (qIndex >= 0) {
      const params = new URLSearchParams(trimmed.slice(qIndex + 1));
      const t = params.get('title');
      if (t) noteTitle = t;
    }
  } catch {
    // ignore malformed query
  }
  return { noteId, noteTitle };
}

export function synapseCustomData(noteId: number, noteTitle: string): { synapse: SynapseNoteLink } {
  return { synapse: { noteId, noteTitle } };
}

/** Collect linked note ids from an Excalidraw BoardJson document. */
export function extractBoardNoteLinkIds(boardJson: string | null | undefined): number[] {
  if (!boardJson?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(boardJson);
  } catch {
    return [];
  }
  const elements = (parsed as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];

  const ids = new Set<number>();
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const row = el as {
      isDeleted?: boolean;
      link?: string | null;
      customData?: { synapse?: { noteId?: unknown } };
    };
    if (row.isDeleted) continue;
    const fromLink = parseSynapseNoteLink(row.link ?? null);
    if (fromLink) ids.add(fromLink.noteId);
    const customId = Number(row.customData?.synapse?.noteId);
    if (Number.isFinite(customId) && customId > 0) ids.add(customId);
  }
  return [...ids];
}

/** First line of canvas text → candidate note title (optionally under a folder). */
export function titleFromWhiteboardText(text: string, folderPrefix?: string | null): string {
  const first = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  const leaf = (first || 'Untitled').slice(0, 200);
  const folder = folderPrefix?.replace(/^\/+|\/+$/g, '').trim();
  return folder ? `${folder}/${leaf}` : leaf;
}
