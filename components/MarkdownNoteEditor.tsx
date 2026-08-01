'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderSynapseMarkdown, type NoteIndexEntry } from '@/lib/renderMarkdown';
import ImageLightbox from '@/components/ImageLightbox';

type ViewMode = 'edit' | 'split' | 'preview';

interface MarkdownNoteEditorProps {
  value: string;
  onChange: (value: string) => void;
  vaultId?: string;
  notes?: NoteIndexEntry[];
  onOpenNote?: (id: number) => void;
  /** Called when a missing wikilink is clicked (preview). */
  onCreateNoteFromWikilink?: (title: string) => void;
  onStatus?: (msg: string) => void;
  placeholder?: string;
  /** When true, force preview and hide editing chrome. */
  readOnly?: boolean;
}

type WrapSpec =
  | { kind: 'wrap'; before: string; after: string; placeholder?: string }
  | { kind: 'linePrefix'; prefix: string }
  | { kind: 'block'; before: string; after: string; placeholder?: string };

const TOOLBAR_GROUPS: Array<Array<{ label: string; title: string; spec: WrapSpec; weight?: string }>> = [
  [
    { label: 'B', title: 'Bold (Ctrl+B)', spec: { kind: 'wrap', before: '**', after: '**', placeholder: 'bold' }, weight: 'font-bold' },
    { label: 'I', title: 'Italic (Ctrl+I)', spec: { kind: 'wrap', before: '_', after: '_', placeholder: 'italic' }, weight: 'italic' },
    { label: 'S', title: 'Strikethrough', spec: { kind: 'wrap', before: '~~', after: '~~', placeholder: 'text' }, weight: 'line-through' },
  ],
  [
    { label: 'H1', title: 'Heading 1', spec: { kind: 'linePrefix', prefix: '# ' } },
    { label: 'H2', title: 'Heading 2', spec: { kind: 'linePrefix', prefix: '## ' } },
    { label: 'H3', title: 'Heading 3', spec: { kind: 'linePrefix', prefix: '### ' } },
  ],
  [
    { label: '•', title: 'Bullet list', spec: { kind: 'linePrefix', prefix: '- ' } },
    { label: '1.', title: 'Numbered list', spec: { kind: 'linePrefix', prefix: '1. ' } },
    { label: '☑', title: 'Task list', spec: { kind: 'linePrefix', prefix: '- [ ] ' } },
    { label: '❝', title: 'Quote', spec: { kind: 'linePrefix', prefix: '> ' } },
  ],
  [
    { label: '</>', title: 'Inline code', spec: { kind: 'wrap', before: '`', after: '`', placeholder: 'code' } },
    { label: '{ }', title: 'Code block', spec: { kind: 'block', before: '```\n', after: '\n```', placeholder: 'code' } },
    { label: 'Link', title: 'Link (Ctrl+K)', spec: { kind: 'wrap', before: '[', after: '](https://)', placeholder: 'label' } },
  ],
  [
    { label: '[[ ]]', title: 'Wikilink', spec: { kind: 'wrap', before: '[[', after: ']]', placeholder: 'folder/note' } },
    { label: '#', title: 'Tag', spec: { kind: 'wrap', before: '#', after: '', placeholder: 'tag' } },
    { label: '—', title: 'Divider', spec: { kind: 'block', before: '\n---\n', after: '', placeholder: '' } },
  ],
];

const LEGEND: Array<{ syntax: string; meaning: string }> = [
  { syntax: '**bold**', meaning: 'Bold text' },
  { syntax: '_italic_', meaning: 'Italic text' },
  { syntax: '~~strike~~', meaning: 'Strikethrough' },
  { syntax: '# Heading', meaning: 'Title (H1); ## H2; ### H3' },
  { syntax: '- item', meaning: 'Bullet list' },
  { syntax: '1. item', meaning: 'Numbered list' },
  { syntax: '- [ ] task', meaning: 'Checklist item' },
  { syntax: '> quote', meaning: 'Block quote' },
  { syntax: '`code`', meaning: 'Inline code' },
  { syntax: '``` … ```', meaning: 'Code block' },
  { syntax: '[label](url)', meaning: 'External link' },
  { syntax: '![alt](url)', meaning: 'Image (paste or drop into the editor)' },
  { syntax: '--- yaml ---', meaning: 'YAML frontmatter at top (shown as Properties)' },
  { syntax: '[[Note title]]', meaning: 'Link to another note (blue when found)' },
  { syntax: '[[meta/risks]]', meaning: 'Link by folder path' },
  { syntax: '[[risks]]', meaning: 'Link by unique leaf name' },
  { syntax: '[[Note|label]]', meaning: 'Wikilink with custom label' },
  { syntax: '#tag', meaning: 'Tag for filtering / graph' },
  { syntax: '---', meaning: 'Horizontal line' },
];

function applySpec(value: string, start: number, end: number, spec: WrapSpec): { next: string; selectStart: number; selectEnd: number } {
  const selected = value.slice(start, end);

  if (spec.kind === 'wrap' || spec.kind === 'block') {
    const inner = selected || spec.placeholder || '';
    const next = value.slice(0, start) + spec.before + inner + spec.after + value.slice(end);
    const selectStart = start + spec.before.length;
    return { next, selectStart, selectEnd: selectStart + inner.length };
  }

  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEndIdx = value.indexOf('\n', end);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n').map((line) => (line.startsWith(spec.prefix) ? line : spec.prefix + line));
  const replaced = lines.join('\n');
  const next = value.slice(0, lineStart) + replaced + value.slice(lineEnd);
  return { next, selectStart: lineStart, selectEnd: lineStart + replaced.length };
}

function fileToBase64Payload(file: File): Promise<{ mimeType: string; dataBase64: string; fileName: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      resolve({
        mimeType: file.type || 'image/png',
        dataBase64,
        fileName: file.name || 'paste.png',
      });
    };
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

export default function MarkdownNoteEditor({
  value,
  onChange,
  vaultId,
  notes = [],
  onOpenNote,
  onCreateNoteFromWikilink,
  onStatus,
  placeholder,
  readOnly = false,
}: MarkdownNoteEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const [mode, setMode] = useState<ViewMode>(readOnly ? 'preview' : 'split');
  const [showLegend, setShowLegend] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (readOnly) setMode('preview');
  }, [readOnly]);

  const html = useMemo(() => renderSynapseMarkdown(value, notes), [value, notes]);

  const uploadImages = useCallback(
    async (files: File[]) => {
      if (!vaultId) {
        onStatus?.('Open a vault note to upload images');
        return;
      }
      const images = files.filter((f) => f.type.startsWith('image/'));
      if (!images.length) return;

      setUploading(true);
      try {
        let current = valueRef.current;
        const el = textareaRef.current;
        let caret = el?.selectionStart ?? current.length;

        for (const file of images) {
          const payload = await fileToBase64Payload(file);
          const res = await fetch(`/api/vaults/${vaultId}/media`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            onStatus?.(data.message || 'Image upload failed');
            continue;
          }
          const url = String(data.data?.url || '');
          const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
          const snippet = `\n![${alt || 'image'}](${url})\n`;
          current = current.slice(0, caret) + snippet + current.slice(caret);
          caret += snippet.length;
          valueRef.current = current;
          onChange(current);
          onStatus?.('Image inserted');
        }
        requestAnimationFrame(() => {
          if (!el) return;
          el.focus();
          el.setSelectionRange(caret, caret);
        });
      } catch {
        onStatus?.('Image upload failed');
      } finally {
        setUploading(false);
      }
    },
    [onChange, onStatus, vaultId]
  );

  const runToolbar = useCallback(
    (spec: WrapSpec) => {
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const { next, selectStart, selectEnd } = applySpec(value, start, end, spec);
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(selectStart, selectEnd);
      });
    },
    [onChange, value]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !textareaRef.current) return;
      if (document.activeElement !== textareaRef.current) return;
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        runToolbar({ kind: 'wrap', before: '**', after: '**', placeholder: 'bold' });
      } else if (k === 'i') {
        e.preventDefault();
        runToolbar({ kind: 'wrap', before: '_', after: '_', placeholder: 'italic' });
      } else if (k === 'k') {
        e.preventDefault();
        runToolbar({ kind: 'wrap', before: '[', after: '](https://)', placeholder: 'label' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runToolbar]);

  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (img?.src && root.contains(img)) {
        e.preventDefault();
        e.stopPropagation();
        setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
        return;
      }
      if (!onOpenNote && !onCreateNoteFromWikilink) return;
      const target = (e.target as HTMLElement).closest('a.synapse-wikilink') as HTMLAnchorElement | null;
      if (!target) return;
      e.preventDefault();
      const id = Number(target.dataset.noteId || 0);
      if (id && onOpenNote) {
        onOpenNote(id);
        return;
      }
      const missingTitle = String(target.dataset.noteTitle || '').trim();
      if (missingTitle && onCreateNoteFromWikilink) {
        onCreateNoteFromWikilink(missingTitle);
      }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [onOpenNote, onCreateNoteFromWikilink, html]);

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    void uploadImages(files);
  };

  const onDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []);
    void uploadImages(files);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-inner shadow-black/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)]/80 px-2 py-1.5 backdrop-blur">
        {!readOnly &&
          TOOLBAR_GROUPS.map((group, gi) => (
          <div key={gi} className="flex items-center gap-0.5">
            {gi > 0 && <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />}
            {group.map((btn) => (
              <button
                key={btn.title}
                type="button"
                title={btn.title}
                onClick={() => runToolbar(btn.spec)}
                className={`toolbar-btn ${btn.weight || ''}`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        ))}
        {!readOnly && (
          <>
            <span className="mx-1 h-5 w-px bg-[var(--border)]" aria-hidden />
            <button
              type="button"
              title="Insert image"
              className="toolbar-btn"
              disabled={!vaultId || uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              Img
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = '';
                void uploadImages(files);
              }}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {uploading && <span className="px-2 text-[11px] text-[var(--muted)]">Uploading…</span>}
          {(readOnly ? (['preview'] as ViewMode[]) : (['edit', 'split', 'preview'] as ViewMode[])).map(
            (m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                mode === m
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
            >
              {m}
            </button>
          )
          )}
          <button
            type="button"
            onClick={() => setShowLegend((v) => !v)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
              showLegend
                ? 'bg-[var(--surface-2)] text-[var(--text)]'
                : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
            }`}
            title="Markdown legend"
          >
            Help
          </button>
        </div>
      </div>

      <div className={`grid min-h-0 flex-1 ${showLegend ? 'grid-cols-[1fr_220px]' : 'grid-cols-1'}`}>
        <div className={`grid min-h-0 ${mode === 'split' ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {(mode === 'edit' || mode === 'split') && (
            <textarea
              ref={textareaRef}
              className={`min-h-0 w-full resize-none border-r border-[var(--border)] bg-transparent p-4 font-mono text-[13px] leading-7 text-[var(--text)] outline-none placeholder:text-[var(--muted)] ${
                dragging ? 'ring-2 ring-inset ring-[var(--accent)]' : ''
              }`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onPaste={onPaste}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              placeholder={
                placeholder ||
                'Write in Markdown… Paste or drop images here. Use the toolbar or Help if you are new to the syntax.'
              }
              spellCheck
            />
          )}
          {(mode === 'preview' || mode === 'split') && (
            <div
              ref={previewRef}
              className="synapse-md-preview min-h-0 overflow-auto p-5 text-[15px] leading-7"
              dangerouslySetInnerHTML={{
                __html: html || '<p class="synapse-empty">Nothing to preview yet.</p>',
              }}
            />
          )}
        </div>

        {showLegend && (
          <aside className="overflow-auto border-l border-[var(--border)] bg-[var(--panel)]/60 p-4 text-xs">
            <h3 className="mb-1 text-sm font-semibold text-[var(--text)]">Markdown guide</h3>
            <p className="mb-3 leading-relaxed text-[var(--muted)]">
              Toolbar inserts syntax for you. Shortcuts: Ctrl/Cmd+B, I, K. Paste or drop images into the editor.
              Wikilinks turn blue when the note exists; red dashed means missing — click to create it.
            </p>
            <ul className="space-y-2.5">
              {LEGEND.map((row) => (
                <li key={row.syntax}>
                  <code className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--accent-soft)]">
                    {row.syntax}
                  </code>
                  <div className="mt-0.5 text-[var(--muted)]">{row.meaning}</div>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}
