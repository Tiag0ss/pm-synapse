'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderSynapseMarkdown, type LinkableVaultNotes, type NoteIndexEntry } from '@/lib/renderMarkdown';
import { handleMarkdownCodeCopyClick } from '@/lib/codeCopy';
import { renderMermaidInRoot } from '@/lib/mermaidRender';
import { applyPlannerButtons, type PlannerLinkItem } from '@/lib/plannerLinks';
import ImageLightbox from '@/components/ImageLightbox';
import MermaidLightbox from '@/components/MermaidLightbox';

type ViewMode = 'edit' | 'split' | 'preview';

interface MarkdownNoteEditorProps {
  value: string;
  onChange: (value: string) => void;
  vaultId?: string;
  noteId?: number;
  notes?: NoteIndexEntry[];
  /** Cross-vault `[[@slug/…]]` resolution index */
  linkableVaults?: LinkableVaultNotes[];
  onOpenNote?: (id: number) => void;
  /** Open a note in another vault (from `[[@slug/…]]`). */
  onOpenCrossVaultNote?: (vaultId: number, noteId: number) => void;
  /** Called when a missing wikilink is clicked (preview). */
  onCreateNoteFromWikilink?: (title: string) => void;
  /** Called when a missing cross-vault `[[@slug/…]]` is clicked. */
  onCreateCrossVaultNote?: (vaultId: number, title: string) => void;
  onStatus?: (msg: string) => void;
  placeholder?: string;
  /** When true, force preview and hide editing chrome. */
  readOnly?: boolean;
  /** Narrow viewport: default to edit (not split), hide split toggle, stack legend. */
  compact?: boolean;
  /** Preloaded Planner links (e.g. public wiki). When omitted, fetched via vault/note APIs. */
  plannerLinks?: PlannerLinkItem[];
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

type LegendSection = {
  title: string;
  blurb?: string;
  items: Array<{ syntax: string; meaning: string }>;
};

const LEGEND_SECTIONS: LegendSection[] = [
  {
    title: 'Basics',
    items: [
      { syntax: '**bold**', meaning: 'Bold' },
      { syntax: '_italic_', meaning: 'Italic' },
      { syntax: '~~strike~~', meaning: 'Strikethrough' },
      { syntax: '# / ## / ###', meaning: 'Headings' },
      { syntax: '- item', meaning: 'Bullet list' },
      { syntax: '1. item', meaning: 'Numbered list' },
      { syntax: '- [ ] task', meaning: 'Checklist (pushable task)' },
      { syntax: '- [ ] task (2h)', meaning: 'Estimate hours on create in Planner' },
      { syntax: '- [ ] task (unscheduled)', meaning: 'Mark unscheduled work on create' },
      { syntax: '> quote', meaning: 'Block quote' },
      { syntax: '---', meaning: 'Horizontal rule (in the body)' },
      { syntax: '[label](url)', meaning: 'External link' },
      { syntax: '![alt](url)', meaning: 'Image (or paste / drop)' },
    ],
  },
  {
    title: 'Code & diagrams',
    items: [
      { syntax: '`code`', meaning: 'Inline code — click to copy in preview' },
      { syntax: '```lang', meaning: 'Fenced block — highlight + Copy button' },
      { syntax: '```mermaid', meaning: 'Diagram — Expand opens fullscreen' },
      { syntax: '$…$ / $$…$$', meaning: 'Math (KaTeX)' },
    ],
  },
  {
    title: 'Callouts & structure',
    items: [
      { syntax: '> [!NOTE]', meaning: 'Callout (also tip, warning, danger, …)' },
      { syntax: '[[toc]]', meaning: 'Table of contents from #–######' },
      { syntax: '[^1] / [^1]:', meaning: 'Footnote reference + definition' },
    ],
  },
  {
    title: 'Properties (YAML)',
    blurb: 'Optional block at the very top of the note, between --- fences. Shown as the Properties card in preview.',
    items: [
      { syntax: '--- … ---', meaning: 'Open/close the YAML block (must be first)' },
      { syntax: 'title: My note', meaning: 'Simple field (string, number, true/false)' },
      { syntax: 'tags: [a, b]', meaning: 'Scalar list → chips; used for filters' },
      {
        syntax: 'todos: …',
        meaning:
          'id, status, content → Properties + note tasks; push to Planner. hours / unscheduled on create; note: links to another note; when linked, status follows Planner status names',
      },
      { syntax: 'hours: 2.5', meaning: 'Under a todo → estimatedHours on Planner create' },
      { syntax: 'unscheduled: true', meaning: 'Under a todo → unscheduledWork on create (not implied by missing hours)' },
      {
        syntax: 'note: meta/risks',
        meaning:
          'Under a todo → link to another note (title or path; quote "[[wikilink]]" if using brackets)',
      },
    ],
  },
  {
    title: 'Synapse links & tags',
    items: [
      { syntax: '[[Note title]]', meaning: 'Link to a note (solid underline)' },
      { syntax: '[[meta/risks]]', meaning: 'Link by folder path' },
      { syntax: '[[risks]]', meaning: 'Link by unique leaf name' },
      {
        syntax: '[[@vault-slug/note]]',
        meaning: 'Link to a note in another vault (shows “no access” if you lack permission)',
      },
      { syntax: '[[Note|label]]', meaning: 'Wikilink with custom label' },
      { syntax: 'plain Title', meaning: 'Unlinked mention (dashed)' },
      { syntax: '#tag', meaning: 'Inline tag for filtering / graph' },
    ],
  },
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

type ListContinue =
  | { kind: 'continue'; insert: string }
  | { kind: 'exit'; removePrefixLen: number }
  | null;

/** Detect bullet / numbered / task list on the current line for Enter continuation. */
function listContinueForLine(line: string): ListContinue {
  // Task: "- [ ] " / "- [x] " (also * +)
  const task = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const indent = task[1];
    const bullet = task[2];
    const body = task[4];
    if (!body.trim()) {
      return { kind: 'exit', removePrefixLen: line.length };
    }
    return { kind: 'continue', insert: `\n${indent}${bullet} [ ] ` };
  }

  // Numbered: "1. "
  const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (numbered) {
    const indent = numbered[1];
    const n = Number(numbered[2]);
    const body = numbered[3];
    if (!body.trim()) {
      return { kind: 'exit', removePrefixLen: line.length };
    }
    return { kind: 'continue', insert: `\n${indent}${n + 1}. ` };
  }

  // Bullet: "- " / "* " / "+ " (not a task — already handled)
  const bullet = line.match(/^(\s*)([-*+])\s+(.*)$/);
  if (bullet) {
    const indent = bullet[1];
    const mark = bullet[2];
    const body = bullet[3];
    // Avoid treating "- [ ]" partials already matched; bare "- [" without close is still a bullet
    if (!body.trim()) {
      return { kind: 'exit', removePrefixLen: line.length };
    }
    return { kind: 'continue', insert: `\n${indent}${mark} ` };
  }

  // Quote continuation (same UX as lists)
  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) {
    const indent = quote[1];
    const body = quote[2];
    if (!body.trim()) {
      return { kind: 'exit', removePrefixLen: line.length };
    }
    return { kind: 'continue', insert: `\n${indent}> ` };
  }

  return null;
}

function applyListEnter(
  value: string,
  caret: number
): { next: string; select: number } | null {
  const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const lineEndIdx = value.indexOf('\n', caret);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  // Only continue when caret is on this line (not mid-selection across lines)
  const line = value.slice(lineStart, lineEnd);
  const action = listContinueForLine(line);
  if (!action) return null;

  if (action.kind === 'exit') {
    // Empty list item → blank line (exit list)
    const next = value.slice(0, lineStart) + value.slice(lineEnd);
    return { next, select: lineStart };
  }

  // Insert continuation after current line; keep any text after caret on the new line's body
  const afterCaretOnLine = value.slice(caret, lineEnd);
  const next =
    value.slice(0, caret) + action.insert + afterCaretOnLine + value.slice(lineEnd);
  const select = caret + action.insert.length;
  return { next, select };
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
  noteId,
  notes = [],
  linkableVaults = [],
  onOpenNote,
  onOpenCrossVaultNote,
  onCreateNoteFromWikilink,
  onCreateCrossVaultNote,
  onStatus,
  placeholder,
  readOnly = false,
  compact = false,
  plannerLinks,
}: MarkdownNoteEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  const [mode, setMode] = useState<ViewMode>(readOnly ? 'preview' : compact ? 'edit' : 'split');
  const [showLegend, setShowLegend] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [mermaidLightbox, setMermaidLightbox] = useState<string | null>(null);
  const [fetchedPlannerLinks, setFetchedPlannerLinks] = useState<PlannerLinkItem[]>([]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (readOnly) setMode('preview');
  }, [readOnly]);

  useEffect(() => {
    if (readOnly) return;
    if (compact && mode === 'split') setMode('edit');
  }, [compact, readOnly, mode]);

  const html = useMemo(
    () => renderSynapseMarkdown(value, notes, linkableVaults),
    [value, notes, linkableVaults]
  );

  useEffect(() => {
    if (plannerLinks) {
      setFetchedPlannerLinks(plannerLinks);
      return;
    }
    if (!vaultId || !noteId) {
      setFetchedPlannerLinks([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/checkboxes`, {
            credentials: 'include',
          });
          const data = await res.json();
          if (cancelled || !res.ok) return;
          const payload = data.data;
          const list = Array.isArray(payload) ? payload : payload?.items || [];
          setFetchedPlannerLinks(
            list.map(
              (i: { markerId?: string | null; openUrl?: string | null; pmTaskId?: number | null }) => ({
                markerId: i.markerId ?? null,
                openUrl: i.openUrl ?? null,
                pmTaskId: i.pmTaskId ?? null,
              })
            )
          );
        } catch {
          if (!cancelled) setFetchedPlannerLinks([]);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [vaultId, noteId, plannerLinks, value]);

  useLayoutEffect(() => {
    const root = previewRef.current;
    if (!root || mode === 'edit') return;
    // Own the preview DOM so Mermaid SVG is not wiped by React's dangerouslySetInnerHTML
    root.innerHTML = html || '<p class="synapse-empty">Nothing to preview yet.</p>';
    applyPlannerButtons(root, fetchedPlannerLinks);
    void renderMermaidInRoot(root);
  }, [html, fetchedPlannerLinks, mode]);

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
      if (handleMarkdownCodeCopyClick(e, root)) return;

      const tocLink = (e.target as HTMLElement).closest(
        'a.synapse-toc-link'
      ) as HTMLAnchorElement | null;
      if (tocLink && root.contains(tocLink)) {
        const href = tocLink.getAttribute('href') || '';
        if (href.startsWith('#')) {
          e.preventDefault();
          e.stopPropagation();
          const id = decodeURIComponent(href.slice(1));
          const targetEl = root.querySelector(`#${CSS.escape(id)}`);
          if (targetEl instanceof HTMLElement) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          return;
        }
      }

      const img = (e.target as HTMLElement).closest('img') as HTMLImageElement | null;
      if (img?.src && root.contains(img)) {
        e.preventDefault();
        e.stopPropagation();
        setLightbox({ src: img.currentSrc || img.src, alt: img.alt || '' });
        return;
      }
      const mermaidHit = (e.target as HTMLElement).closest(
        '.synapse-mermaid-expand, .synapse-mermaid:not(.synapse-mermaid-error) svg'
      );
      if (mermaidHit && root.contains(mermaidHit)) {
        const wrap = mermaidHit.closest('.synapse-mermaid');
        const svg = wrap?.querySelector('svg');
        if (svg) {
          e.preventDefault();
          e.stopPropagation();
          setMermaidLightbox(svg.outerHTML);
          return;
        }
      }
      if (!onOpenNote && !onOpenCrossVaultNote && !onCreateNoteFromWikilink && !onCreateCrossVaultNote)
        return;
      const target = (e.target as HTMLElement).closest(
        'a.synapse-wikilink, a.synapse-mention'
      ) as HTMLAnchorElement | null;
      if (!target) return;
      e.preventDefault();
      const id = Number(target.dataset.noteId || 0);
      const crossVaultId = Number(target.dataset.vaultId || 0);
      const currentVaultId = vaultId ? Number(vaultId) : 0;
      if (
        id &&
        crossVaultId &&
        currentVaultId &&
        crossVaultId !== currentVaultId &&
        onOpenCrossVaultNote
      ) {
        onOpenCrossVaultNote(crossVaultId, id);
        return;
      }
      if (id && onOpenNote) {
        onOpenNote(id);
        return;
      }
      if (target.classList.contains('synapse-wikilink')) {
        const missingTitle = String(target.dataset.noteTitle || '').trim();
        if (!missingTitle) return;
        if (crossVaultId && onCreateCrossVaultNote) {
          onCreateCrossVaultNote(crossVaultId, missingTitle);
          return;
        }
        if (onCreateNoteFromWikilink && !crossVaultId) {
          onCreateNoteFromWikilink(missingTitle);
        }
      }
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [
    onOpenNote,
    onOpenCrossVaultNote,
    onCreateNoteFromWikilink,
    onCreateCrossVaultNote,
    html,
    vaultId,
  ]);

  const onEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const result = applyListEnter(value, el.selectionStart);
    if (!result) return;
    e.preventDefault();
    onChange(result.next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(result.select, result.select);
    });
  };

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
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {uploading && <span className="px-2 text-[11px] text-[var(--muted)]">Uploading…</span>}
          {(readOnly
            ? (['preview'] as ViewMode[])
            : compact
              ? (['edit', 'preview'] as ViewMode[])
              : (['edit', 'split', 'preview'] as ViewMode[])
          ).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`min-h-9 rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition sm:min-h-0 sm:py-1 ${
                mode === m
                  ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
            >
              {m}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowLegend((v) => !v)}
            className={`min-h-9 rounded-md px-2.5 py-1.5 text-xs font-medium transition sm:min-h-0 sm:py-1 ${
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

      <div
        className={`grid min-h-0 flex-1 ${
          showLegend
            ? compact
              ? 'grid-cols-1 grid-rows-[1fr_auto]'
              : 'grid-cols-[1fr_220px]'
            : 'grid-cols-1'
        }`}
      >
        <div
          className={`grid min-h-0 ${
            mode === 'split' && !compact ? 'grid-cols-2' : 'grid-cols-1'
          }`}
        >
          {(mode === 'edit' || mode === 'split') && (
            <textarea
              ref={textareaRef}
              className={`min-h-0 w-full resize-none border-r border-[var(--border)] bg-transparent p-4 font-mono text-[13px] leading-7 text-[var(--text)] outline-none placeholder:text-[var(--muted)] ${
                dragging ? 'ring-2 ring-inset ring-[var(--accent)]' : ''
              }`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onEditorKeyDown}
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
            />
          )}
        </div>

        {showLegend && (
          <aside
            className={`overflow-auto bg-[var(--panel)]/60 p-4 text-xs ${
              compact
                ? 'max-h-[40vh] border-t border-[var(--border)]'
                : 'border-l border-[var(--border)]'
            }`}
          >
            <h3 className="mb-1 text-sm font-semibold text-[var(--text)]">Markdown guide</h3>
            <p className="mb-4 leading-relaxed text-[var(--muted)]">
              Toolbar + Ctrl/Cmd+B, I, K. Enter continues lists and tasks. Paste or drop images
              into the editor.
            </p>
            <div className="space-y-4">
              {LEGEND_SECTIONS.map((section) => (
                <section key={section.title}>
                  <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent-soft)]">
                    {section.title}
                  </h4>
                  {section.blurb ? (
                    <p className="mb-2 leading-relaxed text-[var(--muted)]">{section.blurb}</p>
                  ) : null}
                  <ul className="space-y-2">
                    {section.items.map((row) => (
                      <li key={`${section.title}:${row.syntax}`}>
                        <code className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--accent-soft)]">
                          {row.syntax}
                        </code>
                        <div className="mt-0.5 leading-snug text-[var(--muted)]">{row.meaning}</div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </aside>
        )}
      </div>

      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
      <MermaidLightbox svgHtml={mermaidLightbox} onClose={() => setMermaidLightbox(null)} />
    </div>
  );
}
