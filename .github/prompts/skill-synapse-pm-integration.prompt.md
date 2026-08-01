# Skill: Synapse ↔ Project Management integration

## Goal
Change SSO, PM client calls, checkbox push, or status pull-sync.

## Task Input

```text
Integration change:
PM endpoints involved:
Direction (Synapse→PM / Synapse←PM pull):
```

## Execution Rules

1. Read `docs/PM_API_CONTRACT.md` first — it is the source of truth after a repo split.
2. Implement HTTP only through `server/services/pmClient.ts` (or extend it).
3. PM stays agnostic: no new PM→Synapse webhooks unless product explicitly requires and contract is updated.
4. Push tasks only on explicit user action; never on note save alone.
5. Pull closed/cancelled status into checkboxes when loading note/vault checkbox lists.
6. Deep links: PM `?tab=tasks&taskId=`; Synapse `?note=`.
7. On create task, set Synapse* fields + `synapseNoteUrl`.
8. Handle SSO expiry with clear re-auth messaging.

## Output Contract

- Code + contract doc updates together when the HTTP surface changes.
- Brief test notes (push, toggle, pull after PM status change).
