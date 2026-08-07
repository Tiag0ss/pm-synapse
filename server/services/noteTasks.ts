/**
 * Unified note task candidates: markdown checkboxes + YAML frontmatter todos.
 * Keep in sync with lib/noteTasks.ts
 */
import { parseCheckboxes, type ParsedCheckbox } from './checkboxes';
import {
  frontmatterTodoMarkerId,
  parseFrontmatterTodos,
} from './frontmatter';
import { stripTrailingEstimateMeta, type TaskEstimateMeta } from './taskEstimate';

export type NoteTaskSource = 'checkbox' | 'frontmatter';

export type NoteTaskCandidate = ParsedCheckbox & {
  source: NoteTaskSource;
  displayText?: string;
  taskText?: string;
  statusText?: string;
  estimate?: TaskEstimateMeta;
  /** Frontmatter todo `note:` target (title/path), when set */
  linkedNote?: string | null;
  /** Frontmatter `category:` or checkbox `(2h, Design)` category token */
  category?: string | null;
};

/** Markdown checkboxes first, then frontmatter todos (indent 0). */
export function listNoteTaskCandidates(markdown: string): NoteTaskCandidate[] {
  const boxes = parseCheckboxes(markdown).map((b) => {
    const { text: taskText, meta } = stripTrailingEstimateMeta(b.text);
    const estimate =
      meta.estimatedHours != null || meta.unscheduledWork === true
        ? {
            estimatedHours: meta.estimatedHours,
            unscheduledWork: meta.unscheduledWork,
          }
        : undefined;
    return {
      ...b,
      source: 'checkbox' as const,
      displayText: b.text,
      taskText,
      estimate,
      category: meta.category || null,
    };
  });
  const startIndex = boxes.length;
  const todos = parseFrontmatterTodos(markdown);
  const fmTasks: NoteTaskCandidate[] = todos.map((t, i) => ({
    index: startIndex + i,
    checked: t.checked,
    partial: !t.checked && /in\s*progress|doing|wip|started|working|active/i.test(t.status),
    mark: t.checked
      ? ('x' as const)
      : /in\s*progress|doing|wip|started|working|active/i.test(t.status)
        ? ('-' as const)
        : (' ' as const),
    text: t.content,
    displayText: t.content,
    taskText: t.content,
    markerId: t.id ? frontmatterTodoMarkerId(t.id) : null,
    lineIndex: -1,
    rawLine: '',
    indent: 0,
    source: 'frontmatter' as const,
    statusText: t.status,
    estimate: t.estimate,
    linkedNote: t.noteTarget,
    category: t.category,
  }));
  return [...boxes, ...fmTasks];
}

/** Sum estimated hours across checkbox + frontmatter tasks. */
export function sumNoteTaskEstimateHours(markdown: string): number {
  let total = 0;
  for (const t of listNoteTaskCandidates(markdown)) {
    const h = t.estimate?.estimatedHours;
    if (h != null && Number.isFinite(h)) total += h;
  }
  return Math.round(total * 100) / 100;
}
