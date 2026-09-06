# Skill: Synapse note features

## Goal
Change note editor, wikilinks, folder paths, media, whiteboards, embeds, or preview UX.

## Task Input

```text
Feature area (editor / paths / wikilinks / media / lightbox / tree / whiteboard / embeds / share):
Expected UX:
```

## Execution Rules

1. Keep path resolution in sync: `lib/notePaths.ts` ↔ `server/services/notePaths.ts`.
2. Keep checkbox helpers in sync: `lib/checkboxes.ts` ↔ `server/services/checkboxes.ts`.
3. Keep markdown preprocess in sync: `lib/renderMarkdown.ts` ↔ `server/services/markdown.ts` (incl. `![[board]]` embeds + sanitize attrs).
4. Folders: title `a/b` → path `a/b.md`; sidebar via `NotesFolderTree`.
5. Wikilinks: resolve full path/title and unique leaf names; `NoteResolveEntry.kind` for whiteboard detection.
6. Images / attachments: upload via vault media API; paste/drop in `MarkdownNoteEditor`; lightbox on click; `[[attach` autocomplete.
7. Whiteboards: `WhiteboardEditor` (edit) / `WhiteboardPeekCanvas` (peek, wiki, share, embeds). Viewer CSS: `.synapse-whiteboard-viewer` (hide drawing + Library; keep zoom/menu/help).
8. Inline embeds: `![[Title]]` → `.synapse-board-embed` placeholder → `BoardEmbedPortals` + `useBoardEmbedPreview` (portals only; no nested `createRoot` / `flushSync` in layout).
9. Password shares: `noteShares` service + `/api/shares` + `/s/[token]`; notes with embeds need `embeddedBoards` in content (and public wiki note payload).
10. Do not add `alert`/`confirm`; use existing modals.
11. English UI unless user approved otherwise.

## Output Contract

- Implement UI + any API needed.
- Note any dual-file sync (lib vs server) updated.
