/**
 * Mermaid → PNG for Word export.
 * - White page-friendly theme (teal accents, dark text)
 * - ELK node placement when possible; edges rebuilt as orthogonal (linear) routes
 *   because jsdom getBBox is not accurate enough for Mermaid’s own edge drawing
 * - Edge labels placed on the longest segment midpoint
 */
import { randomUUID } from 'crypto';
import logger from '../utils/logger';

const DOCX_THEME = {
  bg: '#ffffff',
  nodeFill: '#ffffff',
  nodeBorder: '#14b8a6',
  line: '#14b8a6',
  text: '#0f172a',
  muted: '#475569',
  labelBg: '#ffffff',
  fontSans: 'DejaVu Sans, Arial, sans-serif',
} as const;

type EdgePoint = { x: number; y: number };

type NodeBox = {
  name: string;
  el: Element;
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  hw: number;
  hh: number;
};

type SvgMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };

function withElkConfig(source: string): string {
  const trimmed = source.trim();
  if (/layout\s*:\s*elk\b/i.test(trimmed)) return trimmed;
  if (/^\s*---/.test(trimmed)) {
    return trimmed.replace(/^---\s*\n/, '---\nconfig:\n  layout: elk\n');
  }
  return `---\nconfig:\n  layout: elk\n---\n${trimmed}`;
}

function synapseDocxInit() {
  return {
    startOnLoad: false as const,
    securityLevel: 'loose' as const,
    logLevel: 'fatal' as const,
    theme: 'base' as const,
    darkMode: false,
    fontFamily: DOCX_THEME.fontSans,
    htmlLabels: true,
    layout: 'elk' as const,
    elk: {
      mergeEdges: false,
      nodePlacementStrategy: 'BRANDES_KOEPF' as const,
    },
    flowchart: {
      htmlLabels: true,
      curve: 'linear' as const,
      padding: 16,
      nodeSpacing: 60,
      rankSpacing: 70,
      diagramPadding: 16,
      wrappingWidth: 240,
      useMaxWidth: false,
    },
    sequence: { useMaxWidth: false, actorMargin: 50, messageMargin: 40 },
    themeVariables: {
      darkMode: false,
      background: DOCX_THEME.bg,
      fontFamily: DOCX_THEME.fontSans,
      primaryColor: DOCX_THEME.nodeFill,
      primaryTextColor: DOCX_THEME.text,
      primaryBorderColor: DOCX_THEME.nodeBorder,
      secondaryColor: '#f8fafc',
      secondaryTextColor: DOCX_THEME.text,
      secondaryBorderColor: DOCX_THEME.nodeBorder,
      tertiaryColor: '#f1f5f9',
      tertiaryTextColor: DOCX_THEME.text,
      tertiaryBorderColor: '#94a3b8',
      mainBkg: DOCX_THEME.nodeFill,
      nodeBorder: DOCX_THEME.nodeBorder,
      clusterBkg: '#f8fafc',
      clusterBorder: '#94a3b8',
      lineColor: DOCX_THEME.line,
      textColor: DOCX_THEME.text,
      titleColor: DOCX_THEME.text,
      edgeLabelBackground: DOCX_THEME.labelBg,
      noteBkgColor: '#f8fafc',
      noteTextColor: DOCX_THEME.text,
      noteBorderColor: '#94a3b8',
      actorBkg: DOCX_THEME.nodeFill,
      actorBorder: DOCX_THEME.nodeBorder,
      actorTextColor: DOCX_THEME.text,
      signalColor: DOCX_THEME.line,
      signalTextColor: DOCX_THEME.text,
      labelBoxBkgColor: DOCX_THEME.labelBg,
      labelBoxBorderColor: DOCX_THEME.nodeBorder,
      labelTextColor: DOCX_THEME.muted,
      fontSize: '14px',
    },
  };
}

function parseTranslate(transform: string | null): { x: number; y: number } {
  const m = /translate\(\s*([^,\s)]+)(?:[,\s]+([^)]+))?\)/.exec(transform || '');
  return { x: Number(m?.[1] || 0), y: Number(m?.[2] || 0) };
}

function transformIsBroken(t: string | null): boolean {
  if (!t) return true;
  return /undefined|NaN/i.test(t);
}

function estimateTextSize(text: string): { w: number; h: number } {
  const t = text.replace(/\s+/g, ' ').trim() || ' ';
  const w = Math.max(48, Math.ceil(t.length * 8.2) + 24);
  const h = 28;
  return { w, h };
}

function polygonBounds(pointsAttr: string | null): { hw: number; hh: number } | null {
  if (!pointsAttr) return null;
  const pts = pointsAttr.trim().split(/[\s,]+/).map(Number);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (!Number.isFinite(pts[i]) || !Number.isFinite(pts[i + 1])) continue;
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]);
    maxY = Math.max(maxY, pts[i + 1]);
  }
  if (!Number.isFinite(minX)) return null;
  return { hw: Math.max(20, (maxX - minX) / 2), hh: Math.max(16, (maxY - minY) / 2) };
}

function collectNodeBoxes(root: Element): Map<string, NodeBox> {
  const nodes = new Map<string, NodeBox>();
  for (const n of root.querySelectorAll('g.node')) {
    const id = n.getAttribute('id') || '';
    // id like flowchart-Request-0 or flowchart-Deny-1
    const name = id.replace(/^.*?flowchart-/, '').replace(/-\d+$/, '');
    if (!name) continue;
    const tr = parseTranslate(n.getAttribute('transform'));
    const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
    const est = estimateTextSize(text);

    const rect = n.querySelector('rect.label-container, rect.basic, rect');
    let hw = est.w / 2;
    let hh = est.h / 2;
    if (rect) {
      const rw = Math.abs(Number(rect.getAttribute('width') || 0));
      const rh = Math.abs(Number(rect.getAttribute('height') || 0));
      hw = Math.max(hw, rw / 2 || 0);
      hh = Math.max(hh, rh / 2 || 0);
      // Expand undersized boxes so labels are not clipped in Word
      if (rw < est.w) {
        rect.setAttribute('width', String(est.w));
        rect.setAttribute('x', String(-est.w / 2));
        hw = est.w / 2;
      }
      if (rh < est.h) {
        rect.setAttribute('height', String(est.h));
        rect.setAttribute('y', String(-est.h / 2));
        hh = est.h / 2;
      }
      rect.setAttribute('fill', DOCX_THEME.nodeFill);
      rect.setAttribute('stroke', DOCX_THEME.nodeBorder);
    } else {
      const poly = n.querySelector('polygon');
      const pb = polygonBounds(poly?.getAttribute('points') || null);
      if (pb) {
        hw = Math.max(hw, pb.hw);
        hh = Math.max(hh, pb.hh);
      }
      if (poly) {
        poly.setAttribute('fill', DOCX_THEME.nodeFill);
        poly.setAttribute('stroke', DOCX_THEME.nodeBorder);
      }
    }

    nodes.set(name, {
      name,
      el: n,
      cx: tr.x,
      cy: tr.y,
      top: tr.y - hh,
      bottom: tr.y + hh,
      left: tr.x - hw,
      right: tr.x + hw,
      hw,
      hh,
    });
  }
  return nodes;
}

function matchEdgeNodes(
  dataId: string,
  nodes: Map<string, NodeBox>
): { from: NodeBox; to: NodeBox } | null {
  const m = /^L_(.+)_(\d+)$/.exec(dataId);
  if (!m) return null;
  const rest = m[1];
  const names = [...nodes.keys()];
  // Prefer longest name matches to support underscores in ids
  let best: { from: string; to: string; score: number } | null = null;
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      if (rest === `${a}_${b}`) {
        const score = a.length + b.length;
        if (!best || score > best.score) best = { from: a, to: b, score };
      }
    }
  }
  if (!best) return null;
  const from = nodes.get(best.from);
  const to = nodes.get(best.to);
  if (!from || !to) return null;
  return { from, to };
}

/** Orthogonal TD route (ELK / linear style). */
function routeOrthogonal(from: NodeBox, to: NodeBox, lane = 0.5): EdgePoint[] {
  const x1 = from.cx;
  const y1 = from.bottom;
  const x2 = to.cx;
  const y2 = to.top;
  if (y2 <= y1 + 4) {
    const midX = (x1 + x2) / 2;
    return [
      { x: x1, y: from.cy },
      { x: midX, y: from.cy },
      { x: midX, y: to.cy },
      { x: x2, y: to.cy },
    ];
  }
  if (Math.abs(x1 - x2) < 8) {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ];
  }
  // Lane between 0.35–0.65 so sibling branches don’t share one elbow
  const t = Math.min(0.7, Math.max(0.3, lane));
  const midY = Math.round(y1 + (y2 - y1) * t);
  return [
    { x: x1, y: y1 },
    { x: x1, y: midY },
    { x: x2, y: midY },
    { x: x2, y: y2 },
  ];
}

function labelAnchor(points: EdgePoint[]): EdgePoint {
  if (points.length < 2) return points[0] || { x: 0, y: 0 };
  // Prefer center of the longest segment (usually the horizontal branch)
  let bestI = 0;
  let bestLen = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      bestI = i;
    }
  }
  const a = points[bestI];
  const b = points[bestI + 1];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Keep labels off the stroke (Word preview is easier to read)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: mid.x, y: mid.y - 12 };
  }
  return { x: mid.x - 16, y: mid.y };
}

function rebuildOrthogonalEdges(root: Element): void {
  const nodes = collectNodeBoxes(root);
  if (!nodes.size) return;

  const paths = [
    ...root.querySelectorAll(
      'path.flowchart-link, path[data-et="edge"], .edgePaths path[data-points]'
    ),
  ];

  // Group edges by source for lane spacing
  const bySource = new Map<string, Element[]>();
  for (const path of paths) {
    const dataId = path.getAttribute('data-id') || '';
    const matched = matchEdgeNodes(dataId, nodes);
    if (!matched) continue;
    const list = bySource.get(matched.from.name) || [];
    list.push(path);
    bySource.set(matched.from.name, list);
  }

  for (const path of paths) {
    const dataId = path.getAttribute('data-id') || '';
    const matched = matchEdgeNodes(dataId, nodes);
    if (!matched) continue;
    const siblings = bySource.get(matched.from.name) || [path];
    const idx = Math.max(0, siblings.indexOf(path));
    const lane =
      siblings.length <= 1 ? 0.5 : 0.35 + (0.3 * idx) / Math.max(1, siblings.length - 1);
    const pts = routeOrthogonal(matched.from, matched.to, lane);
    const markerEnd = path.getAttribute('marker-end');
    path.setAttribute('d', pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(''));
    path.setAttribute('data-points', Buffer.from(JSON.stringify(pts)).toString('base64'));
    path.setAttribute('stroke', DOCX_THEME.line);
    path.setAttribute('fill', 'none');
    if (markerEnd) path.setAttribute('marker-end', markerEnd);

    const label = [...root.querySelectorAll('g.edgeLabel')].find((el) => {
      if ((el.textContent || '').replace(/\s+/g, ' ').trim() === '') return false;
      const parent = el.parentElement;
      if (parent?.classList.contains('edgeLabel')) return false;
      const id =
        el.getAttribute('data-id') || el.querySelector('[data-id]')?.getAttribute('data-id') || '';
      return id === dataId;
    });
    if (label) {
      const mid = labelAnchor(pts);
      label.setAttribute('transform', `translate(${mid.x}, ${mid.y})`);
      for (const child of label.children) {
        if (child.tagName.toLowerCase() !== 'g') continue;
        if (transformIsBroken(child.getAttribute('transform'))) {
          child.setAttribute('transform', 'translate(0, 0)');
        }
      }
    }
  }
}

function foreignObjectsToText(root: Element, doc: Document): void {
  for (const fo of [...root.querySelectorAll('foreignObject')]) {
    const text = (fo.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      fo.remove();
      continue;
    }
    const x = Number(fo.getAttribute('x') || 0);
    const y = Number(fo.getAttribute('y') || 0);
    const tw = Number(fo.getAttribute('width') || 0);
    const th = Number(fo.getAttribute('height') || 0);
    const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
    if (tw > 1 && th > 1) {
      textEl.setAttribute('x', String(x + tw / 2));
      textEl.setAttribute('y', String(y + th / 2));
    } else {
      textEl.setAttribute('x', '0');
      textEl.setAttribute('y', '0');
    }
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('dominant-baseline', 'middle');
    textEl.setAttribute('font-size', '14');
    textEl.setAttribute('font-family', DOCX_THEME.fontSans);
    textEl.setAttribute('fill', DOCX_THEME.text);
    textEl.textContent = text;
    fo.replaceWith(textEl);
  }
}

function parseSvgTransform(t: string | null): SvgMatrix {
  let a = 1;
  let b = 0;
  let c = 0;
  let d = 1;
  let e = 0;
  let f = 0;
  if (!t) return { a, b, c, d, e, f };
  const re = /(matrix|translate|scale)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const kind = m[1];
    const args = m[2]
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    if (kind === 'translate') {
      const tx = args[0] || 0;
      const ty = args[1] || 0;
      e = a * tx + c * ty + e;
      f = b * tx + d * ty + f;
    } else if (kind === 'scale') {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      a *= sx;
      b *= sx;
      c *= sy;
      d *= sy;
    } else if (kind === 'matrix' && args.length >= 6) {
      const [na, nb, nc, nd, ne, nf] = args;
      const oa = a;
      const ob = b;
      const oc = c;
      const od = d;
      const oe = e;
      const of = f;
      a = oa * na + oc * nb;
      b = ob * na + od * nb;
      c = oa * nc + oc * nd;
      d = ob * nc + od * nd;
      e = oa * ne + oc * nf + oe;
      f = ob * ne + od * nf + of;
    }
  }
  return { a, b, c, d, e, f };
}

function mulSvg(p: SvgMatrix, child: SvgMatrix): SvgMatrix {
  return {
    a: p.a * child.a + p.c * child.b,
    b: p.b * child.a + p.d * child.b,
    c: p.a * child.c + p.c * child.d,
    d: p.b * child.c + p.d * child.d,
    e: p.a * child.e + p.c * child.f + p.e,
    f: p.b * child.e + p.d * child.f + p.f,
  };
}

function applySvg(m: SvgMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function recomputeViewBox(root: Element): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const walk = (el: Element, mat: SvgMatrix) => {
    const m = mulSvg(mat, parseSvgTransform(el.getAttribute('transform')));
    const tag = el.tagName.toLowerCase();
    if (tag === 'rect') {
      const x = Number(el.getAttribute('x') || 0);
      const y = Number(el.getAttribute('y') || 0);
      const w = Number(el.getAttribute('width') || 0);
      const h = Number(el.getAttribute('height') || 0);
      for (const [px, py] of [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ] as const) {
        const p = applySvg(m, px, py);
        add(p.x, p.y);
      }
    } else if (tag === 'circle') {
      const cx = Number(el.getAttribute('cx') || 0);
      const cy = Number(el.getAttribute('cy') || 0);
      const r = Number(el.getAttribute('r') || 0);
      for (const [px, py] of [
        [cx - r, cy - r],
        [cx + r, cy + r],
      ] as const) {
        const p = applySvg(m, px, py);
        add(p.x, p.y);
      }
    } else if (tag === 'polygon' || tag === 'polyline') {
      const pts = (el.getAttribute('points') || '')
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const p = applySvg(m, pts[i], pts[i + 1]);
        add(p.x, p.y);
      }
    } else if (tag === 'path') {
      const nums = (el.getAttribute('d') || '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const p = applySvg(m, Number(nums[i]), Number(nums[i + 1]));
        add(p.x, p.y);
      }
    } else if (tag === 'text' || tag === 'tspan') {
      const x = Number(el.getAttribute('x') || 0);
      const y = Number(el.getAttribute('y') || 0);
      const p = applySvg(m, x, y);
      add(p.x - 40, p.y - 14);
      add(p.x + 40, p.y + 14);
    }
    for (const child of el.children) walk(child, m);
  };

  walk(root, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;
  const pad = 20;
  const x = minX - pad;
  const y = minY - pad;
  const w = Math.max(1, maxX - minX + 2 * pad);
  const h = Math.max(1, maxY - minY + 2 * pad);
  root.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  root.setAttribute('width', String(Math.ceil(w)));
  root.setAttribute('height', String(Math.ceil(h)));

  const bg = root.ownerDocument!.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(x));
  bg.setAttribute('y', String(y));
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('fill', DOCX_THEME.bg);
  root.insertBefore(bg, root.firstChild);
}

async function prepareMermaidSvgForRaster(svg: string): Promise<string> {
  const { JSDOM } = await import('jsdom');
  const parsed = new JSDOM(svg, { contentType: 'image/svg+xml' });
  const root = parsed.window.document.documentElement;
  rebuildOrthogonalEdges(root);
  foreignObjectsToText(root, parsed.window.document);
  recomputeViewBox(root);
  return root.outerHTML;
}

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;

async function ensureMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidReady) {
    mermaidReady = (async () => {
      const { JSDOM } = await import('jsdom');
      const dom = new JSDOM(
        '<!DOCTYPE html><html><body><div id="synapse-mmd-host" style="width:720px;height:auto"></div></body></html>',
        { pretendToBeVisual: true, url: 'https://localhost/' }
      );
      const w = dom.window;
      const g = globalThis as typeof globalThis & Record<string, unknown>;
      g.window = w as unknown as Window & typeof globalThis;
      g.document = w.document;
      g.DOMParser = w.DOMParser;
      g.XMLSerializer = w.XMLSerializer;
      Object.defineProperty(g, 'navigator', { value: w.navigator, configurable: true });
      g.HTMLElement = w.HTMLElement;
      g.SVGElement = w.SVGElement;
      g.Element = w.Element;
      g.Node = w.Node;
      g.getComputedStyle = w.getComputedStyle.bind(w);

      class CSSStyleSheetPoly {
        cssRules: Array<{ cssText: string }> = [];
        insertRule(rule: string, index?: number) {
          const i = index ?? this.cssRules.length;
          this.cssRules.splice(i, 0, { cssText: rule });
          return i;
        }
        deleteRule(index: number) {
          this.cssRules.splice(index, 1);
        }
        replaceSync() {}
        replace() {
          return Promise.resolve(this);
        }
      }
      g.CSSStyleSheet = CSSStyleSheetPoly as unknown as typeof CSSStyleSheet;
      (w as unknown as { CSSStyleSheet: typeof CSSStyleSheetPoly }).CSSStyleSheet = CSSStyleSheetPoly;

      const measure = (el: Element): { x: number; y: number; width: number; height: number } => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'text' || tag === 'tspan') {
          const text = el.textContent || '';
          const fontSize = Number.parseFloat(el.getAttribute('font-size') || '14') || 14;
          return {
            x: Number(el.getAttribute('x') || 0),
            y: Number(el.getAttribute('y') || 0) - fontSize,
            width: Math.max(24, text.length * fontSize * 0.6),
            height: fontSize * 1.3,
          };
        }
        const fo = el.querySelector?.('foreignObject');
        if (fo) {
          const text = (fo.textContent || '').replace(/\s+/g, ' ').trim();
          const est = estimateTextSize(text);
          const wAttr = Number(fo.getAttribute('width') || 0);
          const hAttr = Number(fo.getAttribute('height') || 0);
          return {
            x: Number(fo.getAttribute('x') || 0),
            y: Number(fo.getAttribute('y') || 0),
            width: Math.max(est.w, wAttr > 1 ? wAttr : 0),
            height: Math.max(est.h, hAttr > 1 ? hAttr : 0),
          };
        }
        if (tag === 'rect') {
          return {
            x: Number(el.getAttribute('x') || 0),
            y: Number(el.getAttribute('y') || 0),
            width: Number(el.getAttribute('width') || 40),
            height: Number(el.getAttribute('height') || 20),
          };
        }
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const child of el.children || []) {
          const b = measure(child);
          minX = Math.min(minX, b.x);
          minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.width);
          maxY = Math.max(maxY, b.y + b.height);
        }
        if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 80, height: 30 };
        return {
          x: minX,
          y: minY,
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
        };
      };

      const proto = w.SVGElement.prototype as SVGElement & {
        getBBox: () => DOMRect;
        getComputedTextLength: () => number;
      };
      proto.getBBox = function getBBox(this: Element) {
        return measure(this) as DOMRect;
      };
      proto.getComputedTextLength = function getComputedTextLength(this: Element) {
        return Math.max(10, (this.textContent || '').length * 8);
      };

      const mermaid = (await import('mermaid')).default;
      try {
        const elkMod = await import('@mermaid-js/layout-elk');
        const elkLayouts = (elkMod as { default?: unknown }).default ?? elkMod;
        if (Array.isArray(elkLayouts) && elkLayouts.length) {
          mermaid.registerLayoutLoaders(elkLayouts);
        }
      } catch (error) {
        logger.warn('Mermaid ELK layout unavailable for DOCX', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      mermaid.initialize(synapseDocxInit());
      return mermaid;
    })();
  }
  return mermaidReady;
}

async function svgToPng(svg: string): Promise<Buffer | null> {
  const { spawn } = await import('child_process');
  const { mkdtemp, writeFile, readFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  const dir = await mkdtemp(join(tmpdir(), 'synapse-mmd-'));
  const svgPath = join(dir, 'd.svg');
  const pngPath = join(dir, 'd.png');
  try {
    await writeFile(svgPath, svg, 'utf8');
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        'rsvg-convert',
        ['-w', '720', '-b', DOCX_THEME.bg, '-f', 'png', '-o', pngPath, svgPath],
        { stdio: 'ignore' }
      );
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
    if (!ok) return null;
    return await readFile(pngPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) {
    return { width: 720, height: 400 };
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export async function renderMermaidPngForDocx(
  source: string
): Promise<{ png: Buffer; width: number; height: number } | null> {
  try {
    const mermaid = await ensureMermaid();
    const id = `mmd_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const preparedSource = withElkConfig(source);
    const host = (globalThis as { document?: Document }).document?.getElementById?.(
      'synapse-mmd-host'
    );
    const { svg } = host
      ? await mermaid.render(id, preparedSource, host)
      : await mermaid.render(id, preparedSource);
    const preparedSvg = await prepareMermaidSvgForRaster(svg);
    const png = await svgToPng(preparedSvg);
    if (!png) {
      logger.warn('Mermaid SVG→PNG failed (is rsvg-convert / librsvg installed?)');
      return null;
    }
    const { width, height } = pngDimensions(png);
    return { png, width, height };
  } catch (error) {
    logger.warn('Mermaid render for DOCX failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
