/**
 * Built-in note templates for DB seed (keep in sync with lib/noteTemplates.ts SYSTEM_NOTE_TEMPLATE_SEEDS).
 */
export type SystemNoteTemplateSeed = {
  slug: string;
  label: string;
  description: string;
  bodyTemplate: string;
  sortOrder: number;
};

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
