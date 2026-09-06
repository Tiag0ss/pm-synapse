/** Clear find-in-preview marks and restore text nodes. */
export function clearPeekHits(root: HTMLElement): void {
  root.querySelectorAll('mark.synapse-peek-hit').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

/**
 * Wrap case-insensitive matches in <mark class="synapse-peek-hit">.
 * Returns marks in document order.
 */
export function applyPeekHits(root: HTMLElement, query: string): HTMLElement[] {
  clearPeekHits(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = (node as Text).parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest('svg, script, style, mark.synapse-peek-hit')) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.textContent || '';
      if (!text || !text.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) {
    textNodes.push(current as Text);
  }

  const hits: HTMLElement[] = [];
  for (const textNode of textNodes) {
    const text = textNode.textContent || '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let start = 0;
    let matched = false;

    while (start < text.length) {
      const idx = lower.indexOf(needle, start);
      if (idx === -1) {
        frag.appendChild(document.createTextNode(text.slice(start)));
        break;
      }
      if (idx > start) {
        frag.appendChild(document.createTextNode(text.slice(start, idx)));
      }
      const mark = document.createElement('mark');
      mark.className = 'synapse-peek-hit';
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      hits.push(mark);
      matched = true;
      start = idx + needle.length;
    }

    if (matched) {
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }

  return hits;
}

export function setActivePeekHit(hits: HTMLElement[], index: number): void {
  hits.forEach((el, i) => {
    el.classList.toggle('is-active', i === index);
  });
  const active = hits[index];
  if (active) {
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
