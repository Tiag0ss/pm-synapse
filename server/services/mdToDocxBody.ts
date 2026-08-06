import katex from 'katex';
import logger from '../utils/logger';
import { renderMermaidPngForDocx } from './mermaidDocxRender';

export type HeadingStyles = Record<1 | 2 | 3 | 4, string>;

export type DocxMediaFile = {
  /** Path inside the docx zip, e.g. word/media/image1.png */
  path: string;
  buffer: Buffer;
  /** Relationship id, e.g. rId1001 */
  relId: string;
  contentType: string;
};

export type MdRenderResult = {
  ooxml: string;
  media: DocxMediaFile[];
};

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wordParagraph(text: string, opts?: { styleId?: string; bold?: boolean; mono?: boolean }): string {
  const t = escapeXml(text);
  const pPr = opts?.styleId
    ? `<w:pPr><w:pStyle w:val="${escapeXml(opts.styleId)}"/></w:pPr>`
    : '';
  const rPrParts: string[] = [];
  if (opts?.bold) rPrParts.push('<w:b/>');
  if (opts?.mono) {
    rPrParts.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
    rPrParts.push('<w:sz w:val="18"/>');
  }
  const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join('')}</w:rPr>` : '';
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
}

function stripInlineMd(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\{\{toc\}\}|\[\[toc\]\]/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function renderMathToPlain(tex: string, display: boolean): string {
  try {
    // Prefer readable MathML textContent via KaTeX HTML then strip tags
    const html = katex.renderToString(tex, {
      throwOnError: false,
      displayMode: display,
      output: 'html',
    });
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim() || tex;
  } catch {
    return tex;
  }
}

function replaceMathInLine(s: string): string {
  let out = s;
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => renderMathToPlain(String(tex).trim(), true));
  out = out.replace(/\$([^$\n]+?)\$/g, (_m, tex) => renderMathToPlain(String(tex).trim(), false));
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => renderMathToPlain(String(tex).trim(), false));
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => renderMathToPlain(String(tex).trim(), true));
  return out;
}

function ooxmlTable(headers: string[], rows: string[][]): string {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const width = Math.floor(9000 / colCount);
  const grid = Array.from({ length: colCount }, () => `<w:gridCol w:w="${width}"/>`).join('');

  const cell = (text: string, header: boolean) => {
    const shading = header
      ? '<w:tcPr><w:shd w:val="clear" w:fill="1F2937"/></w:tcPr>'
      : '<w:tcPr/>';
    const run = header
      ? `<w:r><w:rPr><w:b/><w:color w:val="E8EEF6"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
      : `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    return `<w:tc>${shading}<w:p>${run}</w:p></w:tc>`;
  };

  const headerRow = `<w:tr>${headers
    .concat(Array(Math.max(0, colCount - headers.length)).fill(''))
    .slice(0, colCount)
    .map((h) => cell(h, true))
    .join('')}</w:tr>`;

  const bodyRows = rows
    .map((row) => {
      const cells = row.concat(Array(Math.max(0, colCount - row.length)).fill('')).slice(0, colCount);
      return `<w:tr>${cells.map((c) => cell(c, false)).join('')}</w:tr>`;
    })
    .join('');

  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="334155"/>
    <w:left w:val="single" w:sz="4" w:color="334155"/>
    <w:bottom w:val="single" w:sz="4" w:color="334155"/>
    <w:right w:val="single" w:sz="4" w:color="334155"/>
    <w:insideH w:val="single" w:sz="4" w:color="334155"/>
    <w:insideV w:val="single" w:sz="4" w:color="334155"/>
  </w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>${wordParagraph('')}`;
}

function ooxmlImage(relId: string, cxEmu: number, cyEmu: number): string {
  const docPrId = Math.floor(Math.random() * 100000) + 1;
  return `<w:p><w:r><w:drawing>
    <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
      xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
      distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${cxEmu}" cy="${cyEmu}"/>
      <wp:docPr id="${docPrId}" name="Diagram"/>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:nvPicPr><pic:cNvPr id="0" name="diagram.png"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="${escapeXml(relId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cxEmu}" cy="${cyEmu}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing></w:r></w:p>`;
}

export type MdToDocxOptions = {
  vaultId?: number;
};

function pngDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50) {
    return { width: 720, height: 400 };
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function gifDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10 || buf[0] !== 0x47 || buf[1] !== 0x49) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function imageDimensions(
  buf: Buffer,
  mime: string
): { width: number; height: number } {
  if (mime === 'image/png') return pngDimensions(buf);
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return jpegDimensions(buf) || { width: 720, height: 400 };
  }
  if (mime === 'image/gif') return gifDimensions(buf) || { width: 720, height: 400 };
  return { width: 720, height: 400 };
}

function emuSize(widthPx: number, heightPx: number): { cx: number; cy: number } {
  const maxCx = 5486400; // ~6.5"
  const scale = Math.min(1, maxCx / Math.max(1, widthPx * 9525));
  return {
    cx: Math.round(widthPx * 9525 * scale),
    cy: Math.round(heightPx * 9525 * scale),
  };
}

function mimeToExt(mime: string): string {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpeg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'png'; // converted
  return 'png';
}

function mimeToContentType(mime: string): string {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'image/gif') return 'image/gif';
  if (mime === 'image/webp') return 'image/webp';
  return 'image/png';
}


async function svgToPng(svg: string): Promise<Buffer | null> {
  const { spawn } = await import('child_process');
  const { mkdtemp, writeFile, readFile, rm } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  const dir = await mkdtemp(join(tmpdir(), 'synapse-svg-'));
  const svgPath = join(dir, 'd.svg');
  const pngPath = join(dir, 'd.png');
  try {
    await writeFile(svgPath, svg, 'utf8');
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(
        'rsvg-convert',
        ['-w', '720', '-f', 'png', '-o', pngPath, svgPath],
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

const VAULT_MEDIA_URL_RE =
  /(?:https?:\/\/[^/\s]+)?\/api\/vaults\/(\d+)\/media\/(\d+)/i;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

async function loadVaultImageForDocx(
  vaultId: number,
  url: string
): Promise<{ buffer: Buffer; mimeType: string; width: number; height: number } | null> {
  const m = VAULT_MEDIA_URL_RE.exec(url.trim());
  if (!m) return null;
  const urlVaultId = Number(m[1]);
  const mediaId = Number(m[2]);
  if (urlVaultId !== vaultId || !Number.isFinite(mediaId)) return null;

  try {
    const { readVaultMedia } = await import('./vaultMedia');
    const file = await readVaultMedia(vaultId, mediaId);
    if (!file) return null;

    let buffer = file.buffer;
    let mimeType = file.mimeType.split(';')[0].trim().toLowerCase();

    // Non-image attachments stay as hyperlinks in the DOCX body — do not embed.
    if (!mimeType.startsWith('image/')) return null;

    if (mimeType === 'image/svg+xml') {
      const png = await svgToPng(buffer.toString('utf8'));
      if (!png) return null;
      buffer = png;
      mimeType = 'image/png';
    }

    const { width, height } = imageDimensions(buffer, mimeType);
    return { buffer, mimeType, width, height };
  } catch (error) {
    logger.warn('Vault image for DOCX failed', {
      vaultId,
      mediaId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function parsePipeTable(lines: string[], start: number): { headers: string[]; rows: string[][]; next: number } | null {
  if (start >= lines.length || !/\|/.test(lines[start])) return null;
  const headerLine = lines[start];
  if (start + 1 >= lines.length || !/^\s*\|?[\s:-|]+ \|/.test(lines[start + 1]) && !/^\s*\|?[\s:-]+\|/.test(lines[start + 1])) {
    // require separator row
    if (start + 1 >= lines.length || !/[-:]/.test(lines[start + 1]) || !/\|/.test(lines[start + 1])) {
      return null;
    }
  }
  const splitRow = (line: string) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => stripInlineMd(replaceMathInLine(c.trim())));

  const headers = splitRow(headerLine);
  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length && /\|/.test(lines[i]) && !/^\s*```/.test(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  return { headers, rows, next: i };
}

/**
 * Convert note Markdown body into OOXML fragment (+ optional PNG media for Mermaid / vault images).
 */
export async function markdownToDocxFragment(
  markdown: string,
  headingStyles: HeadingStyles,
  options: MdToDocxOptions = {}
): Promise<MdRenderResult> {
  const media: DocxMediaFile[] = [];
  const parts: string[] = [];
  let s = String(markdown || '').replace(/^\uFEFF/, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  const lines = s.split(/\n/);
  let i = 0;
  let mediaIndex = 0;

  const pushHeading = (level: 1 | 2 | 3 | 4, text: string) => {
    parts.push(wordParagraph(stripInlineMd(replaceMathInLine(text)), { styleId: headingStyles[level] }));
  };

  const pushEmbeddedImage = async (url: string, alt: string) => {
    if (!options.vaultId) {
      parts.push(wordParagraph(alt ? `[Image: ${alt}]` : '[Image]'));
      return;
    }
    const img = await loadVaultImageForDocx(options.vaultId, url);
    if (!img) {
      parts.push(wordParagraph(alt ? `[Image: ${alt}]` : '[Image — not found]'));
      return;
    }
    mediaIndex++;
    const ext = mimeToExt(img.mimeType);
    const relId = `rIdSynapse${1000 + mediaIndex}`;
    const path = `word/media/synapse_img_${mediaIndex}.${ext}`;
    media.push({
      path,
      buffer: img.buffer,
      relId,
      contentType: mimeToContentType(img.mimeType),
    });
    const { cx, cy } = emuSize(img.width, img.height);
    parts.push(ooxmlImage(relId, cx, cy));
    if (alt) parts.push(wordParagraph(alt));
  };

  const pushParagraphWithOptionalImages = async (rawLine: string) => {
    const line = replaceMathInLine(rawLine).replace(/\[\^([^\]]+)\]/g, '[$1]');
    const matches = [...line.matchAll(MD_IMAGE_RE)];
    if (!matches.length) {
      parts.push(wordParagraph(stripInlineMd(line)));
      return;
    }
    let last = 0;
    for (const match of matches) {
      const idx = match.index ?? 0;
      const before = line.slice(last, idx).trim();
      if (before) parts.push(wordParagraph(stripInlineMd(before)));
      await pushEmbeddedImage(match[2], match[1] || '');
      last = idx + match[0].length;
    }
    const after = line.slice(last).trim();
    if (after) parts.push(wordParagraph(stripInlineMd(after)));
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code / mermaid
    const fence = /^```([\w-]*)\s*$/.exec(line.trim());
    if (fence) {
      const lang = (fence[1] || '').toLowerCase();
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        bodyLines.push(lines[i]);
        i++;
      }
      i++; // closing ```
      const code = bodyLines.join('\n');

      if (lang === 'mermaid') {
        const png = await renderMermaidPngForDocx(code);
        if (png) {
          mediaIndex++;
          const relId = `rIdSynapse${1000 + mediaIndex}`;
          const path = `word/media/synapse_mmd_${mediaIndex}.png`;
          media.push({ path, buffer: png.png, relId, contentType: 'image/png' });
          const { cx, cy } = emuSize(png.width, png.height);
          parts.push(ooxmlImage(relId, cx, cy));
          parts.push(wordParagraph(''));
        } else {
          parts.push(wordParagraph('[Mermaid diagram — could not render]', { bold: true }));
          for (const cl of bodyLines) parts.push(wordParagraph(cl, { mono: true }));
          parts.push(wordParagraph(''));
        }
        continue;
      }

      if (lang) parts.push(wordParagraph(`${lang}`, { bold: true, mono: true }));
      for (const cl of bodyLines) parts.push(wordParagraph(cl || ' ', { mono: true }));
      parts.push(wordParagraph(''));
      continue;
    }

    // Display math block $$ ... $$
    if (/^\$\$\s*$/.test(line.trim()) || /^\\\[\s*$/.test(line.trim())) {
      const closer = /^\$\$\s*$/.test(line.trim()) ? /^\$\$\s*$/ : /^\\\]\s*$/;
      const mathLines: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i].trim())) {
        mathLines.push(lines[i]);
        i++;
      }
      i++; // closing
      const tex = mathLines.join('\n').trim();
      parts.push(wordParagraph(renderMathToPlain(tex, true), { mono: true }));
      parts.push(wordParagraph(''));
      continue;
    }
    const oneLineDisplay = /^\$\$([\s\S]+?)\$\$\s*$/.exec(line.trim());
    if (oneLineDisplay) {
      parts.push(wordParagraph(renderMathToPlain(oneLineDisplay[1].trim(), true), { mono: true }));
      i++;
      continue;
    }

    // Standalone image line
    const aloneImg = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (aloneImg) {
      await pushEmbeddedImage(aloneImg[2], aloneImg[1] || '');
      parts.push(wordParagraph(''));
      i++;
      continue;
    }

    // GFM table
    const table = parsePipeTable(lines, i);
    if (table) {
      parts.push(ooxmlTable(table.headers, table.rows));
      i = table.next;
      continue;
    }

    // Headings
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      pushHeading(h[1].length as 1 | 2 | 3 | 4, h[2]);
      i++;
      continue;
    }

    // HR
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      parts.push(
        `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="334155"/></w:pBdr></w:pPr><w:r><w:t></w:t></w:r></w:p>`
      );
      i++;
      continue;
    }

    // Callout / blockquote
    if (/^>\s?/.test(line)) {
      const chunk: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        chunk.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const joined = chunk.join(' ').trim();
      const callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(joined);
      if (callout) {
        const kind = callout[1].toUpperCase();
        const rest = callout[2] || '';
        parts.push(
          wordParagraph(`${kind}${rest ? `: ${stripInlineMd(replaceMathInLine(rest))}` : ''}`, {
            bold: true,
          })
        );
      } else {
        parts.push(wordParagraph(stripInlineMd(replaceMathInLine(joined))));
      }
      continue;
    }

    // Lists
    const ol = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      parts.push(wordParagraph(`${ol[1]}. ${stripInlineMd(replaceMathInLine(ol[2]))}`));
      i++;
      continue;
    }
    const ul = /^[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      // Checkbox tasks keep bullet text
      const task = /^\[([ xX])\]\s+(.*)$/.exec(ul[1]);
      if (task) {
        const mark = task[1].toLowerCase() === 'x' ? '☑' : '☐';
        parts.push(wordParagraph(`${mark} ${stripInlineMd(replaceMathInLine(task[2]))}`));
      } else {
        parts.push(wordParagraph(`• ${stripInlineMd(replaceMathInLine(ul[1]))}`));
      }
      i++;
      continue;
    }

    // Footnote definition
    const fnDef = /^\[\^([^\]]+)\]:\s*(.*)$/.exec(line);
    if (fnDef) {
      parts.push(
        wordParagraph(`[Footnote ${fnDef[1]}] ${stripInlineMd(replaceMathInLine(fnDef[2]))}`, {
          mono: true,
        })
      );
      i++;
      continue;
    }

    // Blank
    if (!line.trim()) {
      i++;
      continue;
    }

    // Normal paragraph (may include images / footnote refs)
    await pushParagraphWithOptionalImages(line);
    i++;
  }

  if (!parts.length) parts.push(wordParagraph(''));
  return { ooxml: parts.join(''), media };
}
