/** Strip markdown / wikilink syntax for plain labels (e.g. PM task names). */
export function stripMarkdownToPlainText(input: string): string {
  let s = String(input || '');

  // HTML comments / synapse markers
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Fenced code blocks → inner text
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/~~~[\w-]*\n?([\s\S]*?)~~~/g, '$1');

  // Images ![alt](url) → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Links [label](url) → label
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Wikilinks [[target|label]] / [[target]] → label or target leaf
  s = s.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = String(alias ?? target).trim();
    const leaf = label.split('/').filter(Boolean).pop() || label;
    return leaf;
  });

  // Inline code
  s = s.replace(/`([^`]+)`/g, '$1');

  // Bold / italic / strike (order matters for nested)
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  s = s.replace(/___(.+?)___/g, '$1');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');

  // Headings / quotes / lists markers at line start
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/gm, '');
  s = s.replace(/^\d+\.\s+/gm, '');

  // Tags
  s = s.replace(/(^|\s)#[a-zA-Z][\w/-]*/g, '$1');

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
