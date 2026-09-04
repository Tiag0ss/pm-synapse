---
name: new-route-handler
description: >-
  Add or change a Next.js App Router route handler or Server Action with
  validation, authz, and correct caching/revalidation. Use when implementing
  app/api handlers, route.ts, or server mutations in Next.js.
---

# New Route Handler / Server Action

1. Open `web-next-structure.mdc`. Place `route.ts` under `app/api/...` only if the project already uses Route Handlers for that concern.
2. Prefer Server Actions for UI mutations when that is the project pattern; use `route.ts` for external/HTTP APIs.
3. Validate input; authorize on the server. Never trust client-only checks.
4. Return safe error messages; log details server-side.
5. Revalidate or update cache only for affected paths/tags — match existing `revalidatePath` / `revalidateTag` usage.
6. Keep handlers thin; put shared logic in `lib/`. Add tests when a runner exists.
