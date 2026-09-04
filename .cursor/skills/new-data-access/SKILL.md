---
name: new-data-access
description: >-
  Add or change persistence (repository, query, migration) using the project's
  existing ORM or SQL stack. Use when touching Prisma, Drizzle, EF, SQLAlchemy,
  or raw SQL data access.
---

# New data access

1. Identify the existing data stack (Prisma schema, Drizzle tables, EF `DbContext`, SQLAlchemy models, or `repositories/`).
2. Put new queries in the data layer — not in HTTP/UI files.
3. For schema changes: add a migration the way the project already does; do not invent a parallel migration system.
4. Parameterize all user-derived values.
5. Add or update tests when a runner exists and the query encodes important business rules.
6. Do not log full row payloads that may contain PII/secrets.
