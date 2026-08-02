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
};

/** Markdown checkboxes first, then frontmatter todos (indent 0). */
export function listNoteTaskCandidates(markdown: string): NoteTaskCandidate[] {
  const boxes = parseCheckboxes(markdown).map((b) => {
    const { text: taskText, meta } = stripTrailingEstimateMeta(b.text);
    return {
      ...b,
      source: 'checkbox' as const,
      displayText: b.text,
      taskText,
      estimate:
        meta.estimatedHours != null || meta.unscheduledWork === true ? meta : undefined,
    };
  });
  const startIndex = boxes.length;
  const todos = parseFrontmatterTodos(markdown);
  const fmTasks: NoteTaskCandidate[] = todos.map((t, i) => ({
    index: startIndex + i,
    checked: t.checked,
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
  }));
  return [...boxes, ...fmTasks];
}
