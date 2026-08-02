/** Wire copy buttons injected into markdown preview HTML (event delegation). */
export function handleMarkdownCodeCopyClick(e: MouseEvent, root: HTMLElement): boolean {
  const btn = (e.target as HTMLElement).closest('button.synapse-copy-code') as HTMLButtonElement | null;
  if (!btn || !root.contains(btn)) return false;
  e.preventDefault();
  e.stopPropagation();

  const wrap = btn.closest('.synapse-code-block, .synapse-inline-code');
  const codeEl =
    wrap?.querySelector('pre code') ||
    wrap?.querySelector('code') ||
    wrap?.querySelector('pre');
  const text = codeEl?.textContent ?? '';
  if (!text) return true;

  const label = btn.getAttribute('data-label') || btn.textContent || 'Copy';
  const showCopied = () => {
    btn.textContent = 'Copied';
    btn.classList.add('is-copied');
    window.setTimeout(() => {
      btn.textContent = label;
      btn.classList.remove('is-copied');
    }, 1500);
  };

  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(showCopied).catch(() => {
      fallbackCopy(text);
      showCopied();
    });
  } else {
    fallbackCopy(text);
    showCopied();
  }
  return true;
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

/**
 * Wrap fenced `<pre>` and inline `<code>` with copy-to-clipboard controls.
 * Safe to run on marked HTML before or after sanitization (buttons must be allowed).
 */
export function enhanceCodeCopyHtml(html: string): string {
  const slots: string[] = [];
  let out = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, (block) => {
    // Mermaid sources are rendered client-side — skip copy chrome
    if (/\bsynapse-mermaid-source\b|\blanguage-mermaid\b/i.test(block)) {
      slots.push(block);
      return `\u0000PRE${slots.length - 1}\u0000`;
    }
    const wrapped = `<div class="synapse-code-block"><div class="synapse-code-toolbar"><button type="button" class="synapse-copy-code" data-label="Copy" aria-label="Copy code" title="Copy">Copy</button></div>${block}</div>`;
    slots.push(wrapped);
    return `\u0000PRE${slots.length - 1}\u0000`;
  });

  out = out.replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, (block) => {
    return `<span class="synapse-inline-code">${block}<button type="button" class="synapse-copy-code" data-label="Copy" aria-label="Copy code" title="Copy">Copy</button></span>`;
  });

  return out.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}
