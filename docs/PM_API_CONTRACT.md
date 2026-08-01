# Project Management API contract (for PM Synapse)

This document is the **portable contract** Synapse depends on. When Synapse is split into its own repository, keep this file (and `server/services/pmClient.ts`) updated — do **not** rely on browsing the PM codebase.

Base URL: `PM_BASE_URL` (e.g. `http://localhost:3000`).  
Auth for API calls: `Authorization: Bearer <token>` where `<token>` is either:

1. **SSO access token** from the SSO token exchange (stored encrypted per Synapse user), or  
2. **Personal API token** (`pt_…`) — Synapse may use an **instance-wide** key from admin Settings (or `PM_API_KEY` env) when the signed-in user has no valid SSO token.

PM’s `authenticateToken` middleware accepts both JWT and `pt_` tokens on the same routes.

Local Synapse accounts and PM SSO accounts are linked by **email** (case-insensitive) when both login methods are used.

Unless noted, JSON responses use:

```json
{ "success": true, "data": … }
{ "success": false, "message": "…" }
```

Some list endpoints also return top-level arrays or `{ organizations }`, `{ statuses }`, `{ tasks }` — Synapse normalizes these in `pmClient.ts` / route handlers.

---

## SSO

### Browser authorize

`GET {PM_BASE_URL}/sso/authorize`

Query:

| Param | Required | Notes |
|-------|----------|-------|
| `client_id` | yes | `SSO_CLIENT_ID` (default `pm-synapse`) |
| `redirect_uri` | yes | Must be listed in PM `ALLOWED_SSO_REDIRECTS` |
| `state` | recommended | CSRF |

User logs into PM; PM redirects to `redirect_uri?code=…&state=…`.

### Token exchange

`POST {PM_BASE_URL}/api/sso/token`

Body:

```json
{
  "code": "<auth code>",
  "client_id": "pm-synapse",
  "client_secret": "<SSO_CLIENT_SECRET>",
  "redirect_uri": "<same as authorize>"
}
```

Success `data`:

```json
{
  "accessToken": "<jwt>",
  "expiresIn": 28800,
  "user": { "id": 1, "username": "…", "email": "…" }
}
```

Synapse stores `accessToken` encrypted per Synapse user (`SsoTokens.UserId`) and uses it as Bearer for subsequent PM calls when present. Otherwise Synapse falls back to the instance API key (`pt_…`).

SSO login resolves the Synapse user by linked `PmUserId`, then by **email**, then creates a new user.

---

## Organizations

`GET /api/organizations`

Auth: Bearer.

Synapse expects a list of `{ Id, Name }` (also accepts `id`/`name`, nested under `organizations` or `data`).

---

## Status / priority catalogs

Used when creating projects/tasks and mapping checkbox checked → closed status.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status-values/project/{organizationId}` | Project statuses (`Id`, `IsDefault`, …) |
| GET | `/api/status-values/task/{organizationId}` | Task statuses (`Id`, `IsDefault`, `IsClosed`, `IsCancelled`) |
| GET | `/api/status-values/priority/{organizationId}` | Priorities (`Id`, `IsDefault`) |

Response shapes: `{ statuses: […] }` or `{ priorities: […] }` or raw arrays.

**Done rule (Synapse):** `StatusIsClosed === 1` **or** `StatusIsCancelled === 1` ⇒ checkbox checked.

---

## Projects

### Create

`POST /api/projects`

```json
{
  "organizationId": 1,
  "projectName": "Vault name",
  "description": "optional",
  "status": 1
}
```

Success: Synapse reads `projectId` or `id` or `data.Id`.

### Open in UI

`{PM_BASE_URL}/projects/{projectId}`

---

## Tasks

### List by project

`GET /api/tasks/project/{projectId}`

Success: `{ success: true, tasks: Task[] }`.

Task fields Synapse uses:

| Field | Use |
|-------|-----|
| `Id` | Link / deep-link |
| `StatusIsClosed` | Pull sync → checkbox |
| `StatusIsCancelled` | Pull sync → checkbox |
| `Status` | (optional) |

### Create

`POST /api/tasks`

Required:

```json
{
  "projectId": 1,
  "taskName": "Checkbox text",
  "status": 1,
  "priority": 1
}
```

Optional Synapse link fields (stored on PM `Tasks` table; UI shows “Open in Synapse” only if `SynapseNoteUrl` set):

```json
{
  "description": "<p>From Synapse…</p>",
  "synapseVaultId": 1,
  "synapseNoteId": 2,
  "synapseMarkerId": "c…",
  "synapseNoteUrl": "http://localhost:3010/vaults/1?note=2"
}
```

Success: `taskId` or `id` or `data.Id`.

### Update

`PUT /api/tasks/{taskId}`

Partial body. Synapse typically sends:

```json
{ "status": 3 }
```

And optionally backfills (PM uses `COALESCE` so nulls do not clear):

```json
{
  "synapseVaultId": 1,
  "synapseNoteId": 2,
  "synapseMarkerId": "c…",
  "synapseNoteUrl": "http://localhost:3010/vaults/1?note=2"
}
```

### Deep link into PM UI

```
{PM_BASE_URL}/projects/{projectId}?tab=tasks&taskId={taskId}
```

PM opens the tasks tab and the task detail modal.

---

## Synapse deep links (for PM UI)

| URL | Behaviour |
|-----|-----------|
| `{SYNAPSE}/vaults/{vaultId}?note={noteId}` | Open vault and load note |

---

## Compatibility expectations

1. **Breaking changes** to paths, auth, or required create fields must be coordinated and reflected here first.
2. Synapse should tolerate alternate list nesting (`data` / top-level arrays) but prefer documented shapes.
3. PM must **not** require Synapse-specific code for normal task/project usage; Synapse fields on tasks are optional.
4. When Synapse needs a new PM capability, add a section here, implement in `pmClient.ts`, then call from routes.

## Last verified against

- Synapse client: `server/services/pmClient.ts`
- Typical PM stack: Express JWT cookie/Bearer, Zod validation, Tasks JSON schema fields `SynapseVaultId`, `SynapseNoteId`, `SynapseMarkerId`, `SynapseNoteUrl`
