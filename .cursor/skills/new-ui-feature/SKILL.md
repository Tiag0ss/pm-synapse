---
name: new-ui-feature
description: >-
  Implement a Next.js UI feature with correct folder placement, small reusable
  components, loading/empty/error states, basic a11y, and browser verification.
  Use when adding or changing a page or React UI feature in Next.js App Router.
---

# New UI feature

1. **Structure first**: open `web-next-structure.mdc`. Place files in `app/<feature>/`, `_components/`, `components/`, `lib/api/`. Do not invent parallel trees.
2. **Split first**: page/route stays thin; extract reusable and feature components before writing a giant file.
3. Cover **loading**, **empty**, and **error** states for async data (`loading.tsx` / `error.tsx` when useful).
4. Accessibility basics: labels, keyboard-usable controls, meaningful buttons/links.
5. Do **not** use `alert()` / `confirm()` — use the project’s modal/dialog pattern if one exists.
6. Prefer existing layout/spacing/color patterns. No new design system.
7. Soft ~150-line limit per `.tsx` — split if larger.
8. Verify in the browser when tools allow. Tests only for non-trivial logic if a runner exists.
