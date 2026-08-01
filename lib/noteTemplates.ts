export type NoteTemplateId = 'blank' | 'meeting' | 'risk' | 'decision';

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
    description: 'Agenda, notes, actions',
    body: (leaf) => `# ${leaf}

## Agenda

- 

## Notes

- 

## Action items

- [ ] 
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

- [ ] 
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

- [ ] 
`,
  },
];

export function templateBody(id: NoteTemplateId | string | undefined, leafTitle: string): string {
  const t = NOTE_TEMPLATES.find((x) => x.id === id) || NOTE_TEMPLATES[0];
  return t.body(leafTitle);
}
