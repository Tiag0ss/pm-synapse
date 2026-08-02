/** Client copy — keep in sync with server/services/plainText.ts */
export function stripMarkdownToPlainText(input: string): string {
  let s = String(input || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/~~~[\w-]*\n?([\s\S]*?)~~~/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = String(alias ?? target).trim();
    return label.split('/').filter(Boolean).pop() || label;
  });
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  s = s.replace(/___(.+?)___/g, '$1');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/__(.+?)__/g, '$1');
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^[-*+]\s+(\[[ xX]\]\s+)?/gm, '');
  s = s.replace(/^\d+\.\s+/gm, '');
  s = s.replace(/(^|\s)#[a-zA-Z][\w/-]*/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
