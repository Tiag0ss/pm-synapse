/** Fold open: :::fold / :::fold- / :::fold+ Title */
const FOLD_OPEN = /^:::fold([+-])?\s*(.*)$/;
const FOLD_CLOSE = /^:::\s*$/;

export type FoldCard = {
  front: string;
  backMarkdown: string;
  sourceNoteId?: number;
  sourceTitle?: string;
  sourcePath?: string;
};

export type FoldCardSource = {
  noteId?: number;
  title?: string;
  path?: string;
};

/**
 * Extract top-level `:::fold` blocks as flashcards.
 * Title → front; body (raw markdown, may include nested folds) → back.
 * Nested folds are not listed separately — they remain in the answer markdown.
 */
export function extractFoldCards(md: string, source?: FoldCardSource): FoldCard[] {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const cards: FoldCard[] = [];
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(FOLD_OPEN);
    if (!m) {
      i += 1;
      continue;
    }

    let close = -1;
    let depth = 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (FOLD_OPEN.test(lines[j])) depth += 1;
      else if (FOLD_CLOSE.test(lines[j])) {
        depth -= 1;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }

    if (close < 0) {
      i += 1;
      continue;
    }

    const front = m[2].trim();
    const backMarkdown = lines.slice(i + 1, close).join('\n').trim();
    if (front) {
      cards.push({
        front,
        backMarkdown,
        sourceNoteId: source?.noteId,
        sourceTitle: source?.title,
        sourcePath: source?.path,
      });
    }

    i = close + 1;
  }

  return cards;
}
