# PM Synapse

Markdown vaults companion to [Project Management](https://github.com/tiag0ss/project-management). Notes live in MySQL; creating notes never creates PM work — push project/task is always an explicit manual action.

This project is a work in progress — bugs may still be found; please report them on GitHub.

## Features

- 📔 **Markdown vaults** — Folder paths (`meta/risks`), note tree (folders first), vault switcher
- ✍️ **Editor** — Split/edit/preview, toolbar, paste/drop images + lightbox; **autosave** + unsaved warnings; Ctrl/Cmd+S
- 🔎 **Search** — Filter by title/path/body; **Jump to note** palette (Ctrl/Cmd+O)
- 🔗 **Wikilinks & graph** — `[[links]]` (path + unique leaf), tags, backlinks, focused + full mindmap
- 🕘 **Revisions** — History with side-by-side restore
- 📦 **ZIP import / export** — Nested folders ↔ note paths; images included
- 📋 **Templates** — Blank, meeting, risk, decision when creating notes
- 🗑️ **Trash** — Soft-delete notes with restore; leave shared vaults / delete owned vaults
- ✅ **Checkbox → PM tasks** — Manual create (single or bulk with progress); Synapse pulls PM closed/cancelled status
- 👁️ **Visibility** — Vault wiki audience (private / authenticated / unlisted / public) + per-note overrides on `/w/:slug`
- 🌐 **Wiki directory** — `/w` lists wikis you may open (not unlisted); private wikis only if shared with you
- 👥 **Vault sharing** — **Read** = wiki only; **Edit** = vault editor + wiki; invite by search or PM user id
- 🔐 **Auth** — Local username/password and optional PM SSO (linked by email); password reset via SMTP
- ⚙️ **Admin settings** — Registration toggle, SMTP, PM integration switch, user management
- 🤖 **AI todo suggestions** — Optional external [Ollama](https://ollama.com/) (Admin → AI); analyzes a note and proposes YAML `todos:` — review/merge before save; never auto-applies
- 🔌 **PM bridge** — Per-user SSO token or personal `pt_…` API key (Profile); manual vault→project link; Synapse refs on PM tasks

## Tech Stack

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS |
| Backend | Node.js, Express 5, TypeScript (custom server) |
| Database | MySQL 8+ |
| Auth | Local password + optional PM SSO; JWT session cookie |
| Markdown | `marked` + Synapse extras (wikilinks, tags, checkboxes, Mermaid, KaTeX, highlight, callouts, footnotes, TOC) |

## Local Development

1. Create MySQL database **and user**:

```bash
mysql -u root -p < server/database/scripts/bootstrap.sql
```

That creates DB `pm_synapse` and user `synapse` / password `change-me-synapse-db-password` (edit the SQL first if you want another password).

Or run manually:

```sql
CREATE DATABASE IF NOT EXISTS pm_synapse CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'synapse'@'localhost' IDENTIFIED BY 'your-password';
GRANT ALL PRIVILEGES ON pm_synapse.* TO 'synapse'@'localhost';
FLUSH PRIVILEGES;
```

2. Copy env:

```bash
cp .env.example .env
```

```env
PORT=3010
JWT_SECRET=change-me-synapse-jwt-secret
DB_HOST=localhost
DB_PORT=3306
DB_USER=synapse
DB_PASSWORD=change-me-synapse-db-password
DB_NAME=pm_synapse
PM_BASE_URL=http://localhost:3000
SSO_CLIENT_ID=pm-synapse
SSO_CLIENT_SECRET=change-me-synapse-sso-secret
NEXT_PUBLIC_APP_URL=http://localhost:3010
```

3. On **Project Management** (only if using SSO), set:

```env
ALLOWED_SSO_REDIRECTS=http://localhost:3010/api/auth/sso/callback
SSO_CLIENT_ID=pm-synapse
SSO_CLIENT_SECRET=change-me-synapse-sso-secret
```

4. Install and run (from this folder):

```bash
pnpm install --ignore-workspace
pnpm run dev
```

Open [http://localhost:3010](http://localhost:3010) — register a local account (first user becomes admin) and/or sign in with Project Management. Admins manage registration, SMTP, and users under **Settings**. Each user manages their personal PM API token under **Profile**. Local and SSO accounts with the same email are linked.

**Note:** TypeScript must stay on 5.x (`typescript@5.9.3`) — Next.js 16 does not support TypeScript 7.

## Docker

Build and push (same pattern as Project Management):

```bash
cp .env.docker.example .env.docker
# edit secrets + PM_BASE_URL / SSO / NEXT_PUBLIC_APP_URL

sg docker -c "./docker-build.sh"          # or: ./docker-build.sh 0.1.0
DOCKER_USERNAME=youruser docker compose up -d
curl -s http://localhost:3010/health
```

See [DEPLOYMENT.md](./DEPLOYMENT.md) for compose ports, volumes, and SSO checklist.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3010` | Synapse HTTP port |
| `JWT_SECRET` | **Yes** | — | Session JWT secret |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | **Yes** | — | MySQL connection |
| `DB_PROVIDER` | No | `mysql` | Database provider |
| `PM_BASE_URL` | **Yes** | — | Project Management base URL |
| `SSO_CLIENT_ID` | **Yes** | `pm-synapse` | Must match PM SSO client |
| `SSO_CLIENT_SECRET` | **Yes** | — | Must match PM `SSO_CLIENT_SECRET` |
| `ENCRYPTION_KEY` | No | — | Token encryption (falls back to `JWT_SECRET`) |
| `NEXT_PUBLIC_APP_URL` | **Yes** | — | Public Synapse URL (SSO redirect) |
| `NEXT_PUBLIC_PM_BASE_URL` | No | — | Optional PM link base in the UI |

## Ports

| Port | Description |
|------|-------------|
| `3010` | Synapse (frontend + API) |
| `3000` | Project Management (SSO issuer) |
| `3306` | MySQL |

## Architecture

```
+---------------------------+          +----------------------------+
|  pm-synapse               |  SSO +   |  project-management        |
|  Next.js + Express :3010 |  REST →  |  Next.js + Express :3000   |
|  MySQL: pm_synapse        |          |  MySQL/MSSQL               |
+---------------------------+          +----------------------------+
```

Notes and vault ACLs live only in Synapse. Task/project create goes through PM’s authenticated APIs with the user’s SSO token.

### Wiki visibility

| Vault default visibility | Open `/w/:slug` | Listed on `/w` |
|--------------------------|-----------------|----------------|
| **private** | Share Read / Edit / Owner only | Only for those with access |
| **authenticated** | Any signed-in Synapse user | Yes (when signed in) |
| **unlisted** | Anyone with the link | No |
| **public** | Everyone | Yes |

Share **Read** = wiki only (no vault editor). Share **Edit** / owner = vault app + wiki. Per-note visibility filters content inside an accessible wiki; **private** notes are visible on the wiki only to Edit/Owner (not Share Read).

## Agent docs

- [AGENTS.md](./AGENTS.md) — Cursor / agent entry
- [docs/PM_API_CONTRACT.md](./docs/PM_API_CONTRACT.md) — PM HTTP contracts Synapse depends on
- `.cursor/rules/` + `.github/prompts/` — conventions and task skills

This folder can be moved to its own git repository (`pm-synapse`) when ready. Keep `docs/PM_API_CONTRACT.md` in sync whenever Synapse’s PM client changes.

## Related

- [Project Management](https://github.com/tiag0ss/project-management) — parent app (SSO + task APIs)
