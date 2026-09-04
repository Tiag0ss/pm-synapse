---
name: new-api-route
description: >-
  Add or change an Express API route with correct layering (routes/services/
  repositories), authn/authz, validation, status codes, and tests when a runner
  exists. Use when implementing server routes or REST endpoints under server/.
---

# New API route

1. Open `node-express-structure.mdc`. Add HTTP in `server/routes/`, logic in `services/`, SQL in `repositories/` or `queries/` — **not** all in the route file.
2. **Authn + authz** for protected mutations (and reads that need them).
3. **Schema/validation** at the boundary — use the project’s existing approach.
4. Cover **happy path** plus **401 / 403 / 400** where applicable.
5. Parameterized DB access; safe client errors; logger for internals.
6. If the repo already has a test runner, add or update a test for the route.
7. Match the project’s existing JSON response shape. Minimal diff; no new frameworks unasked.
