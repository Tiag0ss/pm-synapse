# Skill: Synapse note features

## Goal
Change note editor, wikilinks, folder paths, media, or preview UX.

## Task Input

```text
Feature area (editor / paths / wikilinks / media / lightbox / tree):
Expected UX:
```

## Execution Rules

1. Keep path resolution in sync: `lib/notePaths.ts` ↔ `server/services/notePaths.ts`.
2. Keep checkbox helpers in sync: `lib/checkboxes.ts` ↔ `server/services/checkboxes.ts`.
3. Folders: title `a/b` → path `a/b.md`; sidebar via `NotesFolderTree`.
4. Wikilinks: resolve full path/title and unique leaf names.
5. Images: upload via vault media API; paste/drop in `MarkdownNoteEditor`; lightbox on click.
6. Do not add `alert`/`confirm`; use existing modals.
7. English UI unless user approved otherwise.

## Output Contract

- Implement UI + any API needed.
- Note any dual-file sync (lib vs server) updated.
