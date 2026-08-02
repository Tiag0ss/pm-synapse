/**
 * Unified note task candidates: markdown checkboxes + YAML frontmatter todos.
 * Keep in sync with lib/noteTasks.ts
 */
import { parseCheckboxes, type ParsedCheckbox } from './checkboxes';
import {
  frontmatterTodoMarkerId,
  parseFrontmatterTodos,
} from './frontmatter';

export type NoteTaskSource = 'checkbox' | 'frontmatter';

export type NoteTaskCandidate = ParsedCheckbox & {
  source: NoteTaskSource;
};

/** Markdown checkboxes first, then frontmatter todos (indent 0). */
export function listNoteTaskCandidates(markdown: string): NoteTaskCandidate[] {
  const boxes = parseCheckboxes(markdown).map((b) => ({
    ...b,
    source: 'checkbox' as const,
  }));
  const startIndex = boxes.length;
  const todos = parseFrontmatterTodos(markdown);
  const fmTasks: NoteTaskCandidate[] = todos.map((t, i) => ({
    index: startIndex + i,
    checked: t.checked,
    text: t.content,
    markerId: t.id ? frontmatterTodoMarkerId(t.id) : null,
    lineIndex: -1,
    rawLine: '',
    indent: 0,
    source: 'frontmatter' as const,
  }));
  return [...boxes, ...fmTasks];
}
