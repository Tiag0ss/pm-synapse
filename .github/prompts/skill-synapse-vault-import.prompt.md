# Skill: Synapse vault ZIP import

## Goal
Import a ZIP of Markdown (and optional images) into a vault, preserving folder structure as note paths.

## Task Input

```text
Import source (ZIP):
Collision policy (skip / overwrite):
Include images?:
```

## Execution Rules

1. Auth: vault owner only.
2. Accept nested folders: `meta/risks.md` → note title `meta/risks`, path `meta/risks.md`.
3. Skip junk: `__MACOSX`, `.DS_Store`, directories without files.
4. Prefer `.md` / `.markdown` as notes; normalize encoding to UTF-8.
5. Optional: import images into `VaultMedia` and rewrite relative `![](…)` in the same zip to media URLs.
6. Cap size (e.g. 20 MB ZIP); report created / skipped / errors counts.
7. After import: rebuild graph for created notes (or vault graph reload on client).
8. UI: clear English progress/result; ConfirmModal if overwrite destructive.

## Output Contract

- API + UI entry point on vault page.
- Summary counts returned to the client.
