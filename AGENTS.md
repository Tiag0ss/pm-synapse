# Agent context — PM Synapse

Cursor agents: read **`.cursor/rules/pm-synapse.mdc`** (always on) plus scoped rules when editing matching areas.

## Language (mandatory)

- **Assistant responses: English (EN) only.**
- User messages may be in European Portuguese (PT). Understand PT; do not answer in PT or PT-BR unless explicitly requested.
- Non-English UI strings require user approval.

## Documentation map

| Need | Read |
|------|------|
| Stack & non-negotiables | [`.cursor/rules/pm-synapse.mdc`](.cursor/rules/pm-synapse.mdc) |
| Project Management API contracts (survive repo split) | [`docs/PM_API_CONTRACT.md`](docs/PM_API_CONTRACT.md) |
| Feature overview | [`README.md`](README.md) |
| Prompt skills | [`.github/prompts/`](.github/prompts/) |

## Cursor rules (`.cursor/rules/`)

| File | When |
|------|------|
| `pm-synapse.mdc` | **Always** |
| `synapse-backend.mdc` | `server/**` |
| `synapse-frontend.mdc` | `app/**`, `components/**`, `lib/**` |
| `synapse-pm-integration.mdc` | `server/services/pmClient.ts`, checkbox sync, SSO |

## Prompt skills (`.github/prompts/`)

Open the matching skill **before** implementing:

- `skill-synapse-backend-route.prompt.md` — Express routes
- `skill-synapse-note-features.prompt.md` — editor, wikilinks, folders, media
- `skill-synapse-pm-integration.prompt.md` — SSO, push tasks, status sync
- `skill-synapse-vault-import.prompt.md` — ZIP / bulk note import

## Stack (short)

Next.js 16 · React 19 · Tailwind 4 · Express 5 · TypeScript · MySQL · Zod · optional PM SSO

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Non‑negotiables (summary)

- Synapse owns note/vault UX; **PM stays agnostic** (no Synapse callbacks from PM).
- Status reconciliation: **Synapse pulls** from PM; checkbox toggle **pushes** status to PM.
- Parameterized SQL via `pool`; `logger` not `console` on server.
- Notes paths support folders (`meta/risks` → `meta/risks.md`).
- Minimal diffs; English only; commit when user asks.
