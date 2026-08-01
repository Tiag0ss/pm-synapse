# Skill: Synapse backend route

## Goal
Add or change an Express route under `server/routes/` following Synapse conventions.

## Task Input

```text
Route method + path:
Auth (session / public / none):
Request body / query:
Response data shape:
Side effects (DB, PM API, files, graph):
```

## Execution Rules

1. Open `.cursor/rules/synapse-backend.mdc` and `AGENTS.md`.
2. Use `authenticateSession` for private vault APIs; public wiki stays rate-limited and unauthenticated.
3. Validate bodies with Zod; return `{ success: false, message }` on failure.
4. Parameterized SQL via `pool`; use `logger` for errors.
5. For note writes that change graph-relevant content: `rebuildNoteGraph` after save.
6. For note content revisions (user edits): `snapshotRevision` — skip for passive PM checkbox pull-sync.
7. If the route calls Project Management, update `docs/PM_API_CONTRACT.md` when introducing new endpoints/fields.
8. Minimal diff; English messages.

## Output Contract

- Implement the route and wire it in `server/index.ts` if new router.
- Summarize endpoints and any schema (`ensureSchema`) changes.
