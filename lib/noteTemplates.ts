export type NoteTemplateSlug =
  | 'blank'
  | 'meeting'
  | 'risk'
  | 'decision'
  | 'plan'
  | 'feature';

/** @deprecated use NoteTemplateSlug — kept for older call sites */
export type NoteTemplateId = NoteTemplateSlug;

export type SystemNoteTemplateSeed = {
  slug: NoteTemplateSlug;
  label: string;
  description: string;
  /** Body with literal `{{title}}` placeholder */
  bodyTemplate: string;
  sortOrder: number;
};

export function applyNoteTemplateBody(bodyTemplate: string, leafTitle: string): string {
  return String(bodyTemplate || '').split('{{title}}').join(leafTitle);
}

/** Built-in templates seeded into NoteTemplates on startup (INSERT IGNORE by Slug). */
export const SYSTEM_NOTE_TEMPLATE_SEEDS: SystemNoteTemplateSeed[] = [
  {
    slug: 'blank',
    label: 'Blank',
    description: 'Heading only',
    sortOrder: 0,
    bodyTemplate: `# {{title}}

`,
  },
  {
    slug: 'meeting',
    label: 'Meeting',
    description: 'Agenda, notes, actions with hours',
    sortOrder: 10,
    bodyTemplate: `# {{title}}

## Agenda

- 

## Notes

- 

## Action items

- [ ] Follow up with stakeholders (1h)
- [ ] Draft summary
`,
  },
  {
    slug: 'risk',
    label: 'Risk',
    description: 'Impact, likelihood, mitigation',
    sortOrder: 20,
    bodyTemplate: `# {{title}}

## Summary

## Impact

## Likelihood

## Mitigation

- [ ] Document mitigation steps (2h)
- [ ] Review with owner
`,
  },
  {
    slug: 'decision',
    label: 'Decision',
    description: 'Context, options, outcome',
    sortOrder: 30,
    bodyTemplate: `# {{title}}

## Context

## Options

1. 
2. 

## Decision

## Follow-ups

- [ ] Communicate decision (0.5h)
- [ ] Update related notes
`,
  },
  {
    slug: 'plan',
    label: 'Plan',
    description: 'YAML todos + checkbox breakdown for Planner',
    sortOrder: 40,
    bodyTemplate: `---
title: {{title}}
tags: [plan]
todos:
  - id: discovery
    content: Discovery and scope
    status: pending
    hours: 2
    note: meta/risks
  - id: implementation
    content: Implementation
    status: pending
    hours: 8
  - id: buffer
    content: Unplanned follow-ups
    status: pending
    unscheduled: true
---

# {{title}}

## Goal

## Breakdown

- [ ] Spike approach (2h)
- [ ] Implement core path (4h)
- [ ] Polish and docs (2h)
- [ ] Parking lot ideas (unscheduled)

## Notes

`,
  },
  {
    slug: 'feature',
    label: 'Feature',
    description: 'Spec with YAML todos and nested checkboxes',
    sortOrder: 50,
    bodyTemplate: `---
title: {{title}}
tags: [feature]
todos:
  - id: design
    content: Design and acceptance criteria
    status: pending
    hours: 3
    note: meta/risks
  - id: build
    content: Build and wire up
    status: pending
    hours: 6
  - id: verify
    content: Verify and ship
    status: pending
    hours: 2
---

# {{title}}

## Problem

## Proposal

## Acceptance criteria

- [ ] Happy path works
- [ ] Edge cases covered
- [ ] Help / docs updated (1h)

## Implementation

- [ ] Backend
  - [ ] API / data (3h)
  - [ ] Validation
- [ ] Frontend
  - [ ] UI (3h)
  - [ ] Empty and error states
- [ ] Stretch ideas (unscheduled)

## Open questions

- 
`,
  },
];

export interface NoteTemplate {
  id: NoteTemplateSlug;
  label: string;
  description: string;
  body: (leafTitle: string) => string;
}

/** Client-side convenience list (mirrors seeds). Prefer DB catalog when available. */
export const NOTE_TEMPLATES: NoteTemplate[] = SYSTEM_NOTE_TEMPLATE_SEEDS.map((s) => ({
  id: s.slug,
  label: s.label,
  description: s.description,
  body: (leaf) => applyNoteTemplateBody(s.bodyTemplate, leaf),
}));

export function templateBody(id: NoteTemplateId | string | undefined, leafTitle: string): string {
  const t = NOTE_TEMPLATES.find((x) => x.id === id) || NOTE_TEMPLATES[0];
  return t.body(leafTitle);
}
