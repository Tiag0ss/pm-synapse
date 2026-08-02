'use client';

type MermaidApi = typeof import('mermaid').default;

let renderGeneration = 0;
let initialized = false;
let mermaidApi: MermaidApi | null = null;

/** Synapse palette from app/globals.css :root — keep in sync. */
const SYNAPSE = {
  bg: '#0a0e13',
  panel: '#111820',
  surface: '#0e141c',
  surface2: '#1a2430',
  border: '#243041',
  borderStrong: '#334155',
  text: '#e8eef6',
  muted: '#8b98a8',
  accent: '#14b8a6',
  accentSoft: '#5eead4',
  fontSans: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
} as const;

function baseInit() {
  return {
    startOnLoad: false as const,
    securityLevel: 'loose' as const,
    logLevel: 'fatal' as const,
    theme: 'base' as const,
    darkMode: true,
    fontFamily: SYNAPSE.fontSans,
    htmlLabels: true,
    layout: 'elk' as const,
    elk: {
      mergeEdges: false,
      nodePlacementStrategy: 'BRANDES_KOEPF' as const,
    },
    flowchart: {
      htmlLabels: true,
      // ELK overrides edge drawing to orthogonal+rounded; this is a harmless default
      curve: 'linear' as const,
      padding: 12,
      nodeSpacing: 50,
      rankSpacing: 55,
      diagramPadding: 10,
      wrappingWidth: 220,
      useMaxWidth: true,
    },
    themeVariables: {
      darkMode: true,
      background: 'transparent',
      fontFamily: SYNAPSE.fontSans,
      // Nodes
      primaryColor: SYNAPSE.surface2,
      primaryTextColor: SYNAPSE.text,
      primaryBorderColor: SYNAPSE.accent,
      secondaryColor: SYNAPSE.panel,
      secondaryTextColor: SYNAPSE.text,
      secondaryBorderColor: SYNAPSE.borderStrong,
      tertiaryColor: SYNAPSE.surface,
      tertiaryTextColor: SYNAPSE.text,
      tertiaryBorderColor: SYNAPSE.border,
      mainBkg: SYNAPSE.surface2,
      nodeBorder: SYNAPSE.accent,
      clusterBkg: SYNAPSE.panel,
      clusterBorder: SYNAPSE.borderStrong,
      // Edges / labels
      lineColor: SYNAPSE.accentSoft,
      textColor: SYNAPSE.text,
      titleColor: SYNAPSE.text,
      edgeLabelBackground: SYNAPSE.panel,
      // Misc diagram chrome
      noteBkgColor: SYNAPSE.panel,
      noteTextColor: SYNAPSE.text,
      noteBorderColor: SYNAPSE.borderStrong,
      actorBkg: SYNAPSE.surface2,
      actorBorder: SYNAPSE.accent,
      actorTextColor: SYNAPSE.text,
      signalColor: SYNAPSE.accentSoft,
      signalTextColor: SYNAPSE.text,
      labelBoxBkgColor: SYNAPSE.panel,
      labelBoxBorderColor: SYNAPSE.border,
      labelTextColor: SYNAPSE.muted,
      fontSize: '14px',
    },
  };
}

/** Lazy-load Mermaid/ELK only in the browser so Next SSR does not emit fragile vendor-chunks. */
async function ensureMermaidElk(): Promise<MermaidApi> {
  if (initialized && mermaidApi) return mermaidApi;
  const [{ default: mermaid }, elkMod] = await Promise.all([
    import('mermaid'),
    import('@mermaid-js/layout-elk'),
  ]);
  const elkLayouts = (elkMod as { default?: unknown }).default ?? elkMod;
  if (!Array.isArray(elkLayouts) || elkLayouts.length === 0) {
    throw new Error('@mermaid-js/layout-elk export is empty');
  }
  mermaid.registerLayoutLoaders(elkLayouts);
  mermaid.initialize(baseInit());
  mermaidApi = mermaid;
  initialized = true;
  return mermaid;
}

function decorateMermaidExpand(wrap: HTMLElement): void {
  if (wrap.querySelector('.synapse-mermaid-expand')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'synapse-mermaid-expand';
  btn.title = 'Expand diagram';
  btn.setAttribute('aria-label', 'Expand diagram');
  btn.textContent = 'Expand';
  wrap.appendChild(btn);
}

/**
 * @mermaid-js/layout-elk JSON.stringifies its graph on layout failure; the graph holds
 * circular DOM refs, which masks the real error as "cyclic object value".
 * Patch stringify only for the duration of a render attempt.
 */
async function withCycleSafeJsonStringify<T>(fn: () => Promise<T>): Promise<T> {
  const native = JSON.stringify;
  JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown) => {
    const seen = new WeakSet<object>();
    const safeReplacer = (key: string, val: unknown) => {
      let next = val;
      if (typeof replacer === 'function') {
        next = (replacer as (k: string, v: unknown) => unknown)(key, val);
      }
      if (typeof next === 'object' && next !== null) {
        if (seen.has(next as object)) return undefined;
        // Skip DOM / D3 handles that make ELK's debug stringify explode
        if (typeof (next as { node?: unknown }).node === 'function') return undefined;
        if (next instanceof Element || next instanceof Node) return undefined;
        seen.add(next as object);
      }
      return next;
    };
    return native(value, safeReplacer, space as number | string);
  }) as typeof JSON.stringify;

  try {
    return await fn();
  } finally {
    JSON.stringify = native;
  }
}

function formatMermaidError(error: unknown): string {
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'object') {
    const o = error as { str?: unknown; message?: unknown };
    if (typeof o.str === 'string' && o.str.trim()) return o.str;
    if (typeof o.message === 'string' && o.message.trim()) return o.message;
  }
  return 'Mermaid render failed';
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function collectMermaidPres(root: HTMLElement): HTMLElement[] {
  const found = new Set<HTMLElement>();
  root.querySelectorAll('pre.synapse-mermaid-source').forEach((el) => {
    if (el instanceof HTMLElement) found.add(el);
  });
  root.querySelectorAll('code.language-mermaid').forEach((el) => {
    const pre = el.closest('pre');
    if (pre instanceof HTMLElement) found.add(pre);
  });
  return Array.from(found);
}

function showMermaidError(el: HTMLElement, source: string, error: unknown): void {
  const wrap = document.createElement('div');
  wrap.className = 'synapse-mermaid synapse-mermaid-error';
  wrap.textContent = `Mermaid/ELK error: ${formatMermaidError(error)}\n\n${source}`;
  el.replaceWith(wrap);
}

/** Ensure the diagram text asks for ELK (in addition to global init). */
function withElkConfig(source: string): string {
  const trimmed = source.trim();
  if (/layout\s*:\s*elk\b/i.test(trimmed)) return trimmed;
  if (/^\s*---/.test(trimmed)) {
    return trimmed.replace(/^---\s*\n/, '---\nconfig:\n  layout: elk\n');
  }
  return `---\nconfig:\n  layout: elk\n---\n${trimmed}`;
}

type EdgePoint = { x: number; y: number };

/**
 * ELK lays out orthogonal bend points, but @mermaid-js/layout-elk forces curve:'rounded'
 * (soft elbows). Mermaid stores the raw points on each edge as data-points (base64 JSON).
 * Redraw as a sharp M/L polyline so edges match Cursor-plan style: H/V only, 90° corners.
 */
function forceSharpOrthogonalEdges(root: HTMLElement): void {
  const paths = root.querySelectorAll(
    'path[data-points], path[data-et="edge"], .edgePaths path, path.flowchart-link'
  );
  paths.forEach((node) => {
    const path = node as SVGPathElement;
    const encoded = path.getAttribute('data-points');
    if (!encoded) return;
    try {
      const points = JSON.parse(atob(encoded)) as EdgePoint[];
      if (!Array.isArray(points) || points.length < 2) return;
      const cleaned: EdgePoint[] = [];
      for (const p of points) {
        if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
        const prev = cleaned[cleaned.length - 1];
        if (prev && Math.abs(prev.x - p.x) < 0.01 && Math.abs(prev.y - p.y) < 0.01) continue;
        cleaned.push({ x: p.x, y: p.y });
      }
      if (cleaned.length < 2) return;
      path.setAttribute(
        'd',
        cleaned.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join('')
      );
    } catch {
      /* ignore malformed data-points */
    }
  });
}

/**
 * Render via mermaid.render into a sized host in the document.
 * ELK needs getBBox on real layout boxes — opacity:0 still has geometry; display:none does not.
 */
async function renderWithElk(mermaid: MermaidApi, source: string, widthPx: number): Promise<string> {
  const id = `synapseMmd${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
  const host = document.createElement('div');
  host.setAttribute('data-synapse-mmd-host', id);
  host.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    `width:${Math.max(320, Math.floor(widthPx))}px`,
    'height:auto',
    'opacity:0',
    'pointer-events:none',
    'z-index:-1',
    'overflow:visible',
  ].join(';');
  document.body.appendChild(host);

  try {
    const prepared = withElkConfig(source);
    const { svg } = await withCycleSafeJsonStringify(() => mermaid.render(id, prepared, host));
    return svg;
  } finally {
    host.remove();
  }
}

/**
 * Turn ```mermaid code blocks into ELK diagrams (no dagre/step fallback — that causes stairs).
 */
export async function renderMermaidInRoot(root: HTMLElement | null): Promise<void> {
  if (!root || typeof window === 'undefined') return;
  const generation = ++renderGeneration;

  let mermaid: MermaidApi;
  try {
    mermaid = await ensureMermaidElk();
  } catch (err) {
    if (generation !== renderGeneration || !root.isConnected) return;
    for (const pre of collectMermaidPres(root)) {
      showMermaidError(pre, '', err);
    }
    return;
  }

  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  if (generation !== renderGeneration || !root.isConnected) return;

  const blocks = collectMermaidPres(root);
  if (!blocks.length) return;

  const widthPx = root.clientWidth || root.getBoundingClientRect().width || 720;

  for (let i = 0; i < blocks.length; i++) {
    if (generation !== renderGeneration || !root.isConnected) return;

    const pre = blocks[i];
    if (!root.contains(pre)) continue;

    const code = pre.querySelector('code') || pre;
    const source = decodeBasicEntities(code.textContent || '').trim();
    if (!source) continue;

    const closestBlock = pre.closest('.synapse-code-block');
    const outer: HTMLElement = closestBlock instanceof HTMLElement ? closestBlock : pre;

    try {
      const svg = await renderWithElk(mermaid, source, widthPx);
      if (generation !== renderGeneration || !root.contains(outer)) return;
      const wrap = document.createElement('div');
      wrap.className = 'synapse-mermaid';
      wrap.innerHTML = svg;
      wrap.dataset.mermaidRendered = '1';
      outer.replaceWith(wrap);
      // After mount: redraw ELK bend points as sharp orthogonal polylines (no rounded elbows)
      forceSharpOrthogonalEdges(wrap);
      decorateMermaidExpand(wrap);
    } catch (error) {
      if (!root.contains(outer)) continue;
      showMermaidError(outer, source, error);
    }
  }
}
