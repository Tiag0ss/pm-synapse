/**
 * Line-oriented LCS diff for Meld-style side-by-side views.
 */

export type DiffOp = 'equal' | 'insert' | 'delete' | 'replace';

export interface DiffRow {
  op: DiffOp;
  leftLine: number | null;
  rightLine: number | null;
  left: string | null;
  right: string | null;
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Build paired rows for a split (Meld-like) view. */
export function buildSideBySideDiff(leftText: string, rightText: string): DiffRow[] {
  const left = leftText.replace(/\r\n/g, '\n').split('\n');
  const right = rightText.replace(/\r\n/g, '\n').split('\n');
  // Cap extreme sizes to keep UI responsive
  const maxLines = 8000;
  const a = left.length > maxLines ? left.slice(0, maxLines) : left;
  const b = right.length > maxLines ? right.slice(0, maxLines) : right;
  const dp = lcsTable(a, b);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let leftNo = 1;
  let rightNo = 1;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({
        op: 'equal',
        leftLine: leftNo++,
        rightLine: rightNo++,
        left: a[i],
        right: b[j],
      });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({
        op: 'delete',
        leftLine: leftNo++,
        rightLine: null,
        left: a[i],
        right: null,
      });
      i++;
    } else {
      rows.push({
        op: 'insert',
        leftLine: null,
        rightLine: rightNo++,
        left: null,
        right: b[j],
      });
      j++;
    }
  }
  while (i < a.length) {
    rows.push({
      op: 'delete',
      leftLine: leftNo++,
      rightLine: null,
      left: a[i++],
      right: null,
    });
  }
  while (j < b.length) {
    rows.push({
      op: 'insert',
      leftLine: null,
      rightLine: rightNo++,
      left: null,
      right: b[j++],
    });
  }

  // Pair adjacent delete+insert into replace for clearer Meld feel
  const paired: DiffRow[] = [];
  for (let r = 0; r < rows.length; r++) {
    const cur = rows[r];
    const next = rows[r + 1];
    if (cur.op === 'delete' && next?.op === 'insert') {
      paired.push({
        op: 'replace',
        leftLine: cur.leftLine,
        rightLine: next.rightLine,
        left: cur.left,
        right: next.right,
      });
      r++;
    } else {
      paired.push(cur);
    }
  }
  return paired;
}

/** Intra-line word highlighting: returns HTML fragments for left/right when op=replace. */
export function wordHighlight(left: string, right: string): { leftHtml: string; rightHtml: string } {
  const lw = left.split(/(\s+)/);
  const rw = right.split(/(\s+)/);
  const dp = lcsTable(lw, rw);
  const leftParts: string[] = [];
  const rightParts: string[] = [];
  let i = 0;
  let j = 0;
  while (i < lw.length && j < rw.length) {
    if (lw[i] === rw[j]) {
      leftParts.push(escapeHtml(lw[i]));
      rightParts.push(escapeHtml(rw[j]));
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      leftParts.push(`<mark class="diff-del">${escapeHtml(lw[i])}</mark>`);
      i++;
    } else {
      rightParts.push(`<mark class="diff-ins">${escapeHtml(rw[j])}</mark>`);
      j++;
    }
  }
  while (i < lw.length) {
    leftParts.push(`<mark class="diff-del">${escapeHtml(lw[i++])}</mark>`);
  }
  while (j < rw.length) {
    rightParts.push(`<mark class="diff-ins">${escapeHtml(rw[j++])}</mark>`);
  }
  return { leftHtml: leftParts.join(''), rightHtml: rightParts.join('') };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
