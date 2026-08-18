/** Keep in sync with lib/markdownEnhance.ts */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import csharp from 'highlight.js/lib/languages/csharp';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import plaintext from 'highlight.js/lib/languages/plaintext';
import type KatexApi from 'katex';
import { marked } from 'marked';

/** Lazy-load KaTeX so Next/webpack does not eagerly emit a fragile vendor chunk. */
let katexApi: typeof KatexApi | null = null;
function katex(): typeof KatexApi {
  if (!katexApi) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    katexApi = require('katex');
  }
  return katexApi!;
}

/** Languages loaded for fenced code highlighting (keep list small). */
const LANGS: Array<[string, typeof javascript]> = [
  ['javascript', javascript],
  ['js', javascript],
  ['typescript', typescript],
  ['ts', typescript],
  ['tsx', typescript],
  ['jsx', javascript],
  ['json', json],
  ['html', xml],
  ['xml', xml],
  ['svg', xml],
  ['css', css],
  ['bash', bash],
  ['sh', bash],
  ['shell', bash],
  ['zsh', bash],
  ['python', python],
  ['py', python],
  ['sql', sql],
  ['markdown', markdown],
  ['md', markdown],
  ['yaml', yaml],
  ['yml', yaml],
  ['java', java],
  ['go', go],
  ['rust', rust],
  ['cs', csharp],
  ['csharp', csharp],
  ['php', php],
  ['ruby', ruby],
  ['rb', ruby],
  ['plaintext', plaintext],
  ['text', plaintext],
];

let hljsReady = false;
function ensureHljs() {
  if (hljsReady) return;
  for (const [name, mod] of LANGS) {
    try {
      hljs.registerLanguage(name, mod);
    } catch {
      /* already registered */
    }
  }
  hljsReady = true;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'section';
}

/** Protect fenced/inline code from transforms. */
export function mapProtectedMd(md: string, transform: (chunk: string) => string): string {
  const slots: string[] = [];
  const stash = (raw: string) => {
    slots.push(raw);
    return `\u0000MD${slots.length - 1}\u0000`;
  };
  let out = md.replace(/```[\s\S]*?```/g, stash).replace(/`[^`\n]+`/g, stash);
  out = transform(out);
  return out.replace(/\u0000MD(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');
}

const CALLOUT_TYPES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  info: 'Info',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
  danger: 'Danger',
  success: 'Success',
  question: 'Question',
  abstract: 'Abstract',
  summary: 'Summary',
  todo: 'Todo',
  hint: 'Hint',
  quote: 'Quote',
  example: 'Example',
  bug: 'Bug',
  failure: 'Failure',
  error: 'Error',
};

/**
 * Obsidian / GitHub-style callouts:
 * > [!NOTE] Optional title
 * > [!NOTE]- Title   (foldable, starts collapsed)
 * > [!NOTE]+ Title   (foldable, starts expanded)
 * > body
 */
export function preprocessCallouts(md: string): string {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^>\s*\[!([A-Za-z]+)\]([+-])?\s*(.*)$/);
    if (!m) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const typeKey = m[1].toLowerCase();
    const foldFlag = m[2] as '+' | '-' | undefined;
    const typeLabel = CALLOUT_TYPES[typeKey] || m[1];
    const title = m[3].trim() || typeLabel;
    const bodyLines: string[] = [];
    i += 1;
    while (i < lines.length && /^>/.test(lines[i])) {
      bodyLines.push(lines[i].replace(/^>\s?/, ''));
      i += 1;
    }
    const bodyMd = bodyLines.join('\n').trim();
    let bodyHtml = '';
    if (bodyMd) {
      try {
        bodyHtml = marked.parse(bodyMd, { async: false, gfm: true, breaks: true }) as string;
      } catch {
        bodyHtml = `<p>${escapeHtml(bodyMd)}</p>`;
      }
    }
    const bodyBlock = bodyHtml ? `<div class="synapse-callout-body">${bodyHtml}</div>` : '';
    if (foldFlag) {
      const openAttr = foldFlag === '+' ? ' open' : '';
      out.push(
        `<details class="synapse-callout synapse-callout-${escapeAttr(typeKey)}" data-callout="${escapeAttr(typeKey)}"${openAttr}>` +
          `<summary class="synapse-callout-title">${escapeHtml(title)}</summary>` +
          bodyBlock +
          `</details>`
      );
    } else {
      out.push(
        `<aside class="synapse-callout synapse-callout-${escapeAttr(typeKey)}" data-callout="${escapeAttr(typeKey)}">` +
          `<p class="synapse-callout-title">${escapeHtml(title)}</p>` +
          bodyBlock +
          `</aside>`
      );
    }
    out.push('');
  }
  return out.join('\n');
}

const FOLD_OPEN = /^:::fold([+-])?\s*(.*)$/;
const FOLD_CLOSE = /^:::\s*$/;

/**
 * Neutral collapsible sections (Wikipedia-style, not callouts):
 * :::fold Title          starts expanded
 * :::fold- Title         starts collapsed
 * :::fold+ Title         starts expanded
 * body
 * :::
 */
export function preprocessFolds(md: string): string {
  return mapProtectedMd(md || '', preprocessFoldsUnprotected);
}

function preprocessFoldsUnprotected(chunk: string): string {
  const lines = chunk.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(FOLD_OPEN);
    if (!m) {
      out.push(lines[i]);
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
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const foldFlag = m[1] as '+' | '-' | undefined;
    const title = m[2].trim() || 'Section';
    const bodyMd = preprocessFoldsUnprotected(lines.slice(i + 1, close).join('\n')).trim();
    let bodyHtml = '';
    if (bodyMd) {
      try {
        bodyHtml = marked.parse(bodyMd, { async: false, gfm: true, breaks: true }) as string;
      } catch {
        bodyHtml = `<p>${escapeHtml(bodyMd)}</p>`;
      }
    }
    const openAttr = foldFlag === '-' ? '' : ' open';
    out.push(
      `<details class="synapse-fold"${openAttr}>` +
        `<summary class="synapse-fold-title">${escapeHtml(title)}</summary>` +
        (bodyHtml ? `<div class="synapse-fold-body">${bodyHtml}</div>` : '') +
        `</details>`
    );
    out.push('');
    i = close + 1;
  }
  return out.join('\n');
}

/** `[[toc]]` or `[toc]` alone on a line → TOC from #–###### headings. */
export function preprocessToc(md: string): string {
  const hasToc = /^(\[\[toc\]\]|\[toc\])\s*$/im.test(md);
  if (!hasToc) return md;

  const headings: Array<{ level: number; text: string; id: string }> = [];
  const used = new Map<string, number>();
  mapProtectedMd(md, (chunk) => {
    for (const line of chunk.split('\n')) {
      const hm = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!hm) continue;
      const level = hm[1].length;
      const text = hm[2].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`~]/g, '').trim();
      let id = slugifyHeading(text);
      const n = (used.get(id) || 0) + 1;
      used.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      headings.push({ level, text, id });
    }
    return chunk;
  });

  if (!headings.length) {
    return md.replace(/^(\[\[toc\]\]|\[toc\])\s*$/gim, '');
  }

  const minLevel = Math.min(...headings.map((h) => h.level));
  const items = headings
    .map((h) => {
      const depth = Math.min(4, Math.max(0, h.level - minLevel));
      return (
        `<li class="synapse-toc-item synapse-toc-depth-${depth}">` +
        `<a class="synapse-toc-link" href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a>` +
        `</li>`
      );
    })
    .join('');
  const tocHtml =
    `\n\n<nav class="synapse-toc" aria-label="Table of contents">` +
    `<p class="synapse-toc-title">Contents</p>` +
    `<ul class="synapse-toc-list">${items}</ul>` +
    `</nav>\n\n`;

  return md.replace(/^(\[\[toc\]\]|\[toc\])\s*$/gim, tocHtml);
}

/**
 * Turn <!--synapse:cb:id--> left in marked HTML into spans for Planner buttons.
 * Keep in sync with lib/markdownEnhance.ts.
 */
export function promoteCheckboxMarkers(html: string): string {
  return (html || '').replace(
    /<!--\s*synapse:cb:([a-zA-Z0-9_-]+)\s*-->/g,
    '<span class="synapse-cb-marker" data-marker-id="$1" hidden="hidden"></span>'
  );
}

/**
 * Mark GFM task <li>s. Handles tight (`<li><input>`) and loose
 * (`<li><p><input>` — blank line between items in CommonMark).
 * Keep in sync with lib/markdownEnhance.ts.
 */
export function markTaskListItems(html: string): string {
  let out = (html || '').replace(
    /<li(\b[^>]*)>((?:\s|<p\b[^>]*>)*)(<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*>)/gi,
    (_m, liAttrs: string, prefix: string, input: string) => {
      let attrs = String(liAttrs || '');
      if (!/\btask-list-item\b/.test(attrs)) {
        if (/\bclass\s*=\s*"/i.test(attrs)) {
          attrs = attrs.replace(/\bclass\s*=\s*"/i, 'class="task-list-item ');
        } else {
          attrs = ` class="task-list-item"${attrs}`;
        }
      }
      const killMarker = 'list-style:none;list-style-type:none;';
      if (/\bstyle\s*=\s*"/i.test(attrs)) {
        attrs = attrs.replace(/\bstyle\s*=\s*"/i, `style="${killMarker}`);
      } else {
        attrs += ` style="${killMarker}"`;
      }
      return `<li${attrs}>${prefix}${input}`;
    }
  );

  out = out.replace(/<ul(\b[^>]*)>/gi, (full, attrs: string, offset: number) => {
    if (/\bcontains-task-list\b/.test(attrs)) return full;
    const after = out.slice(offset + full.length, offset + full.length + 320);
    if (!/^\s*<li\b[^>]*\btask-list-item\b/.test(after)) return full;
    let nextAttrs = String(attrs || '');
    if (/\bclass\s*=\s*"/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\bclass\s*=\s*"/i, 'class="contains-task-list ');
    } else {
      nextAttrs = ` class="contains-task-list"${nextAttrs}`;
    }
    const ulStyle = 'list-style:none;list-style-type:none;';
    if (/\bstyle\s*=\s*"/i.test(nextAttrs)) {
      nextAttrs = nextAttrs.replace(/\bstyle\s*=\s*"/i, `style="${ulStyle}`);
    } else {
      nextAttrs += ` style="${ulStyle}"`;
    }
    return `<ul${nextAttrs}>`;
  });

  return out;
}

/** Assign stable ids to h1–h6 so TOC links can scroll to sections. */
export function applyHeadingIds(html: string): string {
  const used = new Map<string, number>();
  return html.replace(
    /<(h[1-6])(\b[^>]*)>([\s\S]*?)<\/\1>/gi,
    (_m, tag: string, attrs: string, inner: string) => {
      if (/\sid\s*=/.test(attrs)) return `<${tag}${attrs}>${inner}</${tag}>`;
      const text = inner
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
      let id = slugifyHeading(text);
      const n = (used.get(id) || 0) + 1;
      used.set(id, n);
      if (n > 1) id = `${id}-${n}`;
      return `<${tag}${attrs} id="${escapeAttr(id)}">${inner}</${tag}>`;
    }
  );
}

/** Footnotes: `[^id]` + `[^id]: text` definitions. */
export function preprocessFootnotes(md: string): string {
  return mapProtectedMd(md || '', (chunk) => {
    const defs = new Map<string, string>();
    let body = chunk.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_m, id: string, text: string) => {
      defs.set(String(id).trim(), text.trim());
      return '';
    });
    if (!defs.size) return chunk;

    const order: string[] = [];
    body = body.replace(/\[\^([^\]]+)\]/g, (_m, id: string) => {
      const key = String(id).trim();
      if (!defs.has(key)) return _m;
      if (!order.includes(key)) order.push(key);
      const n = order.indexOf(key) + 1;
      return `<sup class="synapse-fn-ref"><a href="#fn-${escapeAttr(key)}" id="fnref-${escapeAttr(key)}">${n}</a></sup>`;
    });

    const list = order
      .map((key, i) => {
        const text = defs.get(key) || '';
        return `<li id="fn-${escapeAttr(key)}"><span class="synapse-fn-n">${i + 1}.</span> ${escapeHtml(text)} <a class="synapse-fn-back" href="#fnref-${escapeAttr(key)}" title="Back to reference">↩</a></li>`;
      })
      .join('');
    return `${body.trimEnd()}\n\n<section class="synapse-footnotes" aria-label="Footnotes"><ol>${list}</ol></section>`;
  });
}

/** KaTeX → HTML safe to pass through marked (no MathML annotations with lone `=`). */
function renderKatex(expr: string, displayMode: boolean): string {
  const html = katex().renderToString(expr.trim(), {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    // HTML-only: MathML annotations keep raw TeX newlines; a lone `=` becomes a setext <h1> in marked
    output: 'html',
  });
  if (displayMode) {
    // <div> is a CommonMark HTML block — marked will not re-parse the interior as Markdown
    return `\n\n<div class="synapse-math-display">${html}</div>\n\n`;
  }
  return `<span class="synapse-math-inline">${html}</span>`;
}

/** Inline `$...$` and block `$$...$$` → KaTeX HTML. */
export function preprocessMath(md: string): string {
  return mapProtectedMd(md || '', (chunk) => {
    let next = chunk.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr: string) => {
      try {
        return renderKatex(expr, true);
      } catch {
        return `\n\n<pre class="synapse-math-error">${escapeHtml(expr)}</pre>\n\n`;
      }
    });
    next = next.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (_m, lead: string, expr: string) => {
      try {
        return lead + renderKatex(expr, false);
      } catch {
        return `${lead}<code class="synapse-math-error">${escapeHtml(expr)}</code>`;
      }
    });
    return next;
  });
}

const SKIP_HIGHLIGHT = new Set(['mermaid', 'math', 'katex', 'plaintext', 'text', '']);

/** Highlight fenced code; leave mermaid for client render. */
export function highlightCodeBlocks(html: string): string {
  ensureHljs();
  return html.replace(
    /<pre(\b[^>]*)><code(\b[^>]*\bclass="[^"]*\blanguage-([^"\s]+)[^"]*"[^>]*)>([\s\S]*?)<\/code><\/pre>/gi,
    (_m, preAttrs: string, codeAttrs: string, langRaw: string, codeHtml: string) => {
      const lang = String(langRaw || '').toLowerCase().trim();
      if (lang === 'mermaid' || lang.startsWith('mermaid')) {
        return `<pre class="synapse-mermaid-source"><code class="language-mermaid">${codeHtml}</code></pre>`;
      }
      if (SKIP_HIGHLIGHT.has(lang)) {
        return `<pre${preAttrs}><code${codeAttrs}>${codeHtml}</code></pre>`;
      }
      const text = codeHtml
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"');
      try {
        const result = hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang, ignoreIllegals: true })
          : hljs.highlightAuto(text);
        return `<pre class="hljs"><code class="language-${escapeAttr(lang)} hljs">${result.value}</code></pre>`;
      } catch {
        return `<pre${preAttrs}><code${codeAttrs}>${codeHtml}</code></pre>`;
      }
    }
  );
}

/** Full extras pass before Synapse wikilink preprocess (call on frontmatter body). */
export function preprocessMarkdownExtras(md: string): string {
  let out = md || '';
  out = preprocessToc(out);
  out = preprocessCallouts(out);
  out = preprocessFootnotes(out);
  out = preprocessMath(out);
  out = preprocessFolds(out);
  return out;
}

/** Full extras pass after marked.parse. */
export function postprocessMarkdownHtml(html: string): string {
  let out = html || '';
  out = promoteCheckboxMarkers(out);
  out = markTaskListItems(out);
  out = applyHeadingIds(out);
  out = highlightCodeBlocks(out);
  return out;
}
