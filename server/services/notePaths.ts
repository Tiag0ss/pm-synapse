/**
 * Server-side path helpers (keep in sync with lib/notePaths.ts).
 */

export function pathStem(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

export function noteLeafName(title: string, path?: string): string {
  const fromTitle = String(title || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (fromTitle) return fromTitle;
  const fromPath = pathStem(path || '')
    .split('/')
    .filter(Boolean)
    .pop();
  return fromPath || 'note';
}

export type NoteResolveEntry = {
  id: number;
  title: string;
  path: string;
};

export function resolveNoteId(target: string, notes: NoteResolveEntry[]): number | null {
  const needle = target
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .toLowerCase();
  if (!needle) return null;

  const byTitle = notes.find((n) => n.title.replace(/\\/g, '/').toLowerCase() === needle);
  if (byTitle) return byTitle.id;

  const byPath = notes.find((n) => pathStem(n.path).toLowerCase() === needle);
  if (byPath) return byPath.id;

  const leafHits = notes.filter((n) => {
    const pathLeaf = pathStem(n.path).split('/').pop()?.toLowerCase();
    const titleLeaf = n.title
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.trim()
      .toLowerCase();
    return pathLeaf === needle || titleLeaf === needle;
  });
  if (leafHits.length === 1) return leafHits[0].id;

  return null;
}
