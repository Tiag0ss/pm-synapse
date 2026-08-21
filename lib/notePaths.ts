/** Path / folder helpers for vault notes (e.g. meta/risks). */

export function pathStem(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

/** Last segment of a title or path (e.g. meta/risks → risks). */
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

/** Parent folder path without trailing slash, or null for root notes. */
export function noteFolderPath(path: string): string | null {
  const parts = pathStem(path).split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('/');
}

export type NoteTreeNote = {
  type: 'note';
  id: number;
  title: string;
  path: string;
  name: string;
  icon?: string | null;
};

export type NoteTreeFolder = {
  type: 'folder';
  name: string;
  path: string;
  children: Array<NoteTreeFolder | NoteTreeNote>;
};

export type NoteTreeNode = NoteTreeFolder | NoteTreeNote;

/** Build a nested folder tree from notes. Folders first, then root notes; alpha within each group. */
export function buildNoteTree(
  notes: Array<{ Id: number; Title: string; Path: string; Icon?: string | null }>
): NoteTreeNode[] {
  const sorted = [...notes].sort((a, b) =>
    pathStem(a.Path).localeCompare(pathStem(b.Path), undefined, { sensitivity: 'base' })
  );

  type MutableFolder = {
    type: 'folder';
    name: string;
    path: string;
    children: Array<MutableFolder | NoteTreeNote>;
  };

  const root: MutableFolder = { type: 'folder', name: '', path: '', children: [] };

  const ensureFolder = (parts: string[]): MutableFolder => {
    let node = root;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.find(
        (c): c is MutableFolder => c.type === 'folder' && c.path === acc
      );
      if (!child) {
        child = { type: 'folder', name: part, path: acc, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  for (const n of sorted) {
    const parts = pathStem(n.Path).split('/').filter(Boolean);
    if (!parts.length) continue;
    const leaf = parts[parts.length - 1];
    const folderParts = parts.slice(0, -1);
    const parent = folderParts.length ? ensureFolder(folderParts) : root;
    parent.children.push({
      type: 'note',
      id: n.Id,
      title: n.Title,
      path: n.Path,
      name: noteLeafName(n.Title, n.Path) || leaf,
      icon: n.Icon ?? null,
    });
  }

  const sortTreeNodes = (nodes: Array<MutableFolder | NoteTreeNote>) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      const aName = a.type === 'folder' ? a.name : a.name;
      const bName = b.type === 'folder' ? b.name : b.name;
      return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
    });
    for (const node of nodes) {
      if (node.type === 'folder') sortTreeNodes(node.children);
    }
  };
  sortTreeNodes(root.children);

  return root.children;
}

export type NoteResolveEntry = {
  id: number;
  title: string;
  path: string;
};

/** Notes from one vault available for `[[@slug/…]]` resolution. */
export type LinkableVaultNotes = {
  vaultId: number;
  vaultSlug: string;
  vaultName: string;
  notes: NoteResolveEntry[];
};

export type CrossVaultResolveResult =
  | {
      status: 'ok';
      noteId: number;
      vaultId: number;
      vaultSlug: string;
      label: string;
    }
  | {
      status: 'missing';
      vaultId: number;
      vaultSlug: string;
      /** Note path/title to create (not display alias). */
      noteTarget: string;
      label: string;
    }
  | { status: 'locked'; label: string };

/**
 * Parse `[[@vault-slug/note-path]]` targets.
 * Returns null when the target is a same-vault wikilink.
 */
export function parseCrossVaultWikilinkTarget(
  target: string
): { vaultSlug: string; noteTarget: string } | null {
  const t = String(target || '')
    .trim()
    .replace(/\\/g, '/');
  const m = t.match(/^@([a-zA-Z0-9][a-zA-Z0-9_-]*)\/(.+)$/);
  if (!m) return null;
  const noteTarget = m[2].trim().replace(/\.md$/i, '');
  if (!noteTarget) return null;
  return { vaultSlug: m[1], noteTarget };
}

/**
 * Resolve [[wikilink]] targets:
 * - exact title (including meta/risks)
 * - full path stem (meta/risks)
 * - unique leaf name (risks) when only one note matches
 */
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

/**
 * Resolve `[[@vault-slug/path]]` for a viewer-scoped linkable index.
 * Unknown / inaccessible vault slugs → locked (label kept; UI shows no-access hint).
 */
export function resolveCrossVaultWikilink(
  target: string,
  linkable: LinkableVaultNotes[],
  alias?: string
): CrossVaultResolveResult {
  const parsed = parseCrossVaultWikilinkTarget(target);
  const fallbackLabel =
    String(alias || '').trim() ||
    (parsed ? parsed.noteTarget : String(target || '').trim()) ||
    String(target || '').trim();

  if (!parsed) return { status: 'locked', label: fallbackLabel };

  const vault = linkable.find(
    (v) => v.vaultSlug.toLowerCase() === parsed.vaultSlug.toLowerCase()
  );
  if (!vault) {
    return {
      status: 'locked',
      label: String(alias || '').trim() || parsed.noteTarget,
    };
  }

  const noteId = resolveNoteId(parsed.noteTarget, vault.notes);
  const label = String(alias ?? parsed.noteTarget).trim() || parsed.noteTarget;
  if (noteId == null) {
    return {
      status: 'missing',
      vaultId: vault.vaultId,
      vaultSlug: vault.vaultSlug,
      noteTarget: parsed.noteTarget,
      label,
    };
  }
  return {
    status: 'ok',
    noteId,
    vaultId: vault.vaultId,
    vaultSlug: vault.vaultSlug,
    label,
  };
}
