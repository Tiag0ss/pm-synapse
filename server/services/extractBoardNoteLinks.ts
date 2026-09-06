/** Keep in sync with lib/whiteboardLinks.ts — extract synapse://note links from BoardJson. */

const SYNAPSE_NOTE_LINK_PREFIX = 'synapse://note/';

function parseSynapseNoteLink(link: string | null | undefined): number | null {
  if (!link) return null;
  const trimmed = String(link).trim();
  if (!trimmed.startsWith(SYNAPSE_NOTE_LINK_PREFIX)) return null;
  const rest = trimmed.slice(SYNAPSE_NOTE_LINK_PREFIX.length);
  const idPart = rest.split(/[?#]/)[0] || '';
  const noteId = Number(idPart);
  if (!Number.isFinite(noteId) || noteId <= 0) return null;
  return noteId;
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
    if (fromLink) ids.add(fromLink);
    const customId = Number(row.customData?.synapse?.noteId);
    if (Number.isFinite(customId) && customId > 0) ids.add(customId);
  }
  return [...ids];
}
