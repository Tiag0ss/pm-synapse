import JSZip from 'jszip';
import { markdownToDocxFragment } from './mdToDocxBody';

export type MdBlock =
  | { kind: 'h1' | 'h2' | 'h3' | 'h4'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'li'; text: string; ordered: boolean; num?: number };

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

export function injectBodyOoxml(xml: string, ooxml: string): { xml: string; replaced: boolean } {
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

export function stripUnderlineFromIndentedRuns(xml: string): string {
  return xml.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, (run) => {
    const textMatch = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/.exec(run);
    if (!textMatch) return run;
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

export async function finalizeDocxExport(docxBuffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;
  let xml = await docFile.async('string');
  xml = stripUnderlineFromIndentedRuns(xml);
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function ensureContentTypeOverrides(ctXml: string, media: Array<{ path: string; contentType: string }>): string {
  let out = ctXml;
  const ensureDefault = (ext: string, contentType: string) => {
    if (new RegExp(`Extension="${ext}"`, 'i').test(out)) return;
    out = out.replace(
      /(<Types[^>]*>)/,
      `$1<Default Extension="${ext}" ContentType="${contentType}"/>`
    );
  };
  for (const m of media) {
    if (m.contentType === 'image/png') ensureDefault('png', 'image/png');
    if (m.contentType === 'image/jpeg') ensureDefault('jpeg', 'image/jpeg');
    if (m.contentType === 'image/gif') ensureDefault('gif', 'image/gif');
    if (m.contentType === 'image/webp') ensureDefault('webp', 'image/webp');
    const partName = '/' + m.path.replace(/^\/+/, '');
    if (out.includes(`PartName="${partName}"`)) continue;
    out = out.replace(
      '</Types>',
      `<Override PartName="${partName}" ContentType="${m.contentType}"/></Types>`
    );
  }
  return out;
}

function ensureDocumentRels(relsXml: string | null, media: Array<{ path: string; relId: string }>): string {
  const base =
    relsXml ||
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  let out = base;
  for (const m of media) {
    if (out.includes(`Id="${m.relId}"`)) continue;
    const target = m.path.replace(/^word\//, '');
    out = out.replace(
      '</Relationships>',
      `<Relationship Id="${m.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`
    );
  }
  return out;
}

/**
 * Prep before Carbone:
 * - rich Markdown `{d.body}` → OOXML (headings, tables, code, Mermaid images, math text)
 * - ensure table loop end rows for `[i]`
 */
export async function prepareDocxForExport(
  docxBuffer: Buffer,
  bodyMarkdown: string,
  options: { vaultId?: number } = {}
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) return docxBuffer;

  const stylesFile = zip.file('word/styles.xml');
  const stylesXml = stylesFile ? await stylesFile.async('string') : null;
  const headingStyles = resolveHeadingStyleIds(stylesXml);

  const fragment = await markdownToDocxFragment(bodyMarkdown, headingStyles, {
    vaultId: options.vaultId,
  });

  let xml = await docFile.async('string');
  const injected = injectBodyOoxml(xml, fragment.ooxml);
  xml = injected.xml;
  if (!injected.replaced) {
    xml = patchBodyConvCrlf(xml);
  }
  xml = ensureCarboneLoopEndRows(xml);
  zip.file('word/document.xml', xml);

  if (fragment.media.length) {
    for (const m of fragment.media) {
      zip.file(m.path, m.buffer);
    }
    const relsPath = 'word/_rels/document.xml.rels';
    const relsFile = zip.file(relsPath);
    const relsXml = relsFile ? await relsFile.async('string') : null;
    zip.file(relsPath, ensureDocumentRels(relsXml, fragment.media));

    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile) {
      const ctXml = await ctFile.async('string');
      zip.file('[Content_Types].xml', ensureContentTypeOverrides(ctXml, fragment.media));
    }
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
