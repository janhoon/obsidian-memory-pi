---
type: rule
scope: global
relevance: high
last_reviewed: 2026-04-15
---
# Memory triggers

## Loading triggers

Load project memory when the conversation includes:

- continue / catch up / last session
- what did we decide
- why did we do this
- project status
- architecture or system pattern questions

## Writing triggers

Consider filing updates when the conversation establishes:

- a durable decision and its rationale
- a stable preference or rule
- a new glossary term or alias
- a meaningful project status change
- a research insight worth preserving
- explicit memory language like `remember this`, `save this`, or `make a note`

## Continuity triggers

- before compaction, flush a concise session summary into `memory/sessions/<project>/YYYY-MM-DD.md`
- default explicit memory captures to reviewable proposals instead of immediate writes
