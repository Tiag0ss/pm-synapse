/**
 * Detect `[[attach` / `[[attach query` autocomplete for note attachments.
 * On accept, the span is replaced with a full markdown link `[Name](url)`.
 */
export type AttachSuggestContext = {
  replaceStart: number;
  replaceEnd: number;
  query: string;
};

export type AttachSuggestSource = {
  id: number;
  originalName: string | null;
  url: string;
  mimeType: string;
  sizeBytes: number;
};

export function detectAttachSuggestContext(
  value: string,
  caret: number
): AttachSuggestContext | null {
  if (caret < 0 || caret > value.length) return null;
  const before = value.slice(0, caret);
  const open = before.lastIndexOf('[[');
  if (open < 0) return null;
  const afterOpen = before.slice(open + 2);
  if (afterOpen.includes(']]') || afterOpen.includes('\n')) return null;
  const m = afterOpen.match(/^attach(?:\s+(.*))?$/i);
  if (!m) return null;
  return {
    replaceStart: open,
    replaceEnd: caret,
    query: (m[1] || '').trim(),
  };
}

export function attachSuggestItems(
  sources: AttachSuggestSource[],
  query: string,
  limit = 12
): Array<{ id: string; label: string; detail?: string; insert: string }> {
  const q = query.toLowerCase();
  const filtered = sources.filter((s) => {
    if (!q) return true;
    const name = (s.originalName || `file-${s.id}`).toLowerCase();
    return name.includes(q) || String(s.id).includes(q);
  });
  return filtered.slice(0, limit).map((s) => {
    const name = (s.originalName || `file-${s.id}`).replace(/[[\]]/g, '');
    const isImage = (s.mimeType || '').startsWith('image/');
    const insert = isImage ? `![${name}](${s.url})` : `[${name}](${s.url})`;
    const kb = Math.max(1, Math.round(s.sizeBytes / 1024));
    return {
      id: `attach-${s.id}`,
      label: name,
      detail: `${s.mimeType || 'file'} · ${kb} KB`,
      insert,
    };
  });
}
