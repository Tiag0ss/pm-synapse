export type NoteTemplateId =
  | 'blank'
  | 'meeting'
  | 'risk'
  | 'decision'
  | 'plan'
  | 'feature';

export interface NoteTemplate {
  id: NoteTemplateId;
  label: string;
  description: string;
  /** Body with `{{title}}` replaced by the note leaf name. */
  body: (leafTitle: string) => string;
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    description: 'Heading only',
    body: (leaf) => `# ${leaf}\n\n`,
  },
  {
    id: 'meeting',
    label: 'Meeting',
    description: 'Agenda, notes, actions with hours',
    body: (leaf) => `# ${leaf}

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
    id: 'risk',
    label: 'Risk',
    description: 'Impact, likelihood, mitigation',
    body: (leaf) => `# ${leaf}

## Summary

## Impact

## Likelihood

## Mitigation

- [ ] Document mitigation steps (2h)
- [ ] Review with owner
`,
  },
  {
    id: 'decision',
    label: 'Decision',
    description: 'Context, options, outcome',
    body: (leaf) => `# ${leaf}

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
    id: 'plan',
    label: 'Plan',
    description: 'YAML todos + checkbox breakdown for Planner',
    body: (leaf) => `---
title: ${leaf}
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

# ${leaf}

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
    id: 'feature',
    label: 'Feature',
    description: 'Spec with YAML todos and nested checkboxes',
    body: (leaf) => `---
title: ${leaf}
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

# ${leaf}

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

export function templateBody(id: NoteTemplateId | string | undefined, leafTitle: string): string {
  const t = NOTE_TEMPLATES.find((x) => x.id === id) || NOTE_TEMPLATES[0];
  return t.body(leafTitle);
}
