'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  buildNoteTree,
  noteFolderPath,
  type NoteTreeFolder,
  type NoteTreeNode,
  type NoteTreeNote,
} from '@/lib/notePaths';

type NoteRow = { Id: number; Title: string; Path: string };

interface NotesFolderTreeProps {
  notes: NoteRow[];
  selectedId: number | null;
  onOpenNote: (id: number) => void;
  emptyLabel?: string;
}

function FolderBlock({
  folder,
  depth,
  selectedId,
  onOpenNote,
  expanded,
  toggle,
}: {
  folder: NoteTreeFolder;
  depth: number;
  selectedId: number | null;
  onOpenNote: (id: number) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
}) {
  const open = expanded.has(folder.path);
  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(folder.path)}
        className="mb-0.5 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[var(--muted)] transition hover:bg-[var(--surface-2)]/70 hover:text-[var(--text)]"
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[10px]" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="text-[var(--accent-soft)]" aria-hidden>
          📁
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide">{folder.name}</span>
      </button>
      {open &&
        folder.children.map((child) => (
          <TreeNode
            key={child.type === 'folder' ? `f:${child.path}` : `n:${child.id}`}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            onOpenNote={onOpenNote}
            expanded={expanded}
            toggle={toggle}
          />
        ))}
    </div>
  );
}

function NoteRowButton({
  note,
  depth,
  selectedId,
  onOpenNote,
}: {
  note: NoteTreeNote;
  depth: number;
  selectedId: number | null;
  onOpenNote: (id: number) => void;
}) {
  const selected = selectedId === note.id;
  return (
    <button
      type="button"
      onClick={() => onOpenNote(note.id)}
      title={note.path.replace(/\.md$/i, '')}
      className={`mb-0.5 flex w-full items-start gap-2 rounded-lg py-1.5 text-left transition ${
        selected
          ? 'bg-[var(--surface-2)] ring-1 ring-[var(--accent)]/40'
          : 'hover:bg-[var(--surface-2)]/70'
      }`}
      style={{ paddingLeft: `${0.5 + depth * 0.75}rem`, paddingRight: '0.625rem' }}
    >
      <span className="mt-0.5 text-[var(--accent-soft)]" aria-hidden>
        ⌘
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{note.name}</span>
        {note.title.includes('/') && (
          <span className="block truncate text-[10px] text-[var(--muted)]">{note.path.replace(/\.md$/i, '')}</span>
        )}
      </span>
    </button>
  );
}

function TreeNode({
  node,
  depth,
  selectedId,
  onOpenNote,
  expanded,
  toggle,
}: {
  node: NoteTreeNode;
  depth: number;
  selectedId: number | null;
  onOpenNote: (id: number) => void;
  expanded: Set<string>;
  toggle: (path: string) => void;
}) {
  if (node.type === 'folder') {
    return (
      <FolderBlock
        folder={node}
        depth={depth}
        selectedId={selectedId}
        onOpenNote={onOpenNote}
        expanded={expanded}
        toggle={toggle}
      />
    );
  }
  return (
    <NoteRowButton note={node} depth={depth} selectedId={selectedId} onOpenNote={onOpenNote} />
  );
}

/** Ancestor folder paths for a note (e.g. a/b/c.md → ["a", "a/b"]). */
function ancestorFoldersForNote(notes: NoteRow[], selectedId: number | null): string[] {
  if (!selectedId) return [];
  const note = notes.find((n) => n.Id === selectedId);
  if (!note) return [];
  const folder = noteFolderPath(note.Path);
  if (!folder) return [];
  const parts = folder.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

export default function NotesFolderTree({
  notes,
  selectedId,
  onOpenNote,
  emptyLabel = 'No notes yet. Create one to start.',
}: NotesFolderTreeProps) {
  const tree = useMemo(() => buildNoteTree(notes), [notes]);
  /** Collapsed by default — only explicitly expanded folders are open. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // When opening a note, expand its ancestor folders only (keep other folders as-is).
  useEffect(() => {
    const ancestors = ancestorFoldersForNote(notes, selectedId);
    if (!ancestors.length) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of ancestors) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [notes, selectedId]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (notes.length === 0) {
    return <p className="px-2 text-sm text-[var(--muted)]">{emptyLabel}</p>;
  }

  return (
    <div>
      {tree.map((node) => (
        <TreeNode
          key={node.type === 'folder' ? `f:${node.path}` : `n:${node.id}`}
          node={node}
          depth={0}
          selectedId={selectedId}
          onOpenNote={onOpenNote}
          expanded={expanded}
          toggle={toggle}
        />
      ))}
    </div>
  );
}
