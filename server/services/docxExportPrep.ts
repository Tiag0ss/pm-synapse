import JSZip from 'jszip';

export type MdBlock =
  | { kind: 'h1' | 'h2' | 'h3' | 'h4'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'li'; text: string; ordered: boolean; num?: number };

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse note body Markdown into blocks for Word paragraph styles. */
export function markdownToBlocks(markdown: string): MdBlock[] {
  let s = String(markdown || '').replace(/^\uFEFF/, '');
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  const blocks: MdBlock[] = [];
  for (const raw of s.split(/\n/)) {
    const line = raw.replace(/\s+$/g, '');
    if (!line.trim()) continue;
    const h = /^(#{1,4})\s+(.+)$/.exec(line);
    if (h) {
      const level = h[1].length as 1 | 2 | 3 | 4;
      blocks.push({ kind: `h${level}` as 'h1' | 'h2' | 'h3' | 'h4', text: h[2].trim() });
      continue;
    }
    const ol = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      blocks.push({ kind: 'li', text: ol[2].trim(), ordered: true, num: Number(ol[1]) });
      continue;
    }
    const ul = /^[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      blocks.push({ kind: 'li', text: ul[1].trim(), ordered: false });
      continue;
    }
    blocks.push({
      kind: 'p',
      text: line.replace(/^>\s?/, '').trim(),
    });
  }
  return blocks;
}

function wordParagraph(text: string, styleId?: string): string {
  const t = escapeXml(text);
  const pPr = styleId
    ? `<w:pPr><w:pStyle w:val="${escapeXml(styleId)}"/></w:pPr>`
    : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
}

export function blocksToOoxml(
  blocks: MdBlock[],
  headingStyles: Record<1 | 2 | 3 | 4, string>
): string {
  if (!blocks.length) return wordParagraph('');
  return blocks
    .map((b) => {
      if (b.kind === 'h1') return wordParagraph(b.text, headingStyles[1]);
      if (b.kind === 'h2') return wordParagraph(b.text, headingStyles[2]);
      if (b.kind === 'h3') return wordParagraph(b.text, headingStyles[3]);
      if (b.kind === 'h4') return wordParagraph(b.text, headingStyles[4]);
      if (b.kind === 'li') {
        const prefix = b.ordered ? `${b.num ?? 1}. ` : '• ';
        return wordParagraph(prefix + b.text);
      }
      return wordParagraph(b.text);
    })
    .join('');
}

/** Resolve Heading 1–4 style IDs from the template (supports localized styleId). */
export function resolveHeadingStyleIds(stylesXml: string | null): Record<1 | 2 | 3 | 4, string> {
  const defaults: Record<1 | 2 | 3 | 4, string> = {
    1: 'Heading1',
    2: 'Heading2',
    3: 'Heading3',
    4: 'Heading4',
  };
  if (!stylesXml) return defaults;

  const styleBlocks = stylesXml.match(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g) || [];
  for (const block of styleBlocks) {
    if (!/\bw:type="paragraph"/.test(block)) continue;
    const id = /\bw:styleId="([^"]+)"/.exec(block)?.[1];
    const name = /<w:name\b[^>]*\bw:val="([^"]+)"/.exec(block)?.[1];
    if (!id || !name) continue;
    const m = /^heading\s*([1-4])$/i.exec(name.trim());
    if (m) {
      defaults[Number(m[1]) as 1 | 2 | 3 | 4] = id;
    }
  }
  return defaults;
}

function paragraphPlainText(pXml: string): string {
  return pXml
    .replace(/<w:proofErr\b[^/]*\/>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}

const BODY_MARKER_ONLY =
  /^\{d\.body(?::[A-Za-z0-9_]+)*\}$|^\{d\.bodyMarkdown(?::[A-Za-z0-9_]+)*\}$/;

/**
 * Replace a paragraph whose entire text is exactly `{d.body}` (optional formatter)
 * with Markdown rendered as Word paragraphs using the template Heading styles.
 * Does not merge runs or touch any other paragraph (avoids corrupting multi-page docs).
 */
export function injectStyledBody(
  xml: string,
  bodyMarkdown: string,
  headingStyles: Record<1 | 2 | 3 | 4, string>
): { xml: string; replaced: boolean } {
  const ooxml = blocksToOoxml(markdownToBlocks(bodyMarkdown), headingStyles);
  let replaced = false;
  const next = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (p) => {
    const text = paragraphPlainText(p).replace(/\s+/g, '');
    if (!BODY_MARKER_ONLY.test(text)) return p;
    replaced = true;
    return ooxml;
  });
  return { xml: next, replaced };
}

export function patchBodyConvCrlf(xml: string): string {
  let out = xml;
  out = out.replace(/\{d\.body\}/g, '{d.body:convCRLF}');
  out = out.replace(/\{d\.bodyMarkdown\}/g, '{d.bodyMarkdown:convCRLF}');
  return out;
}

function rowPlainText(trXml: string): string {
  return trXml.replace(/<[^>]+>/g, '');
}

function arraysWithI(trXml: string): string[] {
  const text = rowPlainText(trXml);
  const names = new Set<string>();
  const re = /\{d(?:\.fm)?\.([A-Za-z_][\w]*)\[i\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) names.add(m[1]);
  return [...names];
}

function rowHasIPlusOne(trXml: string, arrayName: string): boolean {
  return rowPlainText(trXml).includes(`${arrayName}[i+1]`);
}

export function ensureCarboneLoopEndRows(xml: string): string {
  const re = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  const rows: Array<{ start: number; end: number; xml: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    rows.push({ start: match.index, end: match.index + match[0].length, xml: match[0] });
  }
  if (!rows.length) return xml;

  const insertAfter = new Map<number, string>();

  for (let i = 0; i < rows.length; i++) {
    const names = arraysWithI(rows[i].xml);
    if (!names.length) continue;

    const needsEnd = names.some((name) => {
      if (i + 1 < rows.length && rowHasIPlusOne(rows[i + 1].xml, name)) return false;
      return true;
    });
    if (!needsEnd) continue;

    let endRow = rows[i].xml;
    endRow = endRow.replace(
      /\{d(\.fm)?\.([A-Za-z_][\w]*)\[i\][^}]*\}/g,
      (_full, fm: string | undefined, name: string) => `{d${fm || ''}.${name}[i+1]}`
    );
    endRow = endRow.split('[i]').join('[i+1]');
    insertAfter.set(i, endRow);
  }

  if (!insertAfter.size) return xml;

  const parts: string[] = [];
  let last = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    parts.push(xml.slice(last, row.end));
    const extra = insertAfter.get(i);
    if (extra) parts.push(extra);
    last = row.end;
  }
  parts.push(xml.slice(last));
  return parts.join('');
}

/**
 * Sample table rows in Word often have underline on the marker run; Carbone clones
 * that to every row. Indented labels (leading em-space from indent/level) should not
 * keep that underline — strip <w:u> from those runs only.
 */
export function stripUnderlineFromIndentedRuns(xml: string): string {
  return xml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (run) => {
    const textMatch = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(run);
    if (!textMatch) return run;
    // Decode minimal entities Word may use
    const text = textMatch[1]
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    if (!text.startsWith('\u2003')) return run;
    return run
      .replace(/<w:u\b[^/]*\/>/g, '')
      .replace(/<w:u\b[^>]*>[\s\S]*?<\/w:u>/g, '');
  });
}

/**
 * After Carbone: cleanups that need the final filled text.
 */
export async function finalizeDocxExport(docxBuffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;
  let xml = await docFile.async('string');
  xml = stripUnderlineFromIndentedRuns(xml);
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Prep before Carbone:
 * - map `{d.body}` (alone in a paragraph) → Word Heading styles from Markdown
 * - otherwise keep `{d.body:convCRLF}` for line breaks
 * - ensure table loop end rows for `[i]`
 */
export async function prepareDocxForExport(
  docxBuffer: Buffer,
  bodyMarkdown: string
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  const stylesFile = zip.file('word/styles.xml');
  const stylesXml = stylesFile ? await stylesFile.async('string') : null;
  const headingStyles = resolveHeadingStyleIds(stylesXml);

  let xml = await docFile.async('string');
  const injected = injectStyledBody(xml, bodyMarkdown, headingStyles);
  xml = injected.xml;
  if (!injected.replaced) {
    xml = patchBodyConvCrlf(xml);
  }
  xml = ensureCarboneLoopEndRows(xml);

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
