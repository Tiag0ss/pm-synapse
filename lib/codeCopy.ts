/** Wire copy buttons / click-to-copy on markdown preview HTML (event delegation). */
export function handleMarkdownCodeCopyClick(e: MouseEvent, root: HTMLElement): boolean {
  const btn = (e.target as HTMLElement).closest('button.synapse-copy-code') as HTMLButtonElement | null;
  if (btn && root.contains(btn)) {
    e.preventDefault();
    e.stopPropagation();
    const wrap = btn.closest('.synapse-code-block');
    const codeEl = wrap?.querySelector('pre code') || wrap?.querySelector('pre');
    const text = codeEl?.textContent ?? '';
    if (!text) return true;
    void copyText(text).then(() => flashCopiedButton(btn));
    return true;
  }

  // Inline `code` — click the chip itself (no extra button / no reserved space)
  const inline = (e.target as HTMLElement).closest(
    '.synapse-md-preview code.synapse-inline-copy'
  ) as HTMLElement | null;
  if (inline && root.contains(inline) && !inline.closest('pre')) {
    e.preventDefault();
    e.stopPropagation();
    const text = inline.textContent ?? '';
    if (!text) return true;
    void copyText(text).then(() => {
      inline.classList.add('is-copied');
      window.setTimeout(() => inline.classList.remove('is-copied'), 1200);
    });
    return true;
  }

  return false;
}

function flashCopiedButton(btn: HTMLButtonElement): void {
  btn.classList.add('is-copied');
  btn.setAttribute('aria-label', 'Copied');
  btn.title = 'Copied';
  window.setTimeout(() => {
    btn.classList.remove('is-copied');
    btn.setAttribute('aria-label', 'Copy code');
    btn.title = 'Copy';
  }, 1500);
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

const COPY_BTN =
  `<button type="button" class="synapse-copy-code" aria-label="Copy code" title="Copy">Copy</button>`;

/**
 * - Fenced ``` blocks → in-box Copy button (top-right of the pre)
 * - Inline `code` → click-to-copy class only (no button, no layout shift)
 */
export function enhanceCodeCopyHtml(html: string): string {
  const slots: string[] = [];
  let out = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, (block) => {
    if (/\bsynapse-mermaid-source\b|\blanguage-mermaid\b/i.test(block)) {
      slots.push(block);
      return `\u0000PRE${slots.length - 1}\u0000`;
    }
    const wrapped =
      `<div class="synapse-code-block">` +
      `<div class="synapse-code-toolbar">${COPY_BTN}</div>` +
      `${block}` +
      `</div>`;
    slots.push(wrapped);
    return `\u0000PRE${slots.length - 1}\u0000`;
  });

  out = out.replace(/<code\b([^>]*)>/gi, (_m, attrs: string) => {
    if (/\bsynapse-inline-copy\b/.test(attrs)) return `<code${attrs}>`;
    let next = attrs;
    if (!/\btitle=/i.test(next)) next += ` title="Click to copy"`;
    if (/\bclass="/i.test(next)) {
      return `<code${next.replace(/\bclass="/i, 'class="synapse-inline-copy ')}>`;
    }
    return `<code class="synapse-inline-copy"${next}>`;
  });

  return out.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}
